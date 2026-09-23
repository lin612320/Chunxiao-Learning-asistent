// 悬浮球预加载：点击/拖动/悬停/皮肤
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ballApi', {
  click: () => ipcRenderer.send('ball:click'),
  // 拖动改为由主进程轮询光标移动窗口，渲染层只负责开始/结束与动画
  startDrag: () => ipcRenderer.send('ball:start-drag'),
  stopDrag: () => ipcRenderer.send('ball:stop-drag'),
  // 悬停对话气泡
  hover: () => ipcRenderer.send('ball:enter'),
  leave: () => ipcRenderer.send('ball:leave'),
  // 文本拖入悬浮球（手动抓取模式）
  dropText: (text) => ipcRenderer.send('ball:drop-text', text),
  // 接收完整皮肤对象（含 pet 桌宠配置）
  onSkin: (cb) => {
    const handler = (_e, skin) => cb(skin);
    ipcRenderer.on('apply-skin', handler);
    return () => ipcRenderer.removeListener('apply-skin', handler);
  }
});
