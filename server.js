const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const AdmZip = require("adm-zip"); // For reading Procfile from tarball
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// -------------------- SQLITE SETUP --------------------
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "bots.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.prepare(`
  CREATE TABLE IF NOT EXISTS bots (
    name TEXT PRIMARY KEY,
    repo TEXT,
    sessionId TEXT,
    url TEXT,
    date TEXT
  )
`).run();

// -------------------- SQLITE HELPERS --------------------
function saveApp(appInfo) {
  db.prepare(`
    INSERT INTO bots (name, repo, sessionId, url, date)
    VALUES (@name, @repo, @sessionId, @url, @date)
    ON CONFLICT(name) DO UPDATE SET
      repo=excluded.repo,
      sessionId=excluded.sessionId,
      url=excluded.url,
      date=excluded.date
  `).run(appInfo);
}

function deleteLocalApp(name) {
  db.prepare(`DELETE FROM bots WHERE name = ?`).run(name);
}

// -------------------- SANITIZE APP NAME --------------------
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// -------------------- DETECT PROCFILE --------------------
async function detectProcfileRoles(tarballUrl) {
  try {
    const response = await axios.get(tarballUrl, { responseType: "arraybuffer" });
    const zip = new AdmZip(response.data);
    const procfileEntry = zip.getEntries().find(e => /Procfile$/i.test(e.entryName));
    if (!procfileEntry) return ["worker"];

    const content = procfileEntry.getData().toString("utf-8");
    const roles = [];
    content.split(/\r?\n/).forEach(line => {
      const match = line.match(/^([a-zA-Z0-9_-]+):/);
      if (match) roles.push(match[1]);
    });

    return roles.length ? roles : ["worker"];
  } catch (err) {
    console.error("Error reading Procfile:", err.message);
    return ["worker"];
  }
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
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ App created: ${sanitizedAppName}\n\n`);

    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    const roles = await detectProcfileRoles(repo);
    res.write(`data: 🔍 Detected roles in Procfile: ${roles.join(", ")}\n\n`);

    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: repo } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildRes.data.id;
    res.write(`data: 🧰 Build started...\n\n`);

    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`data: Build status: ${status}\n\n`);

        if (status === "succeeded") {
          clearInterval(poll);
          res.write(`data: ✅ Build succeeded!\n\n`);

          await axios.patch(
            `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
            { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1, size: "basic" }] },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
          );
          res.write(`data: ⚙️ Dynos scaled: web=0, worker=1\n\n`);

          saveApp({
            name: sanitizedAppName,
            repo,
            sessionId,
            url: `https://${sanitizedAppName}.herokuapp.com`,
            date: new Date().toISOString()
          });

          res.write(`data: 💾 Bot saved locally. Deployment complete!\n\n`);
          res.end();
        }

        if (status === "failed") {
          clearInterval(poll);
          res.write(`data: ❌ Deployment failed.\n\n`);
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

// -------------------- LIST BOTS FROM HEROKU (FIXED FOR LARGE NUMBERS) --------------------
app.get("/bots", async (req, res) => {
  try {
    let allApps = [];
    let page = 1;
    const pageSize = 50; // Heroku max per page

    while (true) {
      const herokuRes = await axios.get("https://api.heroku.com/apps", {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3",
        },
        params: { per_page: pageSize, page }
      });

      const apps = herokuRes.data.map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        region: app.region.name,
        stack: app.stack.name,
        created_at: app.created_at,
        status: "active",
      }));

      allApps = allApps.concat(apps);

      if (apps.length < pageSize) break; // No more pages
      page++;
    }

    res.json({ success: true, count: allApps.length, bots: allApps });
  } catch (err) {
    console.error("❌ Failed to fetch bots from Heroku:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Failed to load bots" });
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

app.post("/update-session/:appName", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "Session ID required" });

  try {
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    db.prepare(`UPDATE bots SET sessionId = ? WHERE name = ?`).run(sessionId, appName);

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

app.get("/logs/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    const logRes = await axios.post(
      `https://api.heroku.com/apps/${appName}/log-sessions`,
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
