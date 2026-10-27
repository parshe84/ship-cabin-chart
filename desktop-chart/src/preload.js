'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ship', {
  onFix: (cb) => ipcRenderer.on('fix', (_e, fix) => cb(fix)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, p) => cb(p)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  loadTrack: () => ipcRenderer.invoke('load-track'),
  saveTrack: (t) => ipcRenderer.invoke('save-track', t),
  downloadArea: (opts) => ipcRenderer.invoke('download-area', opts),
});
