// 气泡预加载
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleApi', {
  onText: (cb) => ipcRenderer.on('bubble:text', (_e, t) => cb(t)),
  onHide: (cb) => ipcRenderer.on('bubble:hide', () => cb())
});
