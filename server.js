const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || "YOUR_HEROKU_API_KEY";

app.use(bodyParser.json());
app.use(express.static("public"));

// ---------- Dashboard ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Get Bots ----------
app.get("/bots", async (req, res) => {
  try {
    const response = await axios.get("https://api.heroku.com/apps", {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });

    const bots = response.data
      .filter(app => app.name.startsWith("trashcore-") || app.name.startsWith("bot-"))
      .map(app => ({
        name: app.name,
        url: `https://${app.name}.herokuapp.com`,
        created_at: app.created_at,
        updated_at: app.updated_at,
      }));

    res.json(bots);
  } catch (err) {
    console.error("Error fetching Heroku apps:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch bots" });
  }
});

// ---------- Deploy Bot ----------
app.post("/deploy", async (req, res) => {
  const { repoUrl, sessionId, appName: customName } = req.body;
  const appName = customName ? customName.toLowerCase().replace(/[^a-z0-9-]/g, "-") : `trashcore-${Date.now()}`;

  try {
    res.json({ success: true, message: "🚀 Deployment started...", appName });

    (async () => {
      io.emit("log", `[INFO] Creating Heroku app: ${appName}`);

      // Create app
      await axios.post(
        "https://api.heroku.com/apps",
        { name: appName },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: "application/vnd.heroku+json; version=3",
          },
        }
      );

      io.emit("log", `[INFO] App ${appName} created`);

      // Set SESSION_ID
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { SESSION_ID: sessionId || "none" },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: "application/vnd.heroku+json; version=3",
          },
        }
      );

      io.emit("log", `[INFO] SESSION_ID set`);

      // Get Heroku source URLs
      const source = await axios.post(
        "https://api.heroku.com/sources",
        {},
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: "application/vnd.heroku+json; version=3",
          },
        }
      );

      const zipRes = await axios.get(`${repoUrl}/archive/refs/heads/main.zip`, { responseType: "arraybuffer" });
      await axios.put(source.data.source_blob.put_url, zipRes.data, { headers: { "Content-Type": "" } });

      io.emit("log", `[INFO] Repo uploaded, starting build...`);

      // Start build
      const build = await axios.post(
        `https://api.heroku.com/apps/${appName}/builds`,
        { source_blob: { url: source.data.source_blob.get_url, version: "main" } },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
      );

      const buildId = build.data.id;

      const poll = setInterval(async () => {
        try {
          const statusRes = await axios.get(`https://api.heroku.com/apps/${appName}/builds/${buildId}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
          });

          const status = statusRes.data.status;
          io.emit("log", `[BUILD] Status: ${status}`);

          if (status === "succeeded" || status === "failed") {
            clearInterval(poll);

            if (status === "succeeded") {
              // Worker-only dyno
              await axios.patch(
                `https://api.heroku.com/apps/${appName}/formation`,
                { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1 }] },
                { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
              );

              io.emit("log", `[SUCCESS] ${appName} deployed as worker only`);
              io.emit("newBot", { name: appName, sessionId, url: `https://${appName}.herokuapp.com` });
            } else {
              io.emit("log", `[ERROR] Build failed for ${appName}`);
            }
          }
        } catch (err) {
          io.emit("log", `[ERROR] Polling build failed: ${err.message}`);
        }
      }, 5000);
    })();
  } catch (err) {
    console.error("Deployment failed:", err.message);
    io.emit("log", `[ERROR] Deployment failed: ${err.message}`);
  }
});

// ---------- Restart Bot ----------
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
    });
    res.json({ success: true, message: `🔁 Restarted ${appName}` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: "Restart failed" });
  }
});

// ---------- Delete Bot ----------
app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" },
    });
    res.json({ success: true, message: `🗑 Deleted ${appName}` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: "Delete failed" });
  }
});

// ---------- Socket.IO ----------
io.on("connection", socket => {
  console.log("🟢 Dashboard connected");
});

// ---------- Start Server ----------
server.listen(PORT, () => console.log(`🚀 Dashboard running on http://localhost:${PORT}`));
