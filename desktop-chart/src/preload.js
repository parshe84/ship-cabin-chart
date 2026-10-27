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
  loadWorldLayer: (name) => ipcRenderer.invoke('load-world-layer', name),
  exportGpx: (track) => ipcRenderer.invoke('export-gpx', track),
  exportRouteGpx: (waypoints) => ipcRenderer.invoke('export-route-gpx', waypoints),
  loadRoute: () => ipcRenderer.invoke('load-route'),
  saveRoute: (route) => ipcRenderer.invoke('save-route', route),
  downloadArea: (opts) => ipcRenderer.invoke('download-area', opts),
});
