const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || "YOUR_HEROKU_API_KEY";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -------------------- Helpers --------------------
function sanitizeAppName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/--+/g, "-");
}

// -------------------- List Bots --------------------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });

    const bots = response.data
      .filter((app) => app.name.startsWith("trashcore-") || app.name.startsWith("bot-"))
      .map((app) => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at,
      }));

    res.json(bots);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Failed to fetch bots" });
  }
});

// -------------------- Deploy Bot --------------------
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
  const { repo, sessionId } = req.query;
  const sanitizedAppName = sanitizeAppName(appName);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    res.write(`data: ✅ Creating app ${sanitizedAppName}...\n\n`);
    
    // Create Heroku app
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

    res.write(`data: ✅ App created!\n\n`);

    // Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId || "none" },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    // Upload source
    const source = await axios.post(
      "https://api.heroku.com/sources",
      {},
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    // Download tarball from GitHub
    const tarballData = await axios.get(repo, { responseType: "arraybuffer" });

    // Upload tarball to Heroku
    await axios.put(source.data.source_blob.put_url, tarballData.data, {
      headers: { "Content-Type": "application/octet-stream" },
    });

    res.write(`data: 📦 Repo tarball uploaded.\n\n`);

    // Start build
    const build = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: source.data.source_blob.get_url } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = build.data.id;
    res.write(`data: 🔨 Build started...\n\n`);

    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(`https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`, {
          headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
        });

        const status = statusRes.data.status;
        res.write(`data: Build status: ${status}\n\n`);

        if (status === "succeeded") {
          clearInterval(poll);
          // Disable web dyno, enable worker dyno
          await axios.patch(
            `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
            { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1 }] },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
          );

          res.write(`data: ✅ Deployment succeeded!\n\n`);
          res.end();
        } else if (status === "failed") {
          clearInterval(poll);
          // Show detailed error if available
          const outputRes = await axios.get(`https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
          });
          const errorMessage = outputRes.data.output_stream_url || "Unknown error during build.";
          res.write(`data: ❌ Deployment failed!\n`);
          res.write(`data: ⚠️ Heroku error: ${errorMessage}\n\n`);
          res.end();
        }
      } catch (err) {
        console.error(err.response?.data || err.message);
        res.write(`data: ⚠️ Error fetching build status: ${err.response?.data?.message || err.message}\n\n`);
        clearInterval(poll);
        res.end();
      }
    }, 4000);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`data: ❌ Deployment failed: ${err.response?.data?.message || err.message}\n\n`);
    res.end();
  }
});

// -------------------- Restart Bot --------------------
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
    });
    res.json({ success: true, message: `🔁 Restarted ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Restart failed" });
  }
});

// -------------------- Delete Bot --------------------
app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
    });
    res.json({ success: true, message: `🗑 Deleted ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Delete failed" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
