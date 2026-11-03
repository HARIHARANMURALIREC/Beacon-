'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, handler) => ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('messenger', {
  platform: process.platform,
  state: () => ipcRenderer.invoke('state'),
  sendText: (conv, text) => ipcRenderer.invoke('send-text', conv, text),
  sendFile: (conv) => ipcRenderer.invoke('send-file', conv),
  acceptFile: (conv, id) => ipcRenderer.invoke('accept-file', conv, id),
  declineFile: (conv, id) => ipcRenderer.invoke('decline-file', conv, id),
  showFile: (conv, id) => ipcRenderer.invoke('show-file', conv, id),
  setActive: (conv) => ipcRenderer.invoke('set-active', conv),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  onPeers: (handler) => on('peers', handler),
  onMessage: (handler) => on('message', handler),
  onUpdated: (handler) => on('updated', handler),
  onUnread: (handler) => on('unread', handler),
  onOpenConversation: (handler) => on('open-conversation', handler),
});
