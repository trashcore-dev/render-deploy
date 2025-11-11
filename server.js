const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY || "your_heroku_api_key_here";
const PORT = process.env.PORT || 3000;

const DATA_FILE = "./data.json";

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

function readBots() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeBots(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 🧠 List of connected dashboard clients
let dashboardClients = [];

// ----------------- SSE for Dashboard -----------------
app.get("/dashboard-stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send initial bots
  const bots = readBots();
  res.write(`data: ${JSON.stringify({ type: "init", bots })}\n\n`);

  dashboardClients.push(res);

  req.on("close", () => {
    dashboardClients = dashboardClients.filter((client) => client !== res);
  });
});

function broadcastUpdate(bot) {
  dashboardClients.forEach((client) => {
    client.write(`data: ${JSON.stringify({ type: "new", bot })}\n\n`);
  });
}

// ----------------- Deploy Bot -----------------
app.post("/deploy", async (req, res) => {
  const { repoUrl, sessionId } = req.body;

  try {
    const appName = `trashcore-${Date.now()}`;
    console.log("🚀 Creating Heroku app:", appName);

    // Step 1: Create Heroku app
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

    // Step 2: Set environment variable
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

    // Step 3: Prepare source upload
    const source = await axios.post("https://api.heroku.com/sources", {}, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3",
      },
    });

    const sourceBlob = source.data.source_blob;

    const repoZip = await axios.get(`${repoUrl}/archive/refs/heads/main.zip`, {
      responseType: "arraybuffer",
    });
    await axios.put(sourceBlob.put_url, repoZip.data, {
      headers: { "Content-Type": "" },
    });

    // Step 4: Trigger build
    const build = await axios.post(
      `https://api.heroku.com/apps/${appName}/builds`,
      {
        source_blob: {
          url: sourceBlob.get_url,
          version: "main",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3",
        },
      }
    );

    const buildId = build.data.id;

    // Step 5: Poll build status
    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${appName}/builds/${buildId}`,
          {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept: "application/vnd.heroku+json; version=3",
            },
          }
        );

        const status = statusRes.data.status;
        console.log(`📊 Build status: ${status}`);

        if (status === "succeeded" || status === "failed") {
          clearInterval(poll);

          if (status === "succeeded") {
            // Activate worker only
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

            // Save bot info
            const bot = {
              name: appName,
              url: `https://${appName}.herokuapp.com`,
              created_at: new Date().toISOString(),
              sessionId,
            };

            const bots = readBots();
            bots.push(bot);
            writeBots(bots);

            // Broadcast to dashboard
            broadcastUpdate(bot);

            res.json({
              success: true,
              message: "✅ Bot deployed successfully",
              bot,
            });
          } else {
            res.json({ success: false, message: "❌ Build failed" });
          }
        }
      } catch (err) {
        console.error("Polling error:", err.message);
      }
    }, 5000);
  } catch (err) {
    console.error("Deployment failed:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Deployment failed" });
  }
});

// ----------------- List Bots -----------------
app.get("/bots", (req, res) => {
  res.json(readBots());
});

app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));
