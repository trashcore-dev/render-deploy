const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // your GitHub PAT
const DATA_FILE = "./data.json";

if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function saveApp(appInfo) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  data.push(appInfo);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Simple in-memory cache for fork verification
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
    console.error("GitHub API error:", err.response?.data || err.message);
    forkCache[key] = false;
    return false;
  }
}

// ✅ Deploy bot only if it's Tennor-modz repo or a fork
app.post("/deploy", async (req, res) => {
  const { repo, appName, sessionId } = req.body;

  const match = repo.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return res.status(400).json({ success: false, message: "❌ Invalid GitHub repo URL." });

  const [_, owner, name] = match;

  if (name !== "trashcore-ultra") {
    return res.status(400).json({ success: false, message: "❌ Repo name must be trashcore-ultra." });
  }

  try {
    const allowed = await checkFork(owner, name);
    if (!allowed) {
      return res.status(400).json({ success: false, message: "❌ Only forks of Tennor-modz are allowed." });
    }

    // Create Heroku app
    await axios.post(
      "https://api.heroku.com/apps",
      { name: appName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    // Set session ID
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    // Build from user's repo
    await axios.post(
      `https://api.heroku.com/apps/${appName}/builds`,
      { source_blob: { url: `${repo}/archive/refs/heads/main.zip` } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const info = {
      name: appName,
      repo,
      sessionId,
      url: `https://${appName}.herokuapp.com`,
      date: new Date().toISOString(),
    };
    saveApp(info);

    res.json({ success: true, message: `✅ Bot "${appName}" deployed!`, app: info });
  } catch (err) {
    console.error(err.response?.data || err.message);
    let errorMsg = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
    if (err.response?.status) errorMsg = `HTTP ${err.response.status}: ${errorMsg}`;

    res.status(500).json({
      success: false,
      message: "❌ Deployment failed. See error below:",
      error: errorMsg,
    });
  }
});

// Get all deployed bots
app.get("/bots", (req, res) => {
  const bots = JSON.parse(fs.readFileSync(DATA_FILE));
  res.json(bots);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
