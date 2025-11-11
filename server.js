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
  try { return JSON.parse(fs.readFileSync(DATA_FILE)); } 
  catch { return []; }
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

// -------------------- SANITIZE APP NAME --------------------
function sanitizeAppName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-");
}

// -------------------- DEPLOY BOT WITH LIVE LOGS --------------------
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
  const { repo, sessionId } = req.query;
  const sanitizedAppName = sanitizeAppName(appName);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();

  try {
    // 1️⃣ Create Heroku app
    const appResp = await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ App created: ${sanitizedAppName}\n\n`);

    // 2️⃣ Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    // 3️⃣ Get source blob
    const sourceResp = await axios.post(
      "https://api.heroku.com/sources",
      {},
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    const { put_url, get_url } = sourceResp.data.source_blob;
    res.write(`data: 📦 Source blob ready.\n\n`);

    // 4️⃣ Download GitHub tarball
    const tarball = await axios.get(repo, { responseType: "arraybuffer" });

    // 5️⃣ Upload tarball to Heroku
    await axios.put(put_url, tarball.data, {
      headers: { "Content-Type": "application/octet-stream" } // Important fix
    });
    res.write(`data: 📤 Tarball uploaded.\n\n`);

    // 6️⃣ Trigger build
    const buildResp = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: get_url, version: "main" } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildResp.data.id;

    // 7️⃣ Poll build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`data: Build status: ${status}\n\n`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            // 8️⃣ Activate worker dyno only
            await axios.patch(
              `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
              { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1 }] },
              { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
            );
            res.write(`data: ⚙️ Worker dyno activated. Web dyno disabled.\n\n`);

            // 9️⃣ Save app info locally
            saveApp({
              name: sanitizedAppName,
              repo,
              sessionId,
              url: `https://${sanitizedAppName}.herokuapp.com`,
              date: new Date().toISOString()
            });
          }

          res.write(`data: ✅ Deployment ${status}!\n\n`);
          res.end();
        }
      } catch (err) {
        console.error(err.response?.data || err.message);
        res.write(`data: ⚠️ Error fetching build logs.\n\n`);
        clearInterval(poll);
        res.end();
      }
    }, 3000);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ❌ Deployment failed.\n\n`);
    res.end();
  }
});

// -------------------- LIST BOTS --------------------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3"
      }
    });

    const bots = response.data
      .filter(app =>
        app.name.startsWith("trashcore-") ||
        app.name.startsWith("bot-") ||
        app.name.startsWith("drexter-")
      )
      .map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at
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
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });
    res.json({ success: true, message: `✅ Dynos restarted for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to restart dynos" });
  }
});

app.post("/activate/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/formation`,
      { updates: [{ type: "web", quantity: 1 }] },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ success: true, message: `✅ Dynos activated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to activate dynos" });
  }
});

app.post("/update-session/:appName", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "Session ID required" });

  try {
    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const data = readData();
    const idx = data.findIndex(b => b.name === appName);
    if (idx !== -1) {
      data[idx].sessionId = sessionId;
      writeData(data);
    }

    res.json({ success: true, message: `✅ Session ID updated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to update session ID" });
  }
});

app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });
    deleteLocalApp(appName);
    res.json({ success: true, message: `🗑 App "${appName}" deleted successfully.` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to delete app" });
  }
});

// Get Heroku logs URL (for front-end)
app.get("/logs/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    const logRes = await axios.post(`https://api.heroku.com/apps/${appName}/log-sessions`,
      { tail: true },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ url: logRes.data.logplex_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: "❌ Failed to get logs" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
