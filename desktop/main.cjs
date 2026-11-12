// Resonant desktop app: starts Resonant's server with Electron's own Node, then shows the studio
// in a window. The server is the same code people run with `npm start`; this file only launches
// it, keeps it private to the window, and stops it when the app closes.
const { app, BrowserWindow, Menu, dialog, shell, session } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// One name in development and once installed, so the data folder is always %APPDATA%\Resonant
// (~/Library/Application Support/Resonant on a Mac, ~/.config/Resonant on Linux).
app.setName("Resonant");

// Where Resonant's code lives: next to this folder when developing, in resources/core when installed.
const CORE = app.isPackaged ? path.join(process.resourcesPath, "core") : path.join(__dirname, "..");
// Your history, voices and settings. RESONANT_DATA_DIR still wins, for people who keep data elsewhere.
const DATA_DIR = process.env.RESONANT_DATA_DIR || path.join(app.getPath("userData"), "data");
const LOG_FILE = path.join(app.getPath("userData"), "logs", "server.log");
// The browser extension looks for Resonant on these ports, so the app uses the first free one.
const PORTS = [3000, 3001, 3002, 3003, 3004, 3005];

let win = null;
let server = null;
let origin = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
async function pickPort() {
  for (const p of PORTS) if (await portFree(p)) return p;
  return 0; // the system picks one; the extension then needs the address entered by hand
}

function log(line) {
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

// Starts the server and resolves with its address once it's listening.
function startServer(port) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, `Resonant ${app.getVersion()} started ${new Date().toISOString()}\n`);
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(CORE, "server", "index.mjs")], {
      cwd: CORE,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), HOST: "127.0.0.1", RESONANT_DATA_DIR: DATA_DIR },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    server.stdout.on("data", (d) => log(String(d)));
    server.stderr.on("data", (d) => log(String(d)));
    server.on("message", (m) => {
      if (m?.type === "ready") resolve(`http://127.0.0.1:${m.port}`);
      if (m?.type === "error") reject(new Error(m.message));
    });
    server.on("exit", (code) => {
      log(`\nserver exited with code ${code}\n`);
      reject(new Error(`The voice engine stopped (code ${code}).`));
      server = null;
      if (!quitting && origin) serverDied(code);
    });
  });
}

function serverDied(code) {
  const choice = dialog.showMessageBoxSync(win, {
    type: "error",
    title: "Resonant",
    message: "Resonant's voice engine stopped unexpectedly.",
    detail: `It exited with code ${code}. The log may say why: ${LOG_FILE}`,
    buttons: ["Restart", "Open log", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 0) { app.relaunch(); app.exit(0); }
  else if (choice === 1) { shell.openPath(LOG_FILE); app.quit(); }
  else app.quit();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: "Resonant",
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });

  // The window shows Resonant and nothing else: other links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (origin && url.startsWith(origin + "/")) return { action: "allow" };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (origin && (url === origin || url.startsWith(origin + "/"))) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.loadFile(path.join(__dirname, "loading.html"));
}

// Microphone access is for recording voice samples; nothing else is granted, and only to Resonant's own pages.
function lockDownPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromResonant = Boolean(origin) && (details.requestingUrl || "").startsWith(origin + "/");
    callback(fromResonant && (permission === "media" || permission === "clipboard-sanitized-write"));
  });
}

function buildMenu() {
  const openData = { label: "Open data folder", click: () => { fs.mkdirSync(DATA_DIR, { recursive: true }); shell.openPath(DATA_DIR); } };
  const openLog = { label: "Open engine log", click: () => shell.openPath(LOG_FILE) };
  const page = (hash) => () => origin && win?.loadURL(`${origin}/app/settings${hash}`);
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [openData, openLog, { type: "separator" }, process.platform === "darwin" ? { role: "close" } : { role: "quit", label: "Exit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
    { label: "Help", submenu: [
      { label: "Browser extension", click: page("#extension") },
      { label: "What this computer can run", click: page("#computer") },
      { label: "Licences and credits", click: page("#about") },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  lockDownPermissions();
  createWindow();
  try {
    const port = await pickPort();
    origin = await startServer(port);
    if (win) await win.loadURL(`${origin}/app`);
  } catch (e) {
    if (quitting) return;
    dialog.showErrorBox("Resonant couldn't start", `${e.message}\n\nThe log may say why: ${LOG_FILE}`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  // Closing the IPC channel tells the server to stop its Python worker and exit.
  if (server) { try { server.disconnect(); } catch {} setTimeout(() => server?.kill(), 3000).unref(); }
});
