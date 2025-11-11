const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const DATA_FILE = "./data.json";

// Ensure data.json exists
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

// -------------------- DATA.JSON HELPERS --------------------
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE));
  } catch {
    return [];
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function saveApp(appInfo) {
  const data = readData();
  const idx = data.findIndex((a) => a.name === appInfo.name);
  if (idx !== -1) data[idx] = { ...data[idx], ...appInfo };
  else data.push(appInfo);
  writeData(data);
}

function deleteLocalApp(name) {
  const data = readData();
  writeData(data.filter((b) => b.name !== name));
}

// -------------------- SANITIZE APP NAME --------------------
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// -------------------- DEPLOY BOT WITH CLEAN LOGS --------------------
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
  const { repo, sessionId } = req.query;
  const sanitizedAppName = sanitizeAppName(appName);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const sendLog = (msg) => res.write(`data: ${msg}\n\n`);

  try {
    // 1️⃣ Create Heroku app
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3",
        },
      }
    );
    sendLog(`✅ App created: ${sanitizedAppName}`);

    // 2️⃣ Configure SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3",
        },
      }
    );
    sendLog(`✅ SESSION_ID configured.`);

    // 3️⃣ Prepare codeload tarball URL
    let tarballUrl;
    if (repo.startsWith("https://")) {
      tarballUrl = repo
        .replace("github.com", "codeload.github.com")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
        + "/tar.gz/main";
    } else {
      tarballUrl = `https://codeload.github.com/${repo}/tar.gz/main`;
    }

    sendLog(`📦 Using tarball: ${tarballUrl}`);

    try {
      await axios.head(tarballUrl);
      sendLog("✅ Source tarball verified.");
    } catch {
      sendLog(`❌ Tarball URL failed: ${tarballUrl}`);
      res.end();
      return;
    }

    // 4️⃣ Start Heroku build
    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: tarballUrl } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3",
        },
      }
    );

    const buildId = buildRes.data.id;
    sendLog("🏗️ Build: pending");

    // 5️⃣ Poll for build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept: "application/vnd.heroku+json; version=3",
            },
          }
        );

        const status = statusRes.data.status;
        sendLog(`Build: ${status}`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            // Enable worker dyno
            try {
              await axios.patch(
                `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
                { updates: [{ type: "worker", quantity: 1 }] },
                {
                  headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: "application/vnd.heroku+json; version=3",
                  },
                }
              );
              sendLog("⚙️ Worker dyno activated.");
            } catch {
              sendLog("⚠️ Could not activate worker dyno.");
            }

            saveApp({
              name: sanitizedAppName,
              repo,
              sessionId,
              url: `https://${sanitizedAppName}.herokuapp.com`,
              date: new Date().toISOString(),
            });
            sendLog("✅ Deployment succeeded!");
          } else {
            sendLog("❌ Deployment failed.");
          }
          res.end();
        }
      } catch (err) {
        console.error(err.response?.data || err.message);
        sendLog("⚠️ Error fetching build status.");
        clearInterval(poll);
        res.end();
      }
    }, 4000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    sendLog("❌ Deployment failed.");
    res.end();
  }
});

// -------------------- LIST BOTS --------------------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });

    const bots = response.data
      .filter(
        (app) =>
          app.name.startsWith("trashcore-") ||
          app.name.startsWith("bot-") ||
          app.name.startsWith("drexter-") ||
          app.name.startsWith("trash-")
      )
      .map((app) => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at,
      }));

    res.json({ success: true, count: bots.length, bots });
  } catch (err) {
    console.error("Error fetching Heroku apps:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to fetch bots" });
  }
});

// -------------------- DYNOS & APP MANAGEMENT --------------------
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });
    res.json({ success: true, message: `✅ Dynos restarted for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to restart dynos" });
  }
});

app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });
    deleteLocalApp(appName);
    res.json({ success: true, message: `🗑 App "${appName}" deleted successfully.` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to delete app" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
