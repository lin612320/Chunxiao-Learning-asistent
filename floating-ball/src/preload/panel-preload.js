// 小窗预加载
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  grabSelection: () => ipcRenderer.invoke('selection:grab'),
  runTask: (kind, opts, id) => ipcRenderer.send('task:run', { kind, opts, id }),
  stopTask: () => ipcRenderer.send('task:stop'),
  setSkin: (skinId) => ipcRenderer.send('skin:set', skinId),
  setTheme: (themeId) => ipcRenderer.send('theme:set', themeId),
  openSkinPicker: () => ipcRenderer.send('skin-picker:open'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  quitApp: () => ipcRenderer.send('app:quit'),
  move: (dx, dy) => ipcRenderer.send('panel:move', { dx, dy }),
  testKey: (cfg) => ipcRenderer.invoke('ai:testKey', cfg),
  pushToApp: (text, action) => ipcRenderer.invoke('app:push', { text, action }),
  askMaterialSearch: (text) => ipcRenderer.invoke('material:ask', { text }),

  onTaskChunk: (cb) => ipcRenderer.on('task:chunk', (_e, p) => cb(p)),
  onTaskDone: (cb) => ipcRenderer.on('task:done', (_e, p) => cb(p)),
  onTaskError: (cb) => ipcRenderer.on('task:error', (_e, p) => cb(p)),
  onSelectionResult: (cb) => ipcRenderer.on('selection:result', (_e, t) => cb(t)),
  onApplyTheme: (cb) => ipcRenderer.on('apply-theme', (_e, theme) => cb(theme)),
  onExternalRunTask: (cb) => ipcRenderer.on('external:runTask', (_e, p) => cb(p)),
  onMaterialResult: (cb) => ipcRenderer.on('material:result', (_e, p) => cb(p)),
  onConfigSynced: (cb) => ipcRenderer.on('config:synced', (_e, p) => cb(p))
});
