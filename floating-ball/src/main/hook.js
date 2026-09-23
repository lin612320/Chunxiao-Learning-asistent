// 全局鼠标钩子：监听鼠标抬起，判断为"选取"时回调（用于选取即自动抓取）
// 依赖 uiohook-napi；若不可用则优雅降级，不影响其他功能
let uIOhook = null;
try {
  uIOhook = require('uiohook-napi').uIOhook;
} catch (e) {
  console.log('[hook] uiohook-napi 不可用:', e && e.message ? e.message : e);
}

let lastDown = null;
let armed = false;
let started = false;

function start(onSelect) {
  if (!uIOhook || started) return;
  try {
    uIOhook.on('mousedown', (e) => {
      lastDown = { x: e.x, y: e.y, t: Date.now() };
    });
    uIOhook.on('mouseup', (e) => {
      if (!lastDown) return;
      const dx = Math.abs(e.x - lastDown.x);
      const dy = Math.abs(e.y - lastDown.y);
      lastDown = null;
      // 只有发生明显拖动（选取）才触发，避免普通点击误触发
      if (dx < 6 && dy < 6) return;
      if (!armed) return;
      onSelect();
    });
    uIOhook.start();
    started = true;
  } catch (err) {
    console.log('[hook] start 失败:', err && err.message ? err.message : err);
  }
}

function setArmed(v) { armed = v; }
function getArmed() { return armed; }
function available() { return !!uIOhook; }

function stop() {
  if (uIOhook && started) {
    try { uIOhook.stop(); } catch {}
    started = false;
  }
}

module.exports = { start, stop, setArmed, getArmed, available };
