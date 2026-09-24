// 主进程入口
const { app, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { load, save } = require('./config');
const { getSkin, listBallSkins, getPanelTheme, listPanelThemes, getBallSkin } = require('./skins');
const windows = require('./windows');
const { grabSelection } = require('./selection');
const { runTask, normalizeBaseURL, httpFetchWithHint } = require('./ai');
const hook = require('./hook');

// 版本号（托盘悬浮提示可确认运行的是哪一版，便于排查“旧进程仍在跑”的假修复）
let appVersion = '';
try { appVersion = require('../../package.json').version || ''; } catch (e) { appVersion = ''; }

// 共享桥接文件路径（%APPDATA%/chunxiao-ball/from-ball.json）
const BRIDGE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'chunxiao-ball');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'from-ball.json');
// 春晓 → 悬浮球 控制文件（反向通道）
const CTRL_FILE = path.join(BRIDGE_DIR, 'to-ball.json');
// 春晓学习助手项目路径（用于 spawn Tauri dev 进程）
// chunxiao-ball 放在 Legal-Workspace 内部，main.js 往上 3 级就是根
const WORKBENCH_DIR = path.resolve(__dirname, '..', '..', '..');

let config = null;
let tray = null;
let currentController = null;
let dragTimer = null; // 悬浮球拖动轮询定时器

// 单实例锁：父项目启动时若已存在，则直接唤起面板
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二个实例需要把命令行参数透传给已运行实例
  // Electron 在 Windows 上 second-instance 会自动触发，
  // 这里快速退出即可（app.exit 强制退出，避免残留进程）
  app.exit(0);
}

// 解析命令行参数
// 开发态 argv = [electron.exe, app目录, --child, ...]；打包态 argv = [春晓助手.exe, --child, ...]
// 直接扫描全部参数、只识别已知标志，两种模式都兼容
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === '--child') out.child = true;
    else if (a === '--dev') out.dev = true;
    else if (a.startsWith('--cmd=')) out.cmd = a.slice(6);
    else if (a.startsWith('--prefill=')) out.prefill = decodeURIComponent(a.slice(10));
    else if (a.startsWith('--run=')) {
      try { out.run = JSON.parse(decodeURIComponent(a.slice(6))); } catch {}
    }
  }
  return out;
}

app.on('second-instance', (_e, argv) => {
  const args = parseArgs(argv);
  // 优先级：run > prefill > cmd
  if (args.run && typeof args.run === 'object') {
    const { kind, opts } = args.run;
    if (['relate', 'ask'].includes(kind)) {
      windows.showPanel(config);
      windows.sendToPanel('selection:result', opts.text || opts.question || '');
      // 通知面板直接跑任务（通过 IPC：向已打开面板注入 startTask）
      windows.sendToPanel('external:runTask', { kind, opts });
    }
  } else if (args.prefill !== undefined) {
    windows.showPanel(config);
    windows.sendToPanel('selection:result', args.prefill);
  } else if (args.cmd === 'show') {
    windows.showPanel(config);
  } else if (args.cmd === 'hide') {
    windows.hidePanel();
  } else if (args.cmd === 'quit') {
    windows.destroyAll();
    app.quit();
  } else {
    // 默认行为：显示小窗
    windows.showPanel(config);
  }
});

function registerHotkey() {
  // 先注销旧的，再注册当前配置的快捷键
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(config.hotkey, async () => {
      const text = await grabSelection();
      windows.showPanel(config);
      windows.sendToPanel('selection:result', text);
      // R5.2：热键也是"打开面板"的一条路径 —— 同样要把课程列表要一次
      requestCourses();
    });
  } catch (e) {
    console.error('注册快捷键失败:', e);
  }
}

// 抓取模式切换：钩子常驻运行（start 幂等），只用 armed 控制是否触发。
// 不用 hook.stop()/start()——uiohook-napi 停止后再次 start 经常挂不回，
// 导致切回自动模式时抓取静默失效。
let hookSelectCb = null;
function applyGrabMode() {
  if (!hookSelectCb) {
    hookSelectCb = async () => {
      await new Promise((r) => setTimeout(r, 150));
      const text = await grabSelection();
      if (text) {
        windows.showPanel(config);
        windows.sendToPanel('selection:result', text);
      }
    };
    hook.start(hookSelectCb);
  }
  const manual = config.grabMode === 'manual';
  hook.setArmed(!manual);
  console.log('[hook] 抓取模式：', manual ? '手动拖入（自动抓取关闭）' : '自动抓取');
}

function setupTray() {
  // 系统托盘图标：用 1x1 透明 + 文字兜底太麻烦，这里用 nativeImage 创建简易图标
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = nativeImage.createEmpty();
  } catch {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  const menu = Menu.buildFromTemplate([
    { label: '显示悬浮球', click: () => { windows.showBall(config); requestCourses(); } },
    { label: '隐藏悬浮球', click: () => windows.hideBall() },
    { type: 'separator' },
    { label: '抓取选中文字', click: async () => {
      const t = await grabSelection();
      windows.showBall(config);
      windows.showPanel(config);
      windows.sendToPanel('selection:result', t);
      requestCourses();
    }},
    { type: 'separator' },
    { label: '退出', click: () => { quitApp(); } }
  ]);
  tray.setToolTip(`春晓助手 ${appVersion}`);
  tray.setContextMenu(menu);
  // 托盘双击：显示悬浮球（同样顺手要一次课程列表）
  tray.on('double-click', () => { windows.showBall(config); requestCourses(); });
}

function quitApp() {
  windows.destroyAll();
  app.quit();
}

module.exports = { quitApp };

function registerIpc() {
  // 悬浮球点击：切换面板（打开时顺手把课程列表要一次 —— 见 R5.2）
  ipcMain.on('ball:click', () => {
    windows.togglePanel(config);
    if (windows.isPanelVisible()) requestCourses();
  });

  // 拖文字到悬浮球（手动抓取模式的主要入口）
  ipcMain.on('ball:drop-text', (_e, text) => {
    if (typeof text === 'string' && text.trim()) {
      windows.showPanel(config);
      windows.sendToPanel('selection:result', text.trim());
    }
  });

  // 悬浮球拖动：主进程轮询光标移动窗口（可跨越窗口边界）。
  // 修复：位移以“起始位置 + 光标增量”计算（不做累计叠加），并钳制在主屏工作区内，
  // 避免拖拽过程出现漂移 / 越拖越偏 / 拖出屏外后“异常放大”等观感问题。
  ipcMain.on('ball:start-drag', () => {
    const ball = windows.getBall();
    if (!ball || ball.isDestroyed()) return;
    // 拖动时隐藏对话气泡（按需求：拖动不弹对话）
    windows.hideBubble();
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    const start = screen.getCursorScreenPoint();
    const [baseX, baseY] = ball.getPosition();
    const size = 56; // 与 windows.js createBall 保持一致
    const work = screen.getPrimaryDisplay().workArea;
    const minX = work.x;
    const minY = work.y;
    const maxX = work.x + work.width - size;
    const maxY = work.y + work.height - size;
    dragTimer = setInterval(() => {
      if (ball.isDestroyed()) {
        if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
        return;
      }
      const cur = screen.getCursorScreenPoint();
      const nx = Math.max(minX, Math.min(baseX + (cur.x - start.x), maxX));
      const ny = Math.max(minY, Math.min(baseY + (cur.y - start.y), maxY));
      ball.setPosition(Math.round(nx), Math.round(ny));
      // 拖动过程中持续复核尺寸（防御 Windows 拖动/吸附改窗口大小导致的“越拖越大”）
      const [cw, ch] = ball.getSize();
      if (cw !== size || ch !== size) ball.setSize(size, size, false);
    }, 16);
  });
  ipcMain.on('ball:stop-drag', () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  });

  // 桌宠悬停对话气泡
  ipcMain.on('ball:enter', () => {
    const skin = getSkin(config.skin);
    const lines = (skin.pet && skin.pet.dialogues) || ['你好~'];
    const text = lines[Math.floor(Math.random() * lines.length)];
    windows.showBubble(text);
  });
  ipcMain.on('ball:leave', () => windows.hideBubble());

  // 小窗顶栏拖动：按位移移动窗口（仅移动并钳制在主屏内，避免拖出后“找不回”）
  //   R5：面板已经可以缩放了，但**拖顶栏不能被当成缩放** —— 旧版正是这样"越拖越大"的。
  //   做法：每次拖动前后都复核尺寸，变了就还原成拖动前的值（拖动路径上尺寸必须恒定；
  //   真正的缩放走窗口边框，不会触发本 IPC）。
  ipcMain.on('panel:move', (_e, { dx, dy }) => {
    const panel = windows.getPanel();
    if (!panel || panel.isDestroyed()) return;
    const [x, y] = panel.getPosition();
    const [pw, ph] = panel.getSize();
    const wa = screen.getPrimaryDisplay().workArea;
    const nx = Math.max(wa.x - pw + 80, Math.min(x + dx, wa.x + wa.width - 80));
    const ny = Math.max(wa.y, Math.min(y + dy, wa.y + wa.height - 42));
    panel.setPosition(Math.round(nx), Math.round(ny));
    const [aw, ah] = panel.getSize();
    if (aw !== pw || ah !== ph) panel.setSize(pw, ph, false);
  });

  // R4：课程上下文缓存（R1 阶段 2）。
  //   **单一事实来源在主程序**（`settings.ball.course_id`），这里只是镜像：
  //   主程序随 show / prefill 下发，球改动后回写，重启后仍以主程序为准。
  const courseCache = { courses: [], courseId: null };

  // R5：「关联知识点」第一步 —— **只查不写**。
  //   与「材料」按钮同一形状：球只负责发起，检索由主程序在本机执行，结果经 to-ball.json 回传。
  ipcMain.handle('relate:search', (_e, { text }) => {
    return writeBridge({
      text: text || '',
      action: 'relate_search',
      course_id: courseCache.courseId
    });
  });

  // R5：「关联知识点」第三步 —— 用户确认后**才**提交入库。
  //   ⚠ 只有用户点了「加入本课知识点」才会走到这里；球的任何自动行为都不许调用它。
  ipcMain.handle('relate:save', (_e, { courseId, items, sourceRef }) => {
    if (courseId == null) {
      return { ok: false, error: '请先在面板上选一门课程：知识点必须归属到某门课。' };
    }
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: '没有要加入的知识点。' };
    }
    return writeBridge({
      text: '',
      action: 'relate_save',
      course_id: Number(courseId),
      items,
      source_ref: sourceRef || ''
    });
  });

  // 获取状态（配置 + 皮肤列表 + 主题列表 + 课程上下文）
  ipcMain.handle('state:get', () => ({
    config,
    skins: listBallSkins(),
    themes: listPanelThemes(),
    courses: courseCache.courses,
    courseId: courseCache.courseId
  }));

  // R5.2：面板主动要课程列表（面板打开时 / 点开下拉时调用）
  ipcMain.handle('courses:request', () => requestCourses());

  // 抓取选中文字
  ipcMain.handle('selection:grab', async () => {
    const t = await grabSelection();
    return t;
  });

  // 运行 AI 任务（流式）
  ipcMain.on('task:run', async (_evt, payload) => {
    const { kind, opts, id } = payload;
    if (currentController) currentController.abort();
    currentController = new AbortController();
    try {
      await runTask(config, kind, opts, (chunk) => {
        windows.sendToPanel('task:chunk', { id, chunk });
      }, currentController.signal);
      windows.sendToPanel('task:done', { id });
    } catch (e) {
      if (e.name === 'AbortError') {
        windows.sendToPanel('task:done', { id, aborted: true });
      } else {
        windows.sendToPanel('task:error', { id, message: String(e.message || e) });
      }
    } finally {
      if (currentController?.signal?.aborted || currentController) {
        currentController = null;
      }
    }
  });

  // 中止当前任务
  ipcMain.on('task:stop', () => {
    if (currentController) currentController.abort();
  });

  // 切换球皮肤
  ipcMain.on('skin:set', (_evt, skinId) => {
    if (!getBallSkin(skinId)) return;
    config.skin = skinId;
    save(config);
    windows.applySkinToBall(config);
    // 同步皮肤选择窗口的选中态（如果已打开）
    const sp = windows.getSkinPicker();
    if (sp && !sp.isDestroyed()) sp.webContents.send('apply-skin', skinId);
  });

  // 打开球皮肤选择窗口
  ipcMain.on('skin-picker:open', () => windows.createSkinPicker(config));
  ipcMain.on('skin-picker:close', () => {
    const sp = windows.getSkinPicker();
    if (sp && !sp.isDestroyed()) sp.close();
  });
  // 皮肤选择窗口拖动
  ipcMain.on('skin-picker:move', (_e, { dx, dy }) => {
    const sp = windows.getSkinPicker();
    if (!sp || sp.isDestroyed()) return;
    const [x, y] = sp.getPosition();
    sp.setPosition(x + dx, y + dy);
  });

  // 切换面板主题
  ipcMain.on('theme:set', (_evt, themeId) => {
    if (!getPanelTheme(themeId)) return;
    config.theme = themeId;
    save(config);
    windows.applySkinToPanel(config);
  });

  // AI Key 测试：调 /models 端点验证 key 是否有效（用 normalizeBaseURL 和实际请求一致）
  // 用 Electron net.fetch（Chromium 网络栈），与正式请求一致地走系统代理
  ipcMain.handle('ai:testKey', async (_evt, { baseURL, apiKey }) => {
    try {
      const url = `${normalizeBaseURL(baseURL)}/models`;
      const res = await httpFetchWithHint(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (res.ok) return { ok: true, message: '✓ Key 有效，AI 可正常使用' };
      const body = await res.text().catch(() => '');
      let msg = `✗ 请求失败 (${res.status})`;
      try {
        const j = JSON.parse(body);
        if (j.error?.message) msg += `: ${j.error.message}`;
      } catch { if (body) msg += `: ${body.slice(0, 200)}`; }
      return { ok: false, message: msg };
    } catch (e) {
      return { ok: false, message: `✗ ${e.message || e}` };
    }
  });

  // 保存配置（深合并）
  ipcMain.handle('config:save', (_evt, patch) => {
    function dm(t, s) {
      for (const k of Object.keys(s)) {
        if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
          t[k] = dm(t[k] || {}, s[k]);
        } else { t[k] = s[k]; }
      }
      return t;
    }
    dm(config, patch);
    // 自动规范化 baseURL（防用户误填网页地址）
    if (config.ai?.baseURL) {
      config.ai.baseURL = normalizeBaseURL(config.ai.baseURL);
    }
    save(config);
    if (patch.hotkey) registerHotkey();
    if (patch.grabMode) applyGrabMode();
    windows.applySkinToBall(config);
    windows.applySkinToPanel(config);
    return config;
  });

  // 关闭面板（仅隐藏）
  ipcMain.on('panel:hide', () => windows.hidePanel());

  // 退出应用
  ipcMain.on('app:quit', () => {
    windows.destroyAll();
    app.quit();
  });

  // 推送到春晓学习助手：写桥接文件 + spawn（如未运行）
  ipcMain.handle('app:push', (_evt, { text, action }) => {
    return writeBridge({
      text: text || '',
      action: action || 'prefill', // prefill | ask
      course_id: courseCache.courseId
    });
  });

  // 「关联课程材料」：请求主程序在用户导入的课件 / 先验知识中检索，结果经 to-ball.json 回传
  // R4：带上当前课程 —— 主程序据此只在该课程的材料里检索（见 ball.rs 的 answer_material_search）
  ipcMain.handle('material:ask', (_evt, { text }) => {
    return writeBridge({
      text: text || '',
      action: 'material_search',
      course_id: courseCache.courseId
    });
  });

  // R4：悬浮球切换课程 → 回写主程序持久化（主程序是单一事实来源）
  ipcMain.handle('course:set', (_evt, { courseId }) => {
    courseCache.courseId = courseId == null ? null : Number(courseId);
    return writeBridge({
      text: '',
      action: 'set_course',
      course_id: courseCache.courseId
    });
  });

  /**
   * R4：把一次问答回推给主程序**落库**（问题 + 回答 + 图片 + 课程）。
   *
   * 为什么由球推、主程序写：球自己写的答案只在球里，主程序的历史/笔记/画像都用不到；
   * 而主程序侧由桥接轮询线程直接写库（`db::ball_append_qa`），
   * **不依赖主程序界面是否打开** —— 关着也能存下来。
   */
  ipcMain.handle('app:pushAsk', (_evt, { text, answer, images }) => {
    return writeBridge({
      text: text || '',
      action: 'ask',
      answer: answer || '',
      images: Array.isArray(images) ? images : [],
      course_id: courseCache.courseId
    });
  });
}

/**
 * 写桥接文件（`from-ball.json`）—— 所有「球 → 主程序」的推送都走这里。
 *
 * 统一入口的理由：**每一条推送都要带上当前课程**，否则主程序没法把问答/检索
 * 归到正确的课程（`docs/15` §3.2 冻结形状）。分散写的话迟早漏一处。
 *
 * `opts.spawn === false`：**不主动拉起主程序**。给"填一个下拉框"这类小请求用 ——
 * 为了一个课程列表把整个主程序启动起来，比下拉空着更糟。
 *
 * ⚠ 放在**模块级**（不在 `registerIpc` 里）：热键、托盘、点球这三条"打开面板"的路径
 *   都在 `registerIpc` 之外，而它们**都必须**顺手把课程列表要一次（R5.2）。
 */
function writeBridge(payload, opts) {
  try {
    if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    fs.writeFileSync(
      BRIDGE_FILE,
      JSON.stringify({ ts: Date.now(), ...payload }, null, 2),
      'utf8'
    );
    // 尝试拉起春晓学习助手（用户可能还没开主程序）
    if (!opts || opts.spawn !== false) spawnAppIfNeeded();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * R5.2：**主动向主程序要课程列表**。
 *
 * 为什么必须有它：课程列表原先只在主程序**主动 push**（`ball_show` / `ball_prefill`）时才到球里，
 * 而"点球 / 按热键 / 从托盘打开面板"走的是 `ball:click` → `togglePanel`，**没有任何推送** ——
 * 于是球面板的课程下拉里一门课都没有（用户实测："选择课程时没有任何课程"）。
 * 现在改为：**每次打开面板、以及每次点开下拉时，球主动问一次**。
 */
function requestCourses() {
  return writeBridge({ text: '', action: 'get_courses' }, { spawn: false });
}

// 拉起春晓学习助手：直接运行打包好的 exe（不再 spawn 源码/dev 服务器）
function resolveAppExe() {
  const candidates = [];
  if (app.isPackaged) {
    // 打包态：优先球 exe 同目录（两个 exe 放一起即可），再找桌面
    const exeDir = path.dirname(app.getPath('exe'));
    candidates.push(path.join(exeDir, 'chunxiao-study.exe'));
    candidates.push(path.join(os.homedir(), 'Desktop', 'chunxiao-study.exe'));
  } else {
    // 开发态：Tauri 编译产物 → 项目根 → 桌面
    candidates.push(path.join(WORKBENCH_DIR, 'src-tauri', 'target', 'release', 'chunxiao-study.exe'));
    candidates.push(path.join(WORKBENCH_DIR, 'chunxiao-study.exe'));
    candidates.push(path.join(os.homedir(), 'Desktop', 'chunxiao-study.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// detached + unref 使春晓独立运行，悬浮球退出不影响春晓
let appSpawned = false;
function spawnAppIfNeeded() {
  if (appSpawned) return;
  const exe = resolveAppExe();
  if (!exe) {
    console.warn('[app] 未找到 chunxiao-study.exe，跳过拉起（桥接文件仍会写入，浏览器/dev 模式可接收）');
    return;
  }
  appSpawned = true;
  try {
    console.log('[app] 拉起春晓学习助手 exe:', exe);
    const proc = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    proc.unref();
    proc.on('error', () => { appSpawned = false; });
    proc.on('exit', () => { appSpawned = false; });
  } catch (e) {
    appSpawned = false;
    console.warn('拉起春晓学习助手失败:', e.message);
  }
}

app.whenReady().then(() => {
  config = load();
  // 启动时自动修正可能错误的 baseURL（如用户粘了控制台网页地址）
  const fixed = normalizeBaseURL(config.ai?.baseURL);
  if (fixed && fixed !== config.ai.baseURL) {
    config.ai.baseURL = fixed;
    save(config);
  }
  // 命令行参数：--child 表示由其他项目拉起，--dev 打开 DevTools
  // 注意：child 是运行时标志，绝不写入配置文件（历史版本误写会导致钩子被永久禁用）
  const cli = parseArgs(process.argv);

  // R5：面板尺寸变化 → 落盘（用户拖过就记住；这是纯外观偏好，不涉及知识库）
  windows.setPanelResizeHandler((w, h) => {
    config.panelWidth = Math.round(w);
    config.panelHeight = Math.round(h);
    save(config);
  });

  windows.createBall(config, () => windows.togglePanel(config));
  windows.createBubble();
  setupTray();

  registerIpc();
  // 全局快捷键始终注册（手动触发抓取不受抓取模式影响）
  registerHotkey();

  // 鼠标钩子按抓取模式启停：auto=自动抓取；manual=关闭，等用户拖入文本
  applyGrabMode();

  // 开发模式打开 DevTools
  if (cli.dev) {
    const p = windows.showPanel(config);
    p.webContents.openDevTools({ mode: 'detach' });
  }

  // 春晓 → 悬浮球 反向控制：轮询 to-ball.json
  // browser/Vite 模式无法直接 spawn electron，通过文件发命令
  let lastCmdTs = 0;
  setInterval(() => {
    try {
      if (!fs.existsSync(CTRL_FILE)) return;
      const content = fs.readFileSync(CTRL_FILE, 'utf8');
      const msg = JSON.parse(content);
      if (msg.ts && msg.ts > lastCmdTs) {
        lastCmdTs = msg.ts;
        const cmd = msg.cmd;
        console.log(`[ctrl] 收到春晓命令: ${cmd}`);
        // 【BYOK 配套】主程序随命令下发的 AI 配置：收到即落盘。
        // 这样用户只在主程序里设置一次 Key，不必在球面板里再填一遍。
        // 配置搭在命令上而不是单发一条，是为了避开同一个控制文件「后写覆盖先写」的竞态。
        if (msg.ai && typeof msg.ai === 'object') {
          config.ai = Object.assign({}, config.ai, msg.ai);
          save(config);
          windows.sendToPanel('config:synced', { ai: config.ai });
          console.log('[ctrl] 已同步主程序的 AI 配置');
        }
        // R4：课程上下文（随 show / prefill 一起下发）—— 面板据此显示课程下拉
        if (msg.courses !== undefined || msg.courseId !== undefined) {
          courseCache.courses = Array.isArray(msg.courses) ? msg.courses : [];
          courseCache.courseId = msg.courseId == null ? null : Number(msg.courseId);
          windows.sendToPanel('courses:sync', {
            courses: courseCache.courses,
            courseId: courseCache.courseId
          });
          console.log(`[ctrl] 已同步课程上下文（${courseCache.courses.length} 门，当前 ${courseCache.courseId}）`);
        }
        if (cmd === 'show') {
          // 显示球（如果被隐藏了）+ 打开面板
          const ball = windows.getBall();
          if (ball && !ball.isDestroyed() && !ball.isVisible()) ball.show();
          windows.showPanel(config);
        } else if (cmd === 'hide') {
          windows.hidePanel();
        } else if (cmd === 'quit') {
          windows.destroyAll();
          app.quit();
        } else if (cmd === 'prefill' && typeof msg.text === 'string') {
          windows.showPanel(config);
          windows.sendToPanel('selection:result', msg.text);
        } else if (cmd === 'material_result' && msg) {
          // 主程序回传的本地材料检索结果
          windows.showPanel(config);
          windows.sendToPanel('material:result', msg);
        } else if (cmd === 'relate_result' && msg) {
          // R5：关联检索结果（材料 / 先验知识 / 知识点 三类）
          windows.showPanel(config);
          windows.sendToPanel('relate:result', msg);
        } else if (cmd === 'relate_saved' && msg) {
          // R5：知识点入库结果（成功给条数，失败给可读原文 —— 都要原样显示给用户）
          windows.sendToPanel('relate:saved', msg);
        } else if (cmd === 'config') {
          // 仅同步 AI 配置（配置已在上面落盘），无 UI 动作
        }
        try { fs.unlinkSync(CTRL_FILE); } catch {}
      }
    } catch {}
  }, 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  hook.stop();
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
});

// 即使没有可见窗口也保持运行（系统托盘常驻）
app.on('window-all-closed', (e) => {
  e.preventDefault();
});
