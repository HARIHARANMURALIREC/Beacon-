'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, handler) => ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('messenger', {
  platform: process.platform,
  state: () => ipcRenderer.invoke('state'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  sendText: (conv, text, options) => ipcRenderer.invoke('send-text', conv, text, options),
  pickAndSend: (conv, type) => ipcRenderer.invoke('pick-and-send', conv, type),
  sendPaths: (conv, paths) => ipcRenderer.invoke('send-paths', conv, paths),
  sendImage: (conv, data) => ipcRenderer.invoke('send-image', conv, data),
  imageData: (conv, id) => ipcRenderer.invoke('image-data', conv, id),
  createGroup: (name, members) => ipcRenderer.invoke('create-group', name, members),
  openSealed: (conv, id) => ipcRenderer.invoke('open-sealed', conv, id),
  unlock: (conv, id, password) => ipcRenderer.invoke('unlock', conv, id, password),
  acceptFile: (conv, id) => ipcRenderer.invoke('accept-file', conv, id),
  declineFile: (conv, id) => ipcRenderer.invoke('decline-file', conv, id),
  showFile: (conv, id) => ipcRenderer.invoke('show-file', conv, id),
  setActive: (conv) => ipcRenderer.invoke('set-active', conv),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onPeers: (handler) => on('peers', handler),
  onGroups: (handler) => on('groups', handler),
  onMessage: (handler) => on('message', handler),
  onUpdated: (handler) => on('updated', handler),
  onUnread: (handler) => on('unread', handler),
  onOpenConversation: (handler) => on('open-conversation', handler),
});
