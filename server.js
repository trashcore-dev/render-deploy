const express = require("express");
const axios = require("axios");
const cors = require("cors");
const AdmZip = require("adm-zip"); // For reading Procfile from tarball
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const HEROKUAPIKEY = process.env.HEROKU_API_KEY;

// -------------------- SANITIZE APP NAME --------------------
function sanitizeAppName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

// -------------------- DETECT PROCFILE --------------------
async function detectProcfileRoles(tarballUrl) {
  try {
    const response = await axios.get(tarballUrl, { responseType: "arraybuffer" });
    const zip = new AdmZip(response.data);
    const procfileEntry = zip.getEntries().find(e => /Procfile$/i.test(e.entryName));
    if (!procfileEntry) return ["worker"];

    const content = procfileEntry.getData().toString("utf-8");
    const roles = [];
    content.split(/\r?\n/).forEach(line => {
      const match = line.match(/^([a-zA-Z0-9_-]+):/);
      if (match) roles.push(match[1]);
    });

    return roles.length ? roles : ["worker"];
  } catch (err) {
    console.error("Error reading Procfile:", err.message);
    return ["worker"];
  }
}

// -------------------- DEPLOY BOT WITH LIVE LOGS --------------------
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
    await axios.post(
      "https://api.heroku.com/apps",
      { name: sanitizedAppName },
      { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`✅ App created: ${sanitizedAppName}\n\n`);

    await axios.patch(
      `https://api.heroku.com/apps/${sanitizedAppName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.write(`✅ SESSION_ID configured.\n\n`);

    const roles = await detectProcfileRoles(repo);
    res.write(`🔍 Detected roles in Procfile: ${roles.join(", ")}\n\n`);

    const buildRes = await axios.post(
      `https://api.heroku.com/apps/${sanitizedAppName}/builds`,
      { source_blob: { url: repo } },
      { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );

    const buildId = buildRes.data.id;
    res.write(`🧰 Build started...\n\n`);

    const poll = setInterval(async () => {
      try {
        const statusRes = await axios.get(
          `https://api.heroku.com/apps/${sanitizedAppName}/builds/${buildId}`,
          { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
        );

        const status = statusRes.data.status;
        res.write(`Build status: ${status}\n\n`);

        if (status === "succeeded") {
          clearInterval(poll);
          res.write(`✅ Build succeeded!\n\n`);

          await axios.patch(
            `https://api.heroku.com/apps/${sanitizedAppName}/formation`,
            { updates: [{ type: "web", quantity: 0 }, { type: "worker", quantity: 1, size: "basic" }] },
            { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
          );
          res.write(`⚙️ Dynos scaled: web=0, worker=1\n\n`);

          res.write(`💾 Deployment complete! Bot URL: https://${sanitizedAppName}.herokuapp.com\n\n`);
          res.end();
        }

        if (status === "failed") {
          clearInterval(poll);
          res.write(`❌ Deployment failed.\n\n`);
          res.end();
        }
      } catch (err) {
        console.error(err.response?.data || err.message);
        res.write(`⚠️ Error fetching build logs.\n\n`);
        clearInterval(poll);
        res.end();
      }
    }, 3000);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.write(`❌ Deployment failed.\n\n`);
    res.end();
  }
});

// -------------------- DYNOS & APP MANAGEMENT --------------------

// Restart dynos for a given app
app.post("/restart/:appName", async (req, res) => {
  const { appName } = req.params;
  const sanitizedAppName = sanitizeAppName(appName);

  try {
    await axios.delete(`https://api.heroku.com/apps/${sanitizedAppName}/dynos`, {
      headers: { 
        Authorization: `Bearer ${HEROKUAPIKEY}`, 
        Accept: "application/vnd.heroku+json; version=3" 
      }
    });
    res.json({ success: true, message: `✅ Dynos restarted for ${sanitizedAppName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to restart dynos" });
  }
});

// Update session ID for a given app
app.post("/update-session/:appName", async (req, res) => {
  const { appName } = req.params;
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: "Session ID required" });

  try {
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { SESSION_ID: sessionId },
      { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ success: true, message: `✅ Session ID updated for ${appName}` });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: "❌ Failed to update session ID" });
  }
});

// Delete an app
app.delete("/delete/:appName", async (req, res) => {
  const { appName } = req.params;
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" }
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
      { headers: { Authorization: `Bearer ${HEROKUAPIKEY}`, Accept: "application/vnd.heroku+json; version=3" } }
    );
    res.json({ url: logRes.data.logplex_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: "❌ Failed to get logs" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
