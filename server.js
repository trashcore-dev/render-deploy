const express = require("express");
const axios = require("axios");
const cors = require("cors");
const tar = require("tar-stream");
const gunzip = require("gunzip-maybe");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
const TARBALL_PATH = path.resolve(__dirname, "bot.tar.gz");

// -------------------- SANITIZE APP NAME --------------------
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// -------------------- PACKAGE GITHUB REPO --------------------
function packageGitRepo(repoUrl = "https://github.com/Tennor-modz/trashcore-ultra.git") {
  const repoName = "trashcore-ultra";
  const clonePath = path.resolve(__dirname, repoName);

  try {
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }

    execSync(`git clone ${repoUrl}`, { stdio: "inherit" });
    execSync(`tar -czf ${TARBALL_PATH} -C ${clonePath} .`);
    console.log("✅ Tarball created:", TARBALL_PATH);
    return TARBALL_PATH;
  } catch (err) {
    console.error("❌ Failed to package repo:", err.message);
    return null;
  }
}

// -------------------- SERVE TARBALL --------------------
app.get("/deploys/bot.tar.gz", (req, res) => {
  if (fs.existsSync(TARBALL_PATH)) {
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", "attachment; filename=bot.tar.gz");
    fs.createReadStream(TARBALL_PATH).pipe(res);
  } else {
    res.status(404).send("Tarball not found");
  }
});

// -------------------- DETECT PROCFILE CONTENT --------------------
async function detectProcfileContent(tarballPath) {
  try {
    const extract = tar.extract();
    let content = "";

    return await new Promise((resolve) => {
      extract.on("entry", (header, stream, next) => {
        if (header.name === "Procfile") {
          stream.on("data", chunk => content += chunk.toString());
          stream.on("end", next);
        } else {
          stream.resume();
          stream.on("end", next);
        }
      });

      extract.on("finish", () => resolve(content.trim()));
      fs.createReadStream(tarballPath).pipe(gunzip()).pipe(extract).on("error", () => resolve(""));
    });
  } catch {
    return "";
  }
}

// -------------------- DEPLOY BOT --------------------
app.get("/deploy/:appName/logs", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.query;
  const sanitizedAppName = sanitizeAppName(appName);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();

  const tarballPath = packageGitRepo();
  if (!tarballPath || !fs.existsSync(tarballPath)) {
    res.write(`data: ❌ Tarball packaging failed\n\n`);
    return res.end();
  }

  try {
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ App created: ${sanitizedAppName}\n\n`);

    await axios.put(
      `https://api.heroku.com/apps/${sanitizedAppName}/buildpack-installations`,
      { updates: [{ buildpack: "heroku/nodejs" }] },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: 🔧 Node.js buildpack enforced\n\n`);

    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`data: ✅ SESSION_ID configured\n\n`);

    const procfile = await detectProcfileContent(tarballPath);
    res.write(`data: 🔍 Procfile content:\n${procfile || "❌ Not found"}\n\n`);

    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      {
        source_blob: {
          url: "https://render-deploy-7mol.onrender.com/deploys/bot.tar.gz",
          version: "v1"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: "application/vnd.heroku+json; version=3"
        }
      }
    );

    const buildId = buildRes.data.id;
    res.write(`data: 🧰 Build started...\n\n`);

    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`data: Build status: ${status}\n\n`);

        if (status === "succeeded") {
          clearInterval(poll);
          res.write(`data: ✅ Build succeeded\n\n`);

          await axios.patch(
            `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
            { updates: [{ type: "web", quantity: 1, size: "basic" }] },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
          );

          res.write(`data: ⚙️ Dynos scaled: web=1\n\n`);
          res.write(`data: 🚀 Bot live at https://${sanitizedAppName}.herokuapp.com\n\n`);
          res.end();
        }

        if (status === "failed") {
          clearInterval(poll);
          res.write(`data: ❌ Build failed\n\n`);
          res.end();
        }
      } catch {
        clearInterval(poll);
        res.write(`data: ⚠️ Error checking build status\n\n`);
        res.end();
      }
    }, 3000);

  } catch (err) {
    res.write(`data: ❌ Deployment error: ${err.message}\n\n`);
    res.end();
  }
});

// -------------------- DYNOS & APP MANAGEMENT --------------------

// Restart dynos
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  const sanitizedAppName = sanitizeAppName(appName);

  try {
    await axios.delete(`https://api.heroku.com/apps/${sanitizedAppName}/dynos`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: "application/vnd.heroku+json; version=3"
      }
    });
    res.json({ success: true, message: `✅ Dynos restarted for ${sanitizedAppName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to restart dynos" });
  }
});

// Update SESSION_ID
app.post("/update-session/:appName", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "Session ID required" });

  try {
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ success: true, message: `✅ Session ID updated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to update session ID" });
  }
});

// Delete app
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

// Get Heroku log session URL
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

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
