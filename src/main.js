'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } = require('electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Engine } = require('./core/engine');

let engine;
let settings;
let tray;
let mainWindow;
let quitting = false;
const unread = {};
let activeConversation = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const defaults = {
    name: os.userInfo().username,
    downloadDir: path.join(app.getPath('downloads'), 'Beacon'),
    targets: [],
    openAtLogin: false,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function updateBadge() {
  const total = Object.values(unread).reduce((sum, count) => sum + count, 0);
  app.setBadgeCount(total);
  if (tray) tray.setToolTip(total ? `Beacon (${total} unread)` : 'Beacon');
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function onIncoming(message) {
  const viewing = mainWindow && mainWindow.isFocused() && activeConversation === message.conv;
  if (viewing) return;
  unread[message.conv] = (unread[message.conv] || 0) + 1;
  updateBadge();
  send('unread', unread);
  if (!Notification.isSupported()) return;
  const body = message.kind === 'file' ? `Wants to send you ${message.file.name}` : message.text.slice(0, 160);
  const notification = new Notification({ title: message.fromName, body });
  notification.on('click', () => {
    showWindow();
    send('open-conversation', message.conv);
  });
  notification.show();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 640,
    minHeight: 440,
    title: 'Beacon',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Returning to an open chat counts as reading it.
  mainWindow.on('focus', () => {
    if (activeConversation && unread[activeConversation]) {
      delete unread[activeConversation];
      updateBadge();
      send('unread', unread);
    }
  });
  // This window only ever shows the bundled page. Other content opens nowhere.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  // Closing hides to the tray, so messages keep arriving.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'tray.png');
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip('Beacon');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Beacon', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

function publicSettings() {
  return { ...settings, id: engine.id, port: engine.listenPort };
}

function registerIpc() {
  ipcMain.handle('state', () => ({
    settings: publicSettings(),
    peers: engine.listPeers(),
    messages: engine.store.data.messages,
    unread,
  }));
  ipcMain.handle('send-text', (_event, conv, text) => {
    engine.sendText(conv, text);
  });
  ipcMain.handle('send-file', async (_event, conv) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (!result.canceled) for (const filePath of result.filePaths) engine.offerFile(conv, filePath);
  });
  ipcMain.handle('accept-file', async (_event, conv, id) => {
    await engine.acceptFile(conv, id);
  });
  ipcMain.handle('decline-file', async (_event, conv, id) => {
    await engine.declineFile(conv, id);
  });
  ipcMain.handle('show-file', (_event, conv, id) => {
    const message = engine.store.findMessage(conv, id);
    if (message && message.file && message.file.savedPath) shell.showItemInFolder(message.file.savedPath);
  });
  ipcMain.handle('set-active', (_event, conv) => {
    activeConversation = conv;
    delete unread[conv];
    updateBadge();
    return unread;
  });
  ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('save-settings', (_event, next) => {
    const targets = String(next.targets || '').split(/[\s,]+/).filter(Boolean);
    const invalid = targets.find((target) => !net.isIPv4(target));
    if (invalid) throw new Error(`"${invalid}" is not a valid IPv4 address`);
    settings = {
      ...settings,
      name: String(next.name || '').trim().slice(0, 64) || settings.name,
      downloadDir: String(next.downloadDir || settings.downloadDir),
      targets,
      openAtLogin: Boolean(next.openAtLogin),
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
    engine.name = settings.name;
    engine.downloadDir = settings.downloadDir;
    engine.targets = targets;
    engine.announce('hello');
    return publicSettings();
  });
}

async function start() {
  settings = loadSettings();
  engine = new Engine({
    dataDir: path.join(app.getPath('userData'), 'data'),
    name: settings.name,
    downloadDir: settings.downloadDir,
    targets: settings.targets,
  });
  engine.on('peers', () => send('peers', engine.listPeers()));
  engine.on('message', (message) => {
    send('message', message);
    if (message.dir === 'in') onIncoming(message);
  });
  engine.on('updated', (message) => send('updated', message));
  engine.on('warning', (warning) => console.warn(warning));
  registerIpc();
  createWindow();
  createTray();
  try {
    await engine.start();
    send('peers', engine.listPeers());
  } catch (err) {
    dialog.showErrorBox('Beacon could not start networking', err.message);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    quitting = true;
    if (!engine || engine.stopped) return;
    event.preventDefault();
    engine.stopped = true;
    engine.stop().catch(() => {}).finally(() => app.quit());
  });
  // The tray keeps the app running after its last window is hidden.
  app.on('window-all-closed', () => {
    // A signal or OS shutdown closes the windows and relies on this to finish exiting.
    if (quitting) app.quit();
  });
}
