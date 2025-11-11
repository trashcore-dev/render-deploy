const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const DATA_FILE = "./data.json";

// Ensure data.json exists (optional local cache)
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// --- DEPLOY BOT WITH LIVE LOGS ---
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
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3"
        }
      }
    );
    res.write(`data: ✅ App created: ${sanitizedAppName}\n\n`);

    // Set SESSION_ID
    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3"
        }
      }
    );
    res.write(`data: ✅ SESSION_ID configured.\n\n`);

    // Start build
    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: `${repo}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3"
        }
      }
    );

    const buildId = buildRes.data.id;

    // Poll build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept: "application/vnd.heroku+json; version=3"
            }
          }
        );

        const status = statusRes.data.status;
        res.write(`data: 🔄 Build status: ${status}\n\n`);

        if (statusRes.data.output_stream_url) {
          const logs = await axios.get(statusRes.data.output_stream_url);
          res.write(`data: ${logs.data}\n\n`);
        }

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            // 🔥 Disable web dyno, enable worker dyno
            await axios.patch(
              `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
              {
                updates: [
                  { type: "web", quantity: 0 },
                  { type: "worker", quantity: 1 }
                ]
              },
              {
                headers: {
                  Authorization: `Bearer ${HEROKU_API_KEY}`,
                  Accept: "application/vnd.heroku+json; version=3"
                }
              }
            );
            res.write(`data: ⚙️ Activated worker dyno & disabled web dyno\n\n`);
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

// --- LIST ALL BOTS (using Heroku API) ---
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3"
      }
    });

    const bots = response.data
      .filter(app => app.name.startsWith("trashcore-") || app.name.startsWith("bot-"))
      .map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at
      }));

    res.json(bots);
  } catch (err) {
    console.error("Error fetching Heroku apps:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Failed to fetch bots" });
  }
});

// --- DELETE APP ---
app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3"
      }
    });
    res.json({ success: true, message: `🗑 App "${appName}" deleted successfully.` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to delete app" });
  }
});

// --- GET LOGS ---
app.get("/logs/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    const logRes = await axios.post(
      `https://api.heroku.com/apps/${appName}/log-sessions`,
      { tail: true },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3"
        }
      }
    );
    res.json({ url: logRes.data.logplex_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: "❌ Failed to get logs" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
