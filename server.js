const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const DATA_FILE = "./data.json";
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

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
  const idx = data.findIndex(a => a.name === appInfo.name);
  if (idx !== -1) data[idx] = { ...data[idx], ...appInfo };
  else data.push(appInfo);
  writeData(data);
}

function deleteLocalApp(name) {
  const data = readData();
  writeData(data.filter(b => b.name !== name));
}

function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// -------------------- DEPLOY WITH AUTO DYNO DETECTION --------------------
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

  const log = msg => res.write(`data: ${msg}\n\n`);

  try {
    // 🏗️ Step 1: Create Heroku app
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
    log(`✅ App created: ${sanitizedAppName}`);

    // ⚙️ Step 2: Set config vars
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
    log(`✅ SESSION_ID configured.`);

    // 🔗 Step 3: Tarball URL
    let tarballUrl;
    if (repo.includes("github.com")) {
      tarballUrl = repo
        .replace("https://github.com/", "https://codeload.github.com/")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
        + "/tar.gz/main";
    } else {
      tarballUrl = `https://codeload.github.com/${repo}/tar.gz/main`;
    }

    log(`📦 Using tarball: ${tarballUrl}`);

    // 🧠 Step 4: Check Procfile content for dyno type
    let dynoType = "web";
    try {
      const procfileUrl = repo
        .replace("https://github.com/", "https://raw.githubusercontent.com/")
        .replace(/\.git$/, "")
        .replace(/\/$/, "") + "/main/Procfile";

      const procfileData = await new Promise((resolve, reject) => {
        https
          .get(procfileUrl, resp => {
            let data = "";
            resp.on("data", chunk => (data += chunk));
            resp.on("end", () => resolve(data));
          })
          .on("error", reject);
      });

      if (procfileData.includes("worker:")) dynoType = "worker";
      else if (procfileData.includes("web:")) dynoType = "web";
      log(`🧩 Detected dyno type: ${dynoType}`);
    } catch {
      log(`⚠️ Could not read Procfile. Defaulting to "web".`);
    }

    // 🛠 Step 5: Trigger Heroku build
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
    log("🏗️ Build started...");

    // 🔁 Step 6: Poll build status
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
        log(`📊 Build: ${status}`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            log("✅ Build succeeded! Activating dyno...");

            await axios.patch(
              `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
              { updates: [{ type: dynoType, quantity: 1 }] },
              {
                headers: {
                  Authorization: `Bearer ${HEROKU_API_KEY}`,
                  Accept: "application/vnd.heroku+json; version=3",
                },
              }
            );

            log(`⚙️ ${dynoType.toUpperCase()} dyno activated successfully!`);
            saveApp({
              name: sanitizedAppName,
              repo,
              sessionId,
              dynoType,
              url: `https://${sanitizedAppName}.herokuapp.com`,
              date: new Date().toISOString(),
            });
          } else {
            log("❌ Build failed.");
          }

          res.end();
        }
      } catch (err) {
        log(`⚠️ Error checking build: ${err.message}`);
        clearInterval(poll);
        res.end();
      }
    }, 4000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    log("❌ Deployment failed.");
    res.end();
  }
});

// -------------------- MANAGE APPS --------------------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });

    const bots = response.data
      .filter(app =>
        ["trashcore-", "bot-", "drexter-"].some(prefix =>
          app.name.startsWith(prefix)
        )
      )
      .map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at,
      }));

    res.json({ success: true, count: bots.length, bots });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to fetch bots" });
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
    res.json({ success: true, message: `🗑 App "${appName}" deleted.` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to delete app" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
