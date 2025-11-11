const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const unzipper = require("unzipper"); // For extracting tarball contents
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(cors({ origin: "*", methods: "GET,POST,DELETE,PATCH" }));
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const DATA_FILE = "./data.json";

// Create data.json if missing
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

function sanitizeAppName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}
function readData() { try { return JSON.parse(fs.readFileSync(DATA_FILE)); } catch { return []; } }
function writeData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
function saveApp(appInfo) { const d = readData(); d.push(appInfo); writeData(d); }

// -------------------- DEPLOY WITH PROCFILE DETECTION --------------------
app.post("/deploy", async (req, res) => {
  const { appName, repo, sessionId } = req.body;
  const sanitized = sanitizeAppName(appName || `trashcore-${Date.now()}`);
  const tarballUrl = `${repo}/tarball/main`;

  res.setHeader("Content-Type", "text/plain");

  try {
    if (!HEROKU_API_KEY) throw new Error("Missing HEROKU_API_KEY in environment");
    res.write(`✅ Starting deployment for: ${sanitized}\n`);

    // 1. Create Heroku app
    const createApp = await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitized },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`✅ App created: ${createApp.data.name}\n`);

    // 2. Set SESSION_ID
    if(sessionId) {
      await axios.patch(
        `https://api.heroku.com/apps/${sanitized}/config-vars`,
        { SESSION_ID: sessionId },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
      );
      res.write(`✅ SESSION_ID configured.\n`);
    }

    // 3. Download tarball locally to check Procfile
    const tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tarballResp = await axios.get(tarballUrl, { responseType: "arraybuffer" });
    const tarballPath = path.join(tmpDir, "source.tar.gz");
    fs.writeFileSync(tarballPath, tarballResp.data);
    res.write(`📦 Tarball downloaded for Procfile check.\n`);

    // 4. Extract Procfile
    const tar = require("tar");
    await tar.x({ file: tarballPath, cwd: tmpDir, strip: 1 });
    let dynoType = "worker"; // default
    const procfilePath = path.join(tmpDir, "Procfile");
    if (fs.existsSync(procfilePath)) {
      const content = fs.readFileSync(procfilePath, "utf8").toLowerCase();
      if(content.includes("web:")) dynoType = "web";
      else if(content.includes("worker:")) dynoType = "worker";
      res.write(`⚙️ Procfile detected, dyno type: ${dynoType}\n`);
    } else {
      res.write(`⚠️ No Procfile found, defaulting to worker dyno\n`);
    }

    // 5. Start Heroku build
    const build = await axios.post(
      `https://api.heroku.com/apps/${sanitized}/builds`,
      { source_blob: { url: tarballUrl } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    const buildId = build.data.id;
    res.write(`📦 Build started: ${buildId}\n`);

    // 6. Poll build status
    let done = false;
    while (!done) {
      const poll = await axios.get(
        `https://api.heroku.com/apps/${sanitized}/builds/${buildId}`,
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
      );
      const status = poll.data.status;
      res.write(`⚙️ Build status: ${status}\n`);
      if (status === "succeeded" || status === "failed") {
        done = true;
        if (status === "succeeded") {
          // 7. Activate dyno type based on Procfile
          await axios.patch(
            `https://api.heroku.com/apps/${sanitized}/formation`,
            { updates: [{ type: dynoType, quantity: 1 }] },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
          );
          res.write(`✅ ${dynoType.charAt(0).toUpperCase() + dynoType.slice(1)} dyno activated.\n`);
          saveApp({ name: sanitized, repo, url: `https://${sanitized}.herokuapp.com`, sessionId, dynoType });
        } else {
          res.write(`❌ Deployment failed.\n`);
        }
      }
      await new Promise((r) => setTimeout(r, 4000));
    }

    res.end(`✅ Deployment completed for ${sanitized}\n`);

    // 8. Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error("Deployment error:", err.response?.data || err.message);
    res.write(`❌ Deployment error: ${err.response?.data?.message || err.message}\n`);
    res.end();
  }
});

app.get("/", (req, res) => res.send("🚀 Heroku Deploy API active."));
app.listen(process.env.PORT || 5000, () => console.log("Server running ✅"));
