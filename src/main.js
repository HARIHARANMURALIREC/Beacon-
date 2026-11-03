'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } = require('electron');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Engine } = require('./core/engine');
const { Updater } = require('./core/updater');
const { macAppPath, canReplaceMacApp, installMacUpdate, removeUpdateLeftovers, startWindowsInstaller } = require('./core/install-update');
const UPDATE_KEY = require('./core/update-key');

const RELEASES_URL = 'https://github.com/HARIHARANMURALIREC/Beacon-/releases/latest';
const UPDATE_FEED = process.env.BEACON_UPDATE_FEED || `${RELEASES_URL}/download/`;
const FIRST_CHECK_MS = 15000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let engine;
let settings;
let tray;
let mainWindow;
let quitting = false;
const unread = {};
let activeConversation = null;
let updater;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const defaults = {
    name: os.userInfo().username,
    downloadDir: path.join(app.getPath('downloads'), 'Beacon'),
    targets: [],
    openAtLogin: false,
    group: '',
    away: false,
    awayText: 'I am away from my desk and will reply when I am back.',
    autoAccept: true,
    readReceipts: true,
    arrival: 'notify',
    sort: 'name',
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

function notificationText(message) {
  if (message.kind === 'file') return `Sent you ${message.file.folder ? 'a folder' : 'a file'}: ${message.file.name}`;
  if (message.kind === 'image') return 'Sent an image';
  if (message.locked) return 'Sent a locked message';
  if (message.sealed) return 'Sent a sealed message';
  return message.text.slice(0, 160);
}

function readActive() {
  if (activeConversation && mainWindow && mainWindow.isFocused()) engine.markRead(activeConversation);
}

function onIncoming(message) {
  const viewing = mainWindow && mainWindow.isFocused() && activeConversation === message.conv;
  if (viewing) {
    readActive();
    return;
  }
  unread[message.conv] = (unread[message.conv] || 0) + 1;
  updateBadge();
  send('unread', unread);
  if (settings.arrival === 'quiet') return;
  if (settings.arrival === 'popup') {
    showWindow();
    send('open-conversation', message.conv);
    return;
  }
  if (!Notification.isSupported()) return;
  const body = notificationText(message);
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
    readActive();
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

function updatePlatform() {
  return process.platform === 'win32' ? 'win32' : `${process.platform}-${process.arch}`;
}

function startUpdater() {
  updater = new Updater({
    currentVersion: app.getVersion(),
    platform: updatePlatform(),
    feedUrl: UPDATE_FEED,
    publicKey: UPDATE_KEY,
    dir: path.join(app.getPath('userData'), 'updates'),
  });
  updater.on('state', (state) => send('update-state', state));
  // Running from source has nothing to replace.
  if (!app.isPackaged) return;
  // The version being replaced may still be closing just after a restart.
  setTimeout(() => removeUpdateLeftovers(macAppPath(process.execPath)), 30000);
  setTimeout(() => updater.check(), FIRST_CHECK_MS);
  setInterval(() => updater.check(), CHECK_EVERY_MS).unref();
}

async function installUpdate() {
  const { status, file } = updater.state;
  if (status !== 'ready') throw new Error('No update is ready');
  if (process.platform === 'win32') {
    startWindowsInstaller(file, process.execPath);
    app.quit();
    return;
  }
  const appPath = macAppPath(process.execPath);
  if (!(await canReplaceMacApp(appPath))) {
    throw new Error('Move Beacon to your Applications folder, reopen it, then try again.');
  }
  await installMacUpdate(file, appPath);
  app.relaunch();
  app.quit();
}

function publicSettings() {
  return { ...settings, id: engine.id, port: engine.listenPort };
}

function registerIpc() {
  ipcMain.handle('state', () => ({
    settings: publicSettings(),
    peers: engine.listPeers(),
    messages: engine.store.data.messages,
    groups: engine.store.data.groups,
    unread,
    update: updater.state,
  }));
  ipcMain.handle('check-updates', () => updater.check());
  ipcMain.handle('install-update', () => installUpdate());
  ipcMain.handle('open-releases', () => shell.openExternal(RELEASES_URL));
  ipcMain.handle('send-text', (_event, conv, text, options) => {
    engine.sendText(conv, text, options);
  });
  ipcMain.handle('pick-and-send', async (_event, conv, type) => {
    const properties = type === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
    const result = await dialog.showOpenDialog(mainWindow, { properties });
    if (!result.canceled) for (const filePath of result.filePaths) await engine.offerFile(conv, filePath);
  });
  ipcMain.handle('send-paths', async (_event, conv, paths) => {
    for (const filePath of paths) await engine.offerFile(conv, filePath);
  });
  ipcMain.handle('send-image', (_event, conv, data) => {
    engine.sendImage(conv, Buffer.from(data));
  });
  ipcMain.handle('image-data', (_event, conv, id) => engine.imageData(conv, id));
  ipcMain.handle('create-group', (_event, name, members) => engine.createGroup(name, members).id);
  ipcMain.handle('open-sealed', (_event, conv, id) => engine.openSealed(conv, id));
  ipcMain.handle('unlock', (_event, conv, id, password) => engine.unlockMessage(conv, id, password));
  ipcMain.handle('accept-file', async (_event, conv, id) => {
    await engine.acceptFile(conv, id);
  });
  ipcMain.handle('decline-file', async (_event, conv, id) => {
    await engine.declineFile(conv, id);
  });
  ipcMain.handle('show-file', (_event, conv, id) => {
    const message = engine.store.findMessage(conv, id);
    if (message && message.file && message.file.savedPath) shell.showItemInFolder(message.file.savedPath);
    if (message && message.image) shell.showItemInFolder(message.image.path);
  });
  ipcMain.handle('set-active', (_event, conv) => {
    activeConversation = conv;
    delete unread[conv];
    updateBadge();
    readActive();
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
      group: String(next.group || '').trim().slice(0, 32),
      away: Boolean(next.away),
      awayText: String(next.awayText || '').slice(0, 1000),
      autoAccept: Boolean(next.autoAccept),
      readReceipts: Boolean(next.readReceipts),
      arrival: ['notify', 'popup', 'quiet'].includes(next.arrival) ? next.arrival : 'notify',
      sort: ['name', 'group', 'ip'].includes(next.sort) ? next.sort : settings.sort,
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
    engine.name = settings.name;
    engine.downloadDir = settings.downloadDir;
    engine.targets = targets;
    engine.configure(settings);
    engine.flushOutbox();
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
    group: settings.group,
    away: settings.away,
    awayText: settings.awayText,
    autoAccept: settings.autoAccept,
    readReceipts: settings.readReceipts,
    // Tests use their own port so their fake names never reach real copies on the network.
    udpPort: process.env.BEACON_UDP_PORT ? Number(process.env.BEACON_UDP_PORT) : undefined,
  });
  engine.on('peers', () => send('peers', engine.listPeers()));
  engine.on('groups', () => send('groups', engine.store.data.groups));
  engine.on('message', (message) => {
    send('message', message);
    if (message.dir === 'in') onIncoming(message);
  });
  engine.on('updated', (message) => send('updated', message));
  engine.on('warning', (warning) => console.warn(warning));
  startUpdater();
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
