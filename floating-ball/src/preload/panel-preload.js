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
  // R4：课程上下文（R1 阶段 2）+ 问答回推落库
  setCourse: (courseId) => ipcRenderer.invoke('course:set', { courseId }),
  pushAsk: (payload) => ipcRenderer.invoke('app:pushAsk', payload),
  // R5：关联知识点（查 = 只读；存 = 由用户确认后才发）
  relateSearch: (text) => ipcRenderer.invoke('relate:search', { text }),
  relateSave: (payload) => ipcRenderer.invoke('relate:save', payload),
  // R5.2：主动向主程序要课程列表（面板打开时 / 点开下拉时调用）
  requestCourses: () => ipcRenderer.invoke('courses:request'),

  onTaskChunk: (cb) => ipcRenderer.on('task:chunk', (_e, p) => cb(p)),
  onTaskDone: (cb) => ipcRenderer.on('task:done', (_e, p) => cb(p)),
  onTaskError: (cb) => ipcRenderer.on('task:error', (_e, p) => cb(p)),
  onSelectionResult: (cb) => ipcRenderer.on('selection:result', (_e, t) => cb(t)),
  onApplyTheme: (cb) => ipcRenderer.on('apply-theme', (_e, theme) => cb(theme)),
  onExternalRunTask: (cb) => ipcRenderer.on('external:runTask', (_e, p) => cb(p)),
  onMaterialResult: (cb) => ipcRenderer.on('material:result', (_e, p) => cb(p)),
  onConfigSynced: (cb) => ipcRenderer.on('config:synced', (_e, p) => cb(p)),
  // R4：主程序下发的课程列表与当前课程
  onCourses: (cb) => ipcRenderer.on('courses:sync', (_e, p) => cb(p)),
  // R5：主程序回传的关联检索结果 / 知识点入库结果
  onRelateResult: (cb) => ipcRenderer.on('relate:result', (_e, p) => cb(p)),
  onRelateSaved: (cb) => ipcRenderer.on('relate:saved', (_e, p) => cb(p))
});
