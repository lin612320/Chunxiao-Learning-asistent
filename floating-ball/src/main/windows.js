// 窗口管理：悬浮球 + 小窗 + 桌宠气泡 + 皮肤选择窗口
const { BrowserWindow, screen, shell, Menu } = require('electron');
const path = require('path');
const { getBallSkin, getPanelTheme } = require('./skins');

// 编辑菜单（用于透明无边框窗口内支持 Ctrl+C/V/X/A）
function buildEditMenu() {
  return Menu.buildFromTemplate([
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' }
  ]);
}

let ballWin = null;
let panelWin = null;
let bubbleWin = null;
let skinPickerWin = null;
let panelVisible = false;

// R5：面板**可以缩放**了（旧版把最小=最大写成固定值，是"不能缩放"的根因）。
//   边界值放在这里，主进程与渲染层都不再各自写一遍。
const PANEL_MIN_W = 360;
// R5.1：最小高度从 420 提到 460 —— 420 时结果区只剩 ~36px（仅够一行），
// 而"两个框 + 两个按钮"是硬需求、不能压缩，只能给结果区留出这点位置。
// 460 起结果区有 ~76px，能看清标题与首句。
const PANEL_MIN_H = 460;
const PANEL_MAX_W = 900;
const PANEL_MAX_H = 1200;

let onPanelResize = null;
/** 由 main.js 注入：把用户调过的尺寸落盘（config.panelWidth/Height） */
function setPanelResizeHandler(fn) { onPanelResize = fn; }

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// 尺寸“看门狗”。
//   · 悬浮球：**尺寸硬锁**（56×56）—— 任何途径改大都在 800ms 内拉回；
//   · 面板：R5 起改为**钳制**（只在越界时拉回）—— 用户拖动边框缩放**被允许**，
//     但仍挡住 Windows/Aero Snap 把窗口顶到越界尺寸那类"越拖越大"。
let sizeWatchdog = null;
function ensureBallSize(win) {
  if (!win || win.isDestroyed() || win._fixedW == null || win._fixedH == null) return;
  const [cw, ch] = win.getSize();
  if (cw !== win._fixedW || ch !== win._fixedH) {
    win.setSize(win._fixedW, win._fixedH, false);
  }
}
function clampPanelSize(win) {
  if (!win || win.isDestroyed() || win._minW == null) return;
  const [cw, ch] = win.getSize();
  const nw = Math.min(win._maxW, Math.max(win._minW, cw));
  const nh = Math.min(win._maxH, Math.max(win._minH, ch));
  if (nw !== cw || nh !== ch) win.setSize(nw, nh, false);
}
function startSizeWatchdog() {
  if (sizeWatchdog) return;
  sizeWatchdog = setInterval(() => {
    ensureBallSize(ballWin);
    clampPanelSize(panelWin);
  }, 800);
}
function stopSizeWatchdog() {
  if (sizeWatchdog) { clearInterval(sizeWatchdog); sizeWatchdog = null; }
}

function getBall() { return ballWin; }
function getPanel() { return panelWin; }
function getBubble() { return bubbleWin; }
function getSkinPicker() { return skinPickerWin; }
function isPanelVisible() { return panelVisible; }

// 把渲染层 console / preload 错误转发到 stdout，便于诊断
function attachLog(win, tag) {
  if (!win) return;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[${tag}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, error) => {
    console.log(`[${tag} preload-error] ${error && error.message ? error.message : String(error)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[${tag} did-fail-load] ${code} ${desc}`);
  });
}

function createBall(config, onBallClick) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const size = 56;
  let x = Math.round(sw - size - 24);
  let y = Math.round(sh - size - 24);
  if (config.ballPos) { x = config.ballPos.x; y = config.ballPos.y; }

  ballWin = new BrowserWindow({
    width: size, height: size, x, y,
    frame: false, transparent: true, resizable: false,
    maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ball-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWin.setAlwaysOnTop(true, 'floating');
  // 硬性锁定悬浮球窗口尺寸：最小 = 最大 = 56×56，
  // 防止系统在拖动 / 靠边吸附（Aero Snap）等情况下把窗口改大（“越拖越大”）。
  ballWin.setMinimumSize(size, size);
  ballWin.setMaximumSize(size, size);
  ballWin.setResizable(false);
  const enforceBallSize = () => {
    if (!ballWin || ballWin.isDestroyed()) return;
    const [w, h] = ballWin.getSize();
    if (w !== size || h !== size) ballWin.setSize(size, size, false);
  };
  ballWin.on('resize', enforceBallSize);
  ballWin.on('resized', enforceBallSize);
  ballWin._fixedW = size;
  ballWin._fixedH = size;
  startSizeWatchdog();
  ballWin.loadFile(path.join(__dirname, '..', 'renderer', 'ball.html'));
  attachLog(ballWin, 'ball');

  // 悬浮球右键菜单：隐藏 / 退出
  ballWin.webContents.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { label: '隐藏悬浮球', click: () => { hideBall(); } },
      { type: 'separator' },
      { label: '退出应用', click: () => { require('./main').quitApp(); } }
    ]).popup({ window: ballWin, x: params.x, y: params.y });
  });

  ballWin.once('ready-to-show', () => { ballWin.show(); applySkinToBall(config); });
  ballWin.on('moved', () => {
    const b = ballWin.getBounds();
    config.ballPos = { x: b.x, y: b.y };
    enforceBallSize(); // 任何移动结束后都复核尺寸
  });
  ballWin._onBallClick = onBallClick;
  return ballWin;
}

function createBubble() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  bubbleWin = new BrowserWindow({
    width: 220, height: 80, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bubble-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWin.setAlwaysOnTop(true, 'floating');
  bubbleWin.setIgnoreMouseEvents(true, { forward: false });
  bubbleWin.loadFile(path.join(__dirname, '..', 'renderer', 'bubble.html'));
  attachLog(bubbleWin, 'bubble');
  return bubbleWin;
}

function showBubble(text) {
  if (!bubbleWin) createBubble();
  if (!ballWin || ballWin.isDestroyed()) return;
  const b = ballWin.getBounds();
  const BW = 220, BH = 80;
  let x = b.x + b.width / 2 - BW / 2;
  let y = b.y - BH - 8;
  if (y < 4) y = b.y + b.height + 8;
  const sw = screen.getPrimaryDisplay().size.width;
  x = Math.max(4, Math.min(x, sw - BW - 4));
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: BW, height: BH });
  bubbleWin.webContents.send('bubble:text', text);
  if (!bubbleWin.isVisible()) bubbleWin.showInactive();
}

function hideBubble() {
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('bubble:hide');
    bubbleWin.hide();
  }
}

function updateBubblePosition() {
  if (!bubbleWin || !ballWin || bubbleWin.isDestroyed() || ballWin.isDestroyed()) return;
  if (!bubbleWin.isVisible()) return;
  const b = ballWin.getBounds();
  const BW = 220, BH = 80;
  let x = b.x + b.width / 2 - BW / 2;
  let y = b.y - BH - 8;
  if (y < 4) y = b.y + b.height + 8;
  const sw = screen.getPrimaryDisplay().size.width;
  x = Math.max(4, Math.min(x, sw - BW - 4));
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: BW, height: BH });
}

function createPanel(config) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const w = clampNum(config.panelWidth, PANEL_MIN_W, PANEL_MAX_W, 420);
  // 上限跟着屏幕走：小屏上"最高 1200"会顶出工作区，用户就再也拖不回来了
  const maxH = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, workArea.height - 40));
  const h = clampNum(config.panelHeight, PANEL_MIN_H, maxH, Math.min(620, maxH));
  panelWin = new BrowserWindow({
    width: w, height: h,
    x: Math.max(8, workArea.x + 16),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - h) / 2)),
    frame: false, transparent: true, resizable: true,
    minWidth: PANEL_MIN_W, minHeight: PANEL_MIN_H,
    maxWidth: PANEL_MAX_W, maxHeight: maxH,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  // R5：可缩放。旧实现 `setMinimumSize(w,h)=setMaximumSize(w,h)` 把窗口钉死，
  //     是"面板不能调大小"的直接原因；现在只给出上下限，并用看门狗钳制越界。
  panelWin.setMinimumSize(PANEL_MIN_W, PANEL_MIN_H);
  panelWin.setMaximumSize(PANEL_MAX_W, maxH);
  panelWin._minW = PANEL_MIN_W;
  panelWin._minH = PANEL_MIN_H;
  panelWin._maxW = PANEL_MAX_W;
  panelWin._maxH = maxH;
  // 改尺寸后 400ms 防抖落盘。`_suppressSave` 用于程序自身的收起/展开——
  // 收起态高度（64）绝不能被当成"用户想要的展开高度"存下来。
  let saveTimer = null;
  panelWin.on('resized', () => {
    if (!panelWin || panelWin.isDestroyed()) return;
    if (panelWin._suppressSave) return;
    const [cw, ch] = panelWin.getSize();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (onPanelResize) onPanelResize(cw, ch);
    }, 400);
  });
  panelWin.on('closed', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    panelWin = null;
    panelVisible = false;
  });
  startSizeWatchdog();
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  attachLog(panelWin, 'panel');
  // 透明无边框窗口需要显式注册编辑菜单，否则 Ctrl+C/V 不工作
  panelWin.webContents.on('context-menu', (_e, params) => {
    buildEditMenu().popup({ window: panelWin, x: params.x, y: params.y });
  });
  panelWin.webContents.on('before-input-event', (e, input) => {
    if (!input.alt && !input.shift && (input.control || input.meta) && !input.suggested) {
      if (input.type === 'keyDown') {
        const wc = panelWin.webContents;
        if (input.key === 'a') wc.selectAll();
        else if (input.key === 'c') wc.copy();
        else if (input.key === 'v') wc.paste();
        else if (input.key === 'x') wc.cut();
      }
    }
  });
  panelWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return panelWin;
}

function showPanel(config) {
  if (!panelWin) createPanel(config);
  panelVisible = true;
  panelWin.show(); panelWin.focus();
  applySkinToPanel(config);
  return panelWin;
}
function hidePanel() { if (panelWin) { panelVisible = false; panelWin.hide(); } }
function togglePanel(config) { if (panelVisible) hidePanel(); else showPanel(config); }

// 皮肤选择窗口（悬浮球独立皮肤页面）
function createSkinPicker(config) {
  if (skinPickerWin && !skinPickerWin.isDestroyed()) {
    skinPickerWin.show(); skinPickerWin.focus();
    skinPickerWin.webContents.send('apply-skin', config.skin);
    return skinPickerWin;
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  skinPickerWin = new BrowserWindow({
    width: 480, height: 520,
    x: Math.round(workArea.x + workArea.width / 2 - 240),
    y: Math.round(workArea.y + workArea.height / 2 - 260),
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'skin-picker-preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  skinPickerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  skinPickerWin.setAlwaysOnTop(true, 'floating');
  skinPickerWin.loadFile(path.join(__dirname, '..', 'renderer', 'skin-picker.html'));
  attachLog(skinPickerWin, 'skin-picker');
  skinPickerWin.once('ready-to-show', () => {
    skinPickerWin.show(); skinPickerWin.focus();
    skinPickerWin.webContents.send('apply-skin', config.skin);
  });
  skinPickerWin.on('closed', () => { skinPickerWin = null; });
  return skinPickerWin;
}

// 应用球皮肤
function applySkinToBall(config) {
  if (ballWin && !ballWin.isDestroyed()) {
    const skin = getBallSkin(config.skin);
    ballWin.webContents.send('apply-skin', skin);
  }
}

// 应用面板主题（深色/白色）
function applySkinToPanel(config) {
  if (panelWin && !panelWin.isDestroyed()) {
    const theme = getPanelTheme(config.theme || 'dark');
    panelWin.webContents.send('apply-theme', theme);
  }
}

function sendToPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

function destroyAll() {
  stopSizeWatchdog();
  if (bubbleWin) bubbleWin.destroy();
  if (skinPickerWin) skinPickerWin.destroy();
  if (panelWin) panelWin.destroy();
  if (ballWin) ballWin.destroy();
  bubbleWin = skinPickerWin = panelWin = ballWin = null;
  panelVisible = false;
}

function hideBall() {
  if (ballWin) ballWin.hide();
  hideBubble();
  hidePanel();
}
function showBall(config) {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.show();
    // 如果面板已存在，一起显示；不存在时不设置 panelVisible（等点击球时创建）
    if (panelWin && !panelWin.isDestroyed()) {
      panelVisible = true;
      panelWin.show();
      panelWin.focus();
    }
  }
}

module.exports = {
  createBall, createBubble, createPanel, createSkinPicker,
  showPanel, hidePanel, togglePanel,
  setPanelResizeHandler,
  PANEL_MIN_W, PANEL_MIN_H, PANEL_MAX_W,
  showBall, hideBall,
  applySkinToBall, applySkinToPanel,
  sendToPanel, showBubble, hideBubble, updateBubblePosition,
  getBall, getPanel, getBubble, getSkinPicker,
  isPanelVisible, destroyAll
};
