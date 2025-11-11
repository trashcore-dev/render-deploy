<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trash Bot Deployer</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Poppins", sans-serif;
  background: linear-gradient(135deg, #0c141a, #1a2b3c, #0d2335);
  color: #e0f7fa;
  text-align: center;
  padding: 16px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 20px;
  line-height: 1.5;
}
.container { width: 100%; max-width: 420px; margin: 0 auto; position: relative; }
h1 {
  font-size: 1.8rem;
  font-weight: 700;
  margin: 24px 0 16px;
  background: linear-gradient(90deg, #00e6cc, #00b3ff, #00e6cc);
  background-size: 200% 200%;
  animation: gradientShift 4s ease-in-out infinite alternate;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
@keyframes gradientShift { 0% { background-position: 0% 50%; } 100% { background-position: 100% 50%; } }
.card {
  background: rgba(10, 25, 35, 0.6);
  backdrop-filter: blur(8px);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4),
              inset 0 0 0 1px rgba(0, 200, 255, 0.1);
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
input, button {
  padding: 14px 16px;
  margin: 0;
  border-radius: 12px;
  border: 2px solid rgba(0, 200, 255, 0.25);
  width: 100%;
  font-size: 16px;
  background: rgba(10, 25, 47, 0.7);
  color: #e0f7fa;
  transition: all 0.3s ease;
  outline: none;
  font-family: inherit;
}
input::placeholder { color: #6ab0b9; }
input:focus {
  border-color: #00e6cc;
  box-shadow: 0 0 0 3px rgba(0, 230, 204, 0.25);
  background: rgba(10, 25, 47, 0.9);
}
button {
  background: linear-gradient(90deg, #00e6cc, #00b3ff);
  color: #0a1929;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.5px;
  box-shadow: 0 4px 12px rgba(0, 180, 255, 0.3);
  transition: all 0.3s ease;
}
button:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0, 180, 255, 0.5); }
button:active { transform: translateY(0); }
.link { color: #00e6cc; text-decoration: none; font-weight: 600; margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; transition: color 0.3s; }
.link:hover { color: #00b3ff; }
#logs {
  margin-top: 8px;
  padding: 16px;
  border-radius: 12px;
  background: rgba(5, 18, 30, 0.7);
  width: 100%;
  max-width: 100%;
  min-height: 240px;
  max-height: 320px;
  overflow: auto;
  font-size: 0.95rem;
  text-align: left;
  white-space: pre-wrap;
  font-family: "Fira Code", "Courier New", monospace;
  color: #c3e8ef;
  border: 1px solid rgba(0, 200, 255, 0.1);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.3);
}
.cta-buttons {
  display: none;
  gap: 12px;
  margin-top: 16px;
}
.cta-buttons a, .cta-buttons button {
  padding: 10px 18px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  text-decoration: none;
  color: #fff;
  background: linear-gradient(90deg, #00e6cc, #00b3ff);
  transition: 0.3s;
}
.cta-buttons a:hover, .cta-buttons button:hover {
  background: linear-gradient(90deg, #00b3ff, #00e6cc);
}

/* Menu Styles */
.menu-toggle {
  position: absolute;
  top: 16px;
  left: 16px;
  background: rgba(10, 25, 35, 0.6);
  border: 2px solid rgba(0, 200, 255, 0.25);
  border-radius: 12px;
  padding: 10px;
  cursor: pointer;
  z-index: 10;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 40px;
  height: 40px;
  transition: all 0.3s ease;
}
.menu-toggle:hover {
  background: rgba(10, 25, 47, 0.7);
  border-color: #00e6cc;
}
.menu-toggle span {
  display: block;
  width: 20px;
  height: 2px;
  background: #e0f7fa;
  margin: 2px 0;
  transition: 0.3s;
  border-radius: 1px;
}
.menu {
  position: absolute;
  top: 60px;
  left: 16px;
  background: rgba(10, 25, 35, 0.95);
  backdrop-filter: blur(8px);
  border-radius: 12px;
  padding: 12px 0;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4),
              inset 0 0 0 1px rgba(0, 200, 255, 0.1);
  width: 180px;
  z-index: 100;
  display: none;
}
.menu a {
  display: block;
  padding: 12px 16px;
  color: #e0f7fa;
  text-decoration: none;
  transition: all 0.3s ease;
  font-size: 16px;
  font-weight: 500;
}
.menu a:hover {
  background: rgba(0, 230, 204, 0.15);
  color: #00e6cc;
}
.menu.active {
  display: block;
}
</style>
</head>
<body>
<div class="container">
  <!-- Menu Toggle Button -->
  <button class="menu-toggle" id="menuToggle">
    <span></span>
    <span></span>
    <span></span>
  </button>

  <!-- Menu -->
  <div class="menu" id="menu">
    <a href="dashboard.html">⚙️ Dashboard</a>
  </div>

  <h1>🚀 Trash Bot Deployer</h1>

  <div class="card">
    <input type="text" id="username" placeholder="GitHub Username" required>
    <button type="button" id="verifyBtn">🔍 Verify Username</button>
    <input type="text" id="appName" placeholder="App Name (unique)" required>
    <input type="text" id="sessionId" placeholder="Session ID / Auth Key" required>
    <button id="deployBtn">⚡ Deploy Bot</button>
  </div>

  <pre id="logs">Logs will appear here...</pre>
  <div class="cta-buttons" id="ctaButtons">
    <a href="dashboard.html">⚙️ Manage Bots</a>
    <button id="viewLogsBtn">📄 View Logs</button>
  </div>
</div>

<script>
const API_URL = " https://render-deploy-7mol.onrender.com ";
const REPO_OWNER = "Tennor-modz";
const REPO_NAME = "trashcore-ultra";
let deploymentLogs = "";

// Menu Toggle Functionality
document.getElementById("menuToggle").addEventListener("click", function() {
  const menu = document.getElementById("menu");
  menu.classList.toggle("active");
});

// Close menu when clicking outside
document.addEventListener("click", function(event) {
  const menu = document.getElementById("menu");
  const menuToggle = document.getElementById("menuToggle");
  
  if (!menu.contains(event.target) && !menuToggle.contains(event.target)) {
    menu.classList.remove("active");
  }
});

async function checkFork(username) {
  if(username === REPO_OWNER) return true;
  try {
    const res = await fetch(`https://api.github.com/repos/ ${username}/${REPO_NAME}`);
    if(!res.ok) return false;
    const repo = await res.json();
    return repo.fork === true && repo.owner.login === username;
  } catch { return false; }
}

function forkNow() { window.open(`https://github.com/ ${REPO_OWNER}/${REPO_NAME}/fork`, "_blank"); }

document.getElementById("verifyBtn").addEventListener("click", async () => {
  const username = document.getElementById("username").value.trim();
  const logsEl = document.getElementById("logs");
  if(!username) { logsEl.textContent = "⚠️ Enter GitHub username first."; return; }

  logsEl.textContent = "⏳ Verifying fork...";
  const hasFork = await checkFork(username);

  if(!hasFork && username !== REPO_OWNER) {
    logsEl.innerHTML = `❌ You must fork <strong>${REPO_OWNER}/${REPO_NAME}</strong> first.<br><button onclick="forkNow()">Fork Now</button>`;
  } else {
    logsEl.textContent = "✅ Verified! You can now deploy.";
  }
});

document.getElementById("deployBtn").addEventListener("click", async () => {
  const username = document.getElementById("username").value.trim();
  const appName = document.getElementById("appName").value.trim();
  const sessionId = document.getElementById("sessionId").value.trim();
  const logsEl = document.getElementById("logs");
  const ctaButtons = document.getElementById("ctaButtons");

  if(!username || !appName || !sessionId) { logsEl.textContent = "⚠️ Fill all fields."; return; }

  logsEl.textContent = "⏳ Checking fork...";
  const hasFork = await checkFork(username);
  if(!hasFork && username !== REPO_OWNER) { logsEl.textContent = "❌ Fork required."; return; }

  logsEl.textContent = "✅ Fork verified. Starting deployment...\n";
  deploymentLogs = "";

  const forkUrl = `https://github.com/ ${username}/${REPO_NAME}`;
  const url = `${API_URL}/deploy/${appName}/logs?repo=${encodeURIComponent(forkUrl)}&sessionId=${encodeURIComponent(sessionId)}`;
  const evtSource = new EventSource(url);

  evtSource.onmessage = (event) => {
    deploymentLogs += event.data + "\n";
    logsEl.textContent = deploymentLogs;
    logsEl.scrollTop = logsEl.scrollHeight;

    // If deployment finished
    if(event.data.includes("Deployment succeeded") || event.data.includes("Deployment failed")) {
      evtSource.close();
      ctaButtons.style.display = "flex";
    }
  };

  evtSource.onerror = () => {
    logsEl.textContent += "\n⚠️ Deployment connection closed unexpectedly.";
    evtSource.close();
    ctaButtons.style.display = "flex";
  };

  document.getElementById("viewLogsBtn").addEventListener("click", () => {
    const blob = new Blob([deploymentLogs], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  });
});
</script>
</body>
</html>
