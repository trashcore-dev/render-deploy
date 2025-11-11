const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY || "your_heroku_api_key_here";
const PORT = process.env.PORT || 3000;

// -------------------- Helpers --------------------
function sanitizeAppName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/--+/g, "-");
}

// -------------------- Deploy Bot with SSE Logs --------------------
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
  const { repo, sessionId } = req.query;
  const sanitizedAppName = sanitizeAppName(appName);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const log = (msg) => {
    res.write(`data: ${msg}\n\n`);
  };

  try {
    log(`⏳ Creating app ${sanitizedAppName}...`);

    // Step 1: Create Heroku app
    const createApp = await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    log(`✅ App created!`);

    // Step 2: Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId || "none" },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    log(`✅ SESSION_ID configured.`);

    // Step 3: Get Heroku source blob URLs
    const sourceResp = await axios.post(
      "https://api.heroku.com/sources",
      {},
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    const sourceBlob = sourceResp.data.source_blob;
    log(`📦 Source blob URLs received.`);

    // Step 4: Download repo zip and upload to Heroku
    log(`⏳ Downloading repo from GitHub...`);
    const repoZip = await axios.get(`${repo}/archive/refs/heads/main.zip`, { responseType: "arraybuffer" });
    log(`📤 Uploading repo to Heroku...`);
    await axios.put(sourceBlob.put_url, repoZip.data, { headers: { "Content-Type": "" } });
    log(`✅ Repo uploaded.`);

    // Step 5: Trigger build
    const buildResp = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: sourceBlob.get_url, version: "main" } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    const buildId = buildResp.data.id;
    log(`🔨 Build triggered...`);

    // Step 6: Poll build status
    const poll = setInterval(async () => {
      try {
        const statusResp = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusResp.data.status;
        log(`📊 Build status: ${status}`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            log("✅ Deployment succeeded!");

            // Step 7: Activate worker only
            await axios.patch(
              `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
              { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1 }] },
              { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
            );

            log("⚙️ Worker dyno activated. Web dyno disabled.");
          } else {
            log("❌ Deployment failed! Check Heroku logs for details.");
          }

          res.end();
        }
      } catch (err) {
        log(`⚠️ Error fetching build status: ${err.response?.data || err.message}`);
        clearInterval(poll);
        res.end();
      }
    }, 5000);
  } catch (err) {
    log(`❌ Deployment error: ${err.response?.data || err.message}`);
    res.end();
  }
});

// -------------------- List Bots --------------------
app.get("/bots", (req, res) => {
  try {
    const botsData = fs.existsSync("./data.json")
      ? JSON.parse(fs.readFileSync("./data.json", "utf8"))
      : [];
    res.json(botsData);
  } catch (err) {
    res.status(500).json({ success: false, message: "Error reading bots data" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
