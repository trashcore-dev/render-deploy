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

// -------------------- DATA HELPERS --------------------
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE)); } catch { return []; }
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
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-");
}

// -------------------- DEPLOY WITH LOGS --------------------
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
    // Create Heroku app
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ App created: ${sanitizedAppName}\n\n`);

    // Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    // Prepare repo tarball URL
    let tarballUrl = repo.includes("https://") ? `${repo}/tarball/main` : `https://github.com/${repo}/tarball/main`;

    // Verify tarball
    try {
      await axios.head(tarballUrl);
      res.write(`data: 📦 Source blob ready.\n\n`);
    } catch {
      res.write(`data: ❌ Invalid or private tarball URL: ${tarballUrl}\n\n`);
      res.end();
      return;
    }

    // Start build
    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: tarballUrl } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildRes.data.id;
    res.write(`data: 🏗️ Build: pending\n\n`);

    // Poll build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`data: Build: ${status}\n\n`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);
          if (status === "succeeded") {
            res.write(`data: ✅ Deployment succeeded!\n\n`);
            saveApp({
              name: sanitizedAppName,
              repo,
              sessionId,
              url: `https://${sanitizedAppName}.herokuapp.com`,
              date: new Date().toISOString()
            });
          } else {
            res.write(`data: ❌ Deployment failed.\n\n`);
          }
          res.end();
        }
      } catch (err) {
        console.error(err.response?.data || err.message);
        res.write(`data: ⚠️ Error checking build status.\n\n`);
        clearInterval(poll);
        res.end();
      }
    }, 4000);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ❌ Deployment failed.\n\n`);
    res.end();
  }
});

// -------------------- BOT LIST / MANAGEMENT --------------------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });
    const bots = response.data
      .filter(app => app.name.startsWith("trashcore-") || app.name.startsWith("bot-") || app.name.startsWith("drexter-"))
      .map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at
      }));
    res.json({ success: true, count: bots.length, bots });
  } catch (err) {
    console.error("Error fetching apps:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to fetch bots" });
  }
});

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
      { updates: [{ type: "worker", quantity: 1 }] },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ success: true, message: `✅ Worker activated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to activate worker" });
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
    if (idx !== -1) { data[idx].sessionId = sessionId; writeData(data); }
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
