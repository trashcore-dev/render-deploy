const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors()); // 👈 allow frontend requests
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const DATA_FILE = "./data.json";
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function saveApp(appInfo) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  data.push(appInfo);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.post("/deploy", async (req, res) => {
  const { repo, appName, sessionId } = req.body;
  try {
    await axios.post("https://api.heroku.com/apps", { name: appName }, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" }
    });

    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    await axios.post(`https://api.heroku.com/apps/${appName}/builds`,
      { source_blob: { url: `${repo}/archive/refs/heads/main.zip` } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const info = { name: appName, repo, sessionId, url: `https://${appName}.herokuapp.com`, date: new Date().toISOString() };
    saveApp(info);
    res.json({ success: true, message: `✅ Bot "${appName}" deployed!`, app: info });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Deployment failed." });
  }
});

app.get("/bots", (req, res) => {
  const bots = JSON.parse(fs.readFileSync(DATA_FILE));
  res.json(bots);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
