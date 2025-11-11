const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_FILE = "./data.json";

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

// Save or update app info locally
function saveApp(appInfo) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  const idx = data.findIndex(a => a.name === appInfo.name);
  if (idx !== -1) data[idx] = appInfo;
  else data.push(appInfo);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// In-memory cache for fork verification
const forkCache = {};
async function checkFork(owner, repoName) {
  const key = `${owner}/${repoName}`;
  if (forkCache[key] !== undefined) return forkCache[key];

  try {
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    const repoData = res.data;
    const isAllowed = repoData.fork || owner === "Tennor-modz";
    forkCache[key] = isAllowed;
    return isAllowed;
  } catch (err) {
    console.error("🚨 GitHub API error:", err.response?.data || err.message);
    forkCache[key] = false;
    return false;
  }
}

// Sanitize app name
function sanitizeAppName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-');
}

// -------------------- DEPLOY BOT --------------------
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
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ Heroku app created: ${sanitizedAppName}\n\n`);

    // 2️⃣ Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    // 3️⃣ Start build
    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: `${repo}/tarball/main` } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildRes.data.id;

    // Poll build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`data: Build status: ${status}\n\n`);

        if (statusRes.data.output_stream_url) {
          const logs = await axios.get(statusRes.data.output_stream_url);
          res.write(`data: ${logs.data}\n\n`);
        }

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);
          res.write(`data: ✅ Deployment ${status}!\n\n`);
          if (status === "succeeded") {
            saveApp({
              name: sanitizedAppName,
              repo,
              sessionId,
              url: `https://${sanitizedAppName}.herokuapp.com`,
              date: new Date().toISOString()
            });
          }
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
  const localBots = JSON.parse(fs.readFileSync(DATA_FILE));
  try {
    const herokuRes = await axios.get("https://api.heroku.com/apps", {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });

    const merged = herokuRes.data.map(app => {
      const local = localBots.find(b => b.name === app.name) || {};
      return {
        name: app.name,
        repo: local.repo || "Unknown",
        sessionId: local.sessionId || "Not Set",
        url: `https://${app.name}.herokuapp.com`,
        date: local.date || app.created_at
      };
    });
    res.json(merged);
  } catch {
    res.json(localBots);
  }
});

// -------------------- DYNOS & APP MANAGEMENT --------------------

// Restart dynos
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

// Activate dynos
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

// Update session ID
app.post("/update-session/:appName", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "Session ID required" });

  try {
    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    const idx = data.findIndex(b => b.name === appName);
    if (idx !== -1) { data[idx].sessionId = sessionId; fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

    res.json({ success: true, message: `✅ Session ID updated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to update session ID" });
  }
});

// Delete app
app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    fs.writeFileSync(DATA_FILE, JSON.stringify(data.filter(b => b.name !== appName), null, 2));
    res.json({ success: true, message: `🗑 App "${appName}" deleted successfully.` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to delete app" });
  }
});

// Get Heroku logs
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
