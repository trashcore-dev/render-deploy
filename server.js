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

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(express.static("public"));

// ---------- Helper: broadcast new bots ----------
function broadcastUpdate(bot) {
  io.emit("newBot", bot);
}

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

// ---------- Deploy New Bot ----------
app.post("/deploy", async (req, res) => {
  const { repoUrl, sessionId } = req.body;
  const appName = `trashcore-${Date.now()}`;

  try {
    // Respond immediately to prevent timeout
    res.json({ success: true, message: "🚀 Deployment started...", appName });

    (async () => {
      console.log(`⚙️ Creating Heroku app ${appName}`);

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

      // Set session ID
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

      // Upload repo
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

      const repoZip = await axios.get(`${repoUrl}/archive/refs/heads/main.zip`, {
        responseType: "arraybuffer",
      });

      await axios.put(source.data.source_blob.put_url, repoZip.data, {
        headers: { "Content-Type": "" },
      });

      // Start build
      const build = await axios.post(
        `https://api.heroku.com/apps/${appName}/builds`,
        {
          source_blob: { url: source.data.source_blob.get_url, version: "main" },
        },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: "application/vnd.heroku+json; version=3",
          },
        }
      );

      const buildId = build.data.id;
      console.log(`📦 Build started for ${appName}...`);

      const poll = setInterval(async () => {
        const buildStatus = await axios.get(
          `https://api.heroku.com/apps/${appName}/builds/${buildId}`,
          {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept: "application/vnd.heroku+json; version=3",
            },
          }
        );

        const status = buildStatus.data.status;
        console.log(`🔍 Build status [${appName}]: ${status}`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            // Disable web, enable worker
            await axios.patch(
              `https://api.heroku.com/apps/${appName}/formation`,
              {
                updates: [
                  { type: "web", quantity: 0 },
                  { type: "worker", quantity: 1 },
                ],
              },
              {
                headers: {
                  Authorization: `Bearer ${HEROKU_API_KEY}`,
                  Accept: "application/vnd.heroku+json; version=3",
                },
              }
            );

            console.log(`✅ ${appName} deployed successfully`);
            broadcastUpdate({
              name: appName,
              url: `https://${appName}.herokuapp.com`,
              sessionId,
              created_at: new Date().toISOString(),
            });
          } else {
            console.log(`❌ Build failed for ${appName}`);
          }
        }
      }, 5000);
    })();
  } catch (err) {
    console.error("Deployment failed:", err.message);
    res.status(500).json({ success: false, message: "Deployment failed" });
  }
});

// ---------- Restart Bot ----------
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
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
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });
    res.json({ success: true, message: `🗑 Deleted ${appName}` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: "Delete failed" });
  }
});

// ---------- Socket.IO Connection ----------
io.on("connection", socket => {
  console.log("🟢 Dashboard connected");
});

// ---------- Start Server ----------
server.listen(PORT, () =>
  console.log(`🚀 Drexter AI Dashboard running on http://localhost:${PORT}`)
);
