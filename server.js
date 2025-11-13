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
  const tarballPath = path.resolve(__dirname, "bot.tar.gz");
  const clonePath = path.resolve(__dirname, repoName);

  try {
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }

    execSync(`git clone ${repoUrl}`, { stdio: "inherit" });
    execSync(`tar -czf ${tarballPath} -C ${clonePath} .`);
    console.log("✅ Tarball created:", tarballPath);
    return tarballPath;
  } catch (err) {
    console.error("❌ Failed to package repo:", err.message);
    return null;
  }
}

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
  if (!tarballPath) {
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

    const tarballBuffer = fs.readFileSync(tarballPath);
    const uploadRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      {
        source_blob: {
          url: "data:application/octet-stream;base64," + tarballBuffer.toString("base64"),
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

    const buildId = uploadRes.data.id;
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
