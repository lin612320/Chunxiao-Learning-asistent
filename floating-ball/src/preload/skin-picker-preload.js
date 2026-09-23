const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setSkin: (id) => ipcRenderer.send('skin:set', id),
  close: () => ipcRenderer.send('skin-picker:close'),
  move: (dx, dy) => ipcRenderer.send('skin-picker:move', { dx, dy }),
  onApplySkin: (cb) => ipcRenderer.on('apply-skin', (_e, id) => cb(id))
});
