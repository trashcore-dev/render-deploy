const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // GitHub PAT
const DATA_FILE = "./data.json";

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function saveApp(appInfo) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  data.push(appInfo);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// In-memory cache for fork verification
const forkCache = {};

// Verify if repo is a fork or Tennor-modz
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

// Sanitize app name for Heroku
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')         // replace invalid chars with dash
    .replace(/^-+|-+$/g, '')             // remove leading/trailing dash
    .replace(/--+/g, '-');               // collapse multiple dashes
}

// SSE endpoint for deployment logs
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
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

    res.write(`data: ✅ Heroku app created: ${sanitizedAppName}\n\n`);

    // Start build from Tennor-modz repo (you can replace with user's fork if needed)
    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: "https://github.com/Tennor-modz/trashcore-ultra/tarball/main" } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildRes.data.id;

    // Poll Heroku build status and stream logs
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
          res.write(`data: ✅ Deployment ${status}!\n\n`);
          clearInterval(poll);
          res.end();
        }
      } catch (err) {
        console.error("🚨 Heroku build polling error:", err.response?.data || err.message);
        res.write(`data: ⚠️ Error fetching logs. Check server logs.\n\n`);
        clearInterval(poll);
        res.end();
      }
    }, 3000);

  } catch (err) {
    console.error("🚨 Deployment error:", err.response?.data || err.message);
    res.write(`data: ❌ Deployment failed. Check server logs.\n\n`);
    res.end();
  }
});

// Deploy bot endpoint (records in data.json)
app.post("/deploy", async (req, res) => {
  const { repo, appName, sessionId } = req.body;

  const match = repo.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return res.status(400).json({ success: false, message: "❌ Invalid GitHub repo URL." });

  const [_, owner, name] = match;

  if (name !== "trashcore-ultra") {
    return res.status(400).json({ success: false, message: "❌ Repo name must be trashcore-ultra." });
  }

  const allowed = await checkFork(owner, name);
  if (!allowed) return res.status(400).json({ success: false, message: "❌ Only forks of Tennor-modz are allowed." });

  const info = {
    name: sanitizeAppName(appName),
    repo,
    sessionId,
    url: `https://${sanitizeAppName(appName)}.herokuapp.com`,
    date: new Date().toISOString()
  };

  saveApp(info);
  res.json({ success: true, message: "✅ Deployment started. Check logs endpoint.", app: info });
});

// Get all deployed bots
app.get("/bots", (req, res) => {
  const bots = JSON.parse(fs.readFileSync(DATA_FILE));
  res.json(bots);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
