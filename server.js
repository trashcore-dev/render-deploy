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

// Helper functions
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
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// Check Procfile content
async function checkProcfile(repo) {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${repo.replace(
      "https://github.com/",
      ""
    )}/main/Procfile`;

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return resolve("web"); // default if missing
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (data.includes("worker:")) resolve("worker");
          else resolve("web");
        });
      })
      .on("error", () => resolve("web"));
  });
}

// --- Deploy ---
app.post("/deploy", async (req, res) => {
  const { appName, repo, sessionId } = req.body;
  const sanitized = sanitizeAppName(appName || `trashcore-${Date.now()}`);
  const tarballUrl = `${repo}/tarball/main`;

  const headers = {
    Authorization: `Bearer ${HEROKU_API_KEY}`,
    Accept: "application/vnd.heroku+json; version=3",
    "Content-Type": "application/json",
  };

  const log = (msg) => console.log(`[DEPLOY] ${msg}`);

  try {
    log(`Creating app ${sanitized}...`);
    const createApp = await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitized },
      { headers }
    );
    log(`✅ App created: ${sanitized}`);

    await axios.patch(
      `https://api.heroku.com/apps/${sanitized}/config-vars`,
      { SESSION_ID: sessionId || "none" },
      { headers }
    );
    log("✅ SESSION_ID configured.");

    const procType = await checkProcfile(repo);
    log(`🧩 Detected process type: ${procType}`);

    log(`🧱 Starting build from tarball: ${tarballUrl}`);
    const buildResp = await axios.post(
      `https://api.heroku.com/apps/${sanitized}/builds`,
      {
        source_blob: {
          url: tarballUrl,
          version: "main",
        },
      },
      { headers }
    );

    const buildId = buildResp.data.id;

    // Poll build until done
    let buildStatus = "pending";
    while (buildStatus === "pending" || buildStatus === "running") {
      const poll = await axios.get(
        `https://api.heroku.com/apps/${sanitized}/builds/${buildId}`,
        { headers }
      );
      buildStatus = poll.data.status;
      log(`⚙️ Build status: ${buildStatus}`);
      if (buildStatus === "succeeded" || buildStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (buildStatus === "failed") {
      log("❌ Build failed.");
      return res.json({
        success: false,
        message:
          "Build failed. Heroku couldn't fetch or build the app. Please verify your repo.",
      });
    }

    // Activate only correct dyno type
    const updates =
      procType === "worker"
        ? [
            { type: "web", quantity: 0 },
            { type: "worker", quantity: 1, size: "basic" },
          ]
        : [{ type: "web", quantity: 1, size: "basic" }];

    await axios.patch(
      `https://api.heroku.com/apps/${sanitized}/formation`,
      { updates },
      { headers }
    );

    log(`✅ ${procType} dyno activated.`);

    saveApp({
      name: sanitized,
      repo,
      sessionId,
      type: procType,
      url: `https://${sanitized}.herokuapp.com`,
      date: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `✅ ${procType} bot deployed successfully!`,
      app: {
        name: sanitized,
        type: procType,
        url: `https://${sanitized}.herokuapp.com`,
      },
      next: [
        {
          label: "View Logs",
          url: `https://dashboard.heroku.com/apps/${sanitized}/activity`,
        },
        {
          label: "Manage App",
          url: `https://dashboard.heroku.com/apps/${sanitized}`,
        },
      ],
    });
  } catch (err) {
    console.error("🚨 Deployment Error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: "Deployment failed.",
      error: err.response?.data || err.message,
    });
  }
});

// --- List Bots ---
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
        (a) =>
          a.name.startsWith("trashcore-") ||
          a.name.startsWith("drexter-") ||
          a.name.startsWith("bot-")
      )
      .map((a) => ({
        name: a.name,
        url: `https://${a.name}.herokuapp.com`,
        created_at: a.created_at,
      }));

    res.json({ success: true, count: bots.length, bots });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch bots.",
      error: err.response?.data || err.message,
    });
  }
});

// --- Delete Bot ---
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
    res.json({ success: true, message: `🗑 Deleted ${appName} successfully.` });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to delete app.",
      error: err.response?.data || err.message,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
