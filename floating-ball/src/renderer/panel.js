// 小窗渲染逻辑
const $ = (id) => document.getElementById(id);
let taskId = 0; let running = false; let buffer = '';
let cfgCache = null;
let recordingHotkey = false;
let pendingHotkey = '';
let pendingGrabMode = 'auto'; // 抓取模式（auto=自动抓取 / manual=手动拖入）；须在模块级声明，
// 否则“未打开设置抽屉时直接点主面板快捷切换”会抛 ReferenceError 而无反应。

// ---- 主题应用 ----
const THEMES = {
  dark: { name:'深色', bg:'linear-gradient(160deg,#161b22,#0d1117)', surface:'rgba(255,255,255,0.05)', border:'rgba(255,255,255,0.12)', text:'#e6edf3', muted:'#8b949e', accent:'#58a6ff', inputBg:'rgba(255,255,255,0.04)', codeBg:'rgba(0,0,0,0.35)', codeText:'#e6edf3' },
  light: { name:'白色', bg:'linear-gradient(160deg,#ffffff,#f0f2f5)', surface:'rgba(0,0,0,0.035)', border:'rgba(0,0,0,0.12)', text:'#1a1a1a', muted:'#6b7280', accent:'#2563eb', inputBg:'rgba(0,0,0,0.025)', codeBg:'rgba(0,0,0,0.06)', codeText:'#1a1a1a' }
};

function applyTheme(theme) {
  const r = document.documentElement.style;
  r.setProperty('--bg', theme.bg);
  r.setProperty('--surface', theme.surface);
  r.setProperty('--border', theme.border);
  r.setProperty('--text', theme.text);
  r.setProperty('--muted', theme.muted);
  r.setProperty('--accent', theme.accent);
  r.setProperty('--input-bg', theme.inputBg);
  r.setProperty('--code-bg', theme.codeBg);
  r.setProperty('--code-text', theme.codeText);
  $('btnTheme').textContent = theme.name === '白色' ? '☀' : '🌙';
}

function toggleTheme() {
  const next = cfgCache.theme === 'dark' ? 'light' : 'dark';
  cfgCache.theme = next;
  applyTheme(THEMES[next]); // 立即应用（之前缺这行）
  window.api.setTheme(next);
}

// ---- Markdown 渲染 ----
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function renderMarkdown(md) {
  const parts = md.split(/```/); let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n'); let code = part;
      if (nl > -1) code = part.slice(nl + 1);
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    } else { html += renderInline(part); }
  });
  return html;
}
function renderInline(text) {
  const lines = text.split(/\n/); let out = '';
  let inUl = false, inOl = false, para = [];
  const flushPara = () => {
    if (para.length) { out += `<p>${inlineFmt(para.join(' '))}</p>`; para = []; }
  };
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s+/.test(line)) {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if (inOl){out+='</ol>';inOl=false;}
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      out += `<h${m[1].length}>${inlineFmt(m[2])}</h${m[1].length}>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      flushPara(); if (inOl){out+='</ol>';inOl=false;} if(!inUl){out+='<ul>';inUl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if(!inOl){out+='<ol>';inOl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      flushPara(); if (inUl){out+='</ul>';inUl=false;} if (inOl){out+='</ol>';inOl=false;}
    } else { para.push(line); }
  });
  flushPara(); if (inUl) out += '</ul>'; if (inOl) out += '</ol>';
  return out;
}
function inlineFmt(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}
function renderResult(appendCursor) {
  $('result').innerHTML = renderMarkdown(buffer) + (appendCursor ? '<span class="cursor"></span>' : '');
  $('result').scrollTop = $('result').scrollHeight;
  updateResultButtons();
}
function setStatus(t) { $('status').textContent = t || ''; }
function setRunning(v) {
  running = v; ['btnTranslate','btnAsk'].forEach((id) => ($(id).disabled = v));
  updateResultButtons();
}
/** 结果区按钮态：空闲时不显示停止；无结果时隐藏复制/清空，避免输入区上方常驻一排图标 */
function updateResultButtons() {
  $('btnStop').style.display = running ? '' : 'none';
  const hasText = buffer.trim().length > 0;
  $('btnCopy').style.display = hasText ? '' : 'none';
  $('btnClear').style.display = hasText ? '' : 'none';
}

// ---- AI 任务 ----
function startTask(kind, opts) {
  if (running) return;
  buffer = ''; renderResult(true); setRunning(true);
  const id = ++taskId; setStatus('生成中…');
  window.api.runTask(kind, opts, id);
}
window.api.onTaskChunk(({ id, chunk }) => { if (id !== taskId) return; buffer += chunk; renderResult(true); });
window.api.onTaskDone(({ id, aborted }) => {
  if (id !== taskId) return;
  setRunning(false); setStatus(aborted ? '已停止' : '完成'); renderResult(false);
});
window.api.onTaskError(({ id, message }) => {
  if (id !== taskId) return;
  setRunning(false); setStatus('出错');
  buffer += `\n\n> 错误：${message}`; renderResult(false);
});

// 一键清空结果区
$('btnClear').addEventListener('click', () => {
  buffer = '';
  if (running) {
    // 进行中先停止，再清空
    window.api.stopTask && window.api.stopTask();
  }
  setRunning(false);
  setStatus('');
  renderResult(false);
});
updateResultButtons();

window.api.onSelectionResult((text) => {
  if (text) {
    $('source').value = text;
    // 新的抓取/推送文本进来视为一次新任务，清掉上一轮结果，避免新旧结果混淆
    if (buffer) { buffer = ''; renderResult(false); }
    setStatus('已抓取选中文字');
  }
  else setStatus('未抓取到文字（请先选中文本）');
});
window.api.onApplyTheme((theme) => applyTheme(theme));

// 主程序同步来的 AI 配置（BYOK）：只填空字段，绝不覆盖用户正在输入的内容
window.api.onConfigSynced(({ ai }) => {
  if (!ai) return;
  const fill = (id, v) => { const el = $(id); if (el && v && !el.value) el.value = v; };
  fill('cfgBase', ai.baseURL);
  fill('cfgKey', ai.apiKey);
  fill('cfgModel', ai.model);
  setStatus('已同步主程序的 AI 配置');
});

// ---- 关联课程材料（走主程序本地材料库，经桥接文件往返） ----
// M0：桥接往返与超时兜底已通；主程序侧的材料检索在 M2 实现，
// 因此"未收到响应"时如实说明，不假装检索过。
let materialTimer = null;
function showRelatePlaceholder(text) {
  buffer = `> 关联课程材料 📚（本地）\n\n已选中文本：\`${text.slice(0, 60)}${text.length > 60 ? '…' : ''}\`\n\n正在请主程序「春晓」在你导入的课件与先验知识中查找…`;
  renderResult(true);
  setStatus('材料检索中…');
  window.api.askMaterialSearch(text);
  if (materialTimer) clearTimeout(materialTimer);
  materialTimer = setTimeout(() => {
    buffer += '\n\n> ⚠ 未收到主程序响应。\n>\n> 在你导入的课件与先验知识中检索（材料检索）将在 **M2** 开放；' +
      '也可确认「春晓」桌面版是否已启动（浏览器预览模式不提供本地检索）。';
    renderResult(false);
    setStatus('未连接主程序');
  }, 6000);
}
window.api.onMaterialResult((msg) => {
  if (materialTimer) { clearTimeout(materialTimer); materialTimer = null; }
  const list = (msg && Array.isArray(msg.results)) ? msg.results : [];
  const kw = (msg && msg.kw) || '';
  if (list.length === 0) {
    buffer =
      `> 关联课程材料 · 未命中\n\n在你的课件与先验知识中没有找到与「${kw}」相关的内容` +
      (msg && msg.note ? `\n\n（${msg.note}）` : '') +
      '。可先在「课程」页导入相关材料，或换个关键词再试。';
  } else {
    const lines = list.map((r, i) => {
      const t = r.material || '未知材料';
      const p = r.page ? ` 第 ${r.page} 页` : '';
      const sn = (r.snippet || '').slice(0, 160);
      return `### ${i + 1}. ${t}${p}\n\n${sn}`;
    });
    buffer = `> 关联课程材料 · 本地命中 ${list.length} 条\n\n${lines.join('\n\n')}`;
  }
  renderResult(false);
  setStatus(list.length ? `命中 ${list.length} 条` : '未命中');
});

window.api.onExternalRunTask(({ kind, opts }) => {
  const text = opts.text || opts.question || '';
  if (text) $('source').value = text;
  if (kind === 'translate' && opts.target) $('lang').value = opts.target;
  if (kind === 'relate') showRelatePlaceholder(opts.text);
  else startTask(kind, opts);
});

// ---- 按钮事件 ----
$('btnTranslate').addEventListener('click', () => {
  const text = $('source').value.trim();
  if (!text) { setStatus('请先输入/抓取文本'); return; }
  startTask('translate', { text, target: $('lang').value });
});

$('btnRelate').addEventListener('click', () => {
  const text = $('source').value.trim();
  if (!text) { setStatus('请先输入/抓取文本'); return; }
  showRelatePlaceholder(text);
});

$('btnAsk').addEventListener('click', () => {
  const sourceText = $('source').value.trim();
  // 有选中文字 → 关联模式（显示上下文提示条）；无选中文字 → 纯询问模式
  if (sourceText) {
    $('askContextBar').style.display = 'block';
    $('askContextText').textContent = sourceText.length > 120 ? sourceText.slice(0, 120) + '…' : sourceText;
    $('askUseContext').checked = true; // 每次弹出默认启用关联
  } else {
    $('askContextBar').style.display = 'none';
  }
  $('askInput').value = '';
  $('askModal').classList.add('show');
  setTimeout(() => $('askInput').focus(), 100);
});
$('askCancel').addEventListener('click', () => $('askModal').classList.remove('show'));
$('askOk').addEventListener('click', () => {
  const q = $('askInput').value.trim();
  $('askModal').classList.remove('show');
  if (!q) { setStatus('问题不能为空'); return; }
  const sourceText = $('source').value.trim();
  // 有关联上下文且 checkbox 勾选 → 关联询问；否则 → 纯询问
  const useContext = sourceText && $('askUseContext').checked;
  if (useContext) {
    startTask('ask', { question: q, context: sourceText });
    setStatus('关联询问中…');
  } else {
    startTask('ask', { question: q, context: '' });
    setStatus('询问中…');
  }
});

$('btnStop').addEventListener('click', () => window.api.stopTask());
$('btnCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(buffer); setStatus('已复制'); }
  catch { setStatus('复制失败'); }
});

$('btnSkinPicker').addEventListener('click', () => window.api.openSkinPicker());
$('btnTheme').addEventListener('click', () => toggleTheme());
$('btnApp').addEventListener('click', async () => {
  const text = $('source').value.trim() || '';
  const res = await window.api.pushToApp(text, 'prefill');
  if (res?.ok) setStatus(text ? '已推送到春晓' : '已拉起春晓');
  else setStatus('操作失败：' + (res?.error || '未知错误'));
});
$('btnSettings').addEventListener('click', async () => {
  $('setDrawer').classList.toggle('open');
  if ($('setDrawer').classList.contains('open')) fillSettings();
});
$('btnClose').addEventListener('click', () => window.api.hidePanel());

// 顶栏拖动
const topBar = $('top'); let drag = null;
topBar.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'BUTTON') return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false }; topBar.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(e.screenX - drag.sx) > 3 || Math.abs(e.screenY - drag.sy) > 3) drag.moved = true;
  if (drag.moved && window.api.move) window.api.move(dx, dy);
});
window.addEventListener('mouseup', () => { if (drag) { topBar.classList.remove('dragging'); drag = null; } });

// ---- 设置抽屉 ----
const PROVIDERS = {
  deepseek:  { baseURL: 'https://api.deepseek.com',            model: 'deepseek-v4-flash' },
  openai:    { baseURL: 'https://api.openai.com/v1',                model: 'gpt-4o-mini' },
  dashscope: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu:     { baseURL: 'https://open.bigmodel.cn/api/paas/v4',     model: 'glm-4' },
  moonshot:  { baseURL: 'https://api.moonshot.cn/v1',               model: 'moonshot-v1-8k' },
  qwen:      { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  glm:       { baseURL: 'https://open.bigmodel.cn/api/paas/v4',     model: 'glm-4-plus' }
};

async function fillSettings() {
  if (!cfgCache) cfgCache = (await window.api.getState()).config;
  // 检测当前配置匹配哪个内置平台
  let matched = '';
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (cfgCache.ai.baseURL === p.baseURL) { matched = key; break; }
  }
  $('cfgProvider').value = matched;
  $('cfgBase').value = cfgCache.ai.baseURL || '';
  $('cfgKey').value = cfgCache.ai.apiKey || '';
  $('cfgModel').value = cfgCache.ai.model || '';
  $('hotkeyText').textContent = cfgCache.hotkey || 'Alt+Q';
  pendingHotkey = cfgCache.hotkey || 'Alt+Q';
  pendingGrabMode = cfgCache.grabMode === 'manual' ? 'manual' : 'auto';
  syncGrabButtons();
}

// 抓取模式切换（选中态强对比 + 说明文字）；主面板快捷按钮与「设置」抽屉按钮同步
function syncGrabButtons() {
  const auto = pendingGrabMode !== 'manual';
  $('grabAuto').classList.toggle('active', auto);
  $('grabManual').classList.toggle('active', !auto);
  const qa = $('qAuto'), qm = $('qManual');
  if (qa) qa.classList.toggle('active', auto);
  if (qm) qm.classList.toggle('active', !auto);
  $('grabHint').textContent = auto
    ? '🔄 自动模式：鼠标选中文字松开即自动抓取并弹出面板'
    : '✋ 手动模式：不主动抓取，把选中的文字拖到悬浮球或本窗口内即可';
}
// 抓取模式点击立即生效并持久化（与主题切换一致，不依赖“保存”按钮）
async function applyGrabModeLive(mode) {
  pendingGrabMode = mode;
  syncGrabButtons();
  try {
    cfgCache = await window.api.saveConfig({ grabMode: mode });
    setStatus(mode === 'manual' ? '✋ 已切换：手动拖入（自动抓取已关闭）' : '🔄 已切换：自动抓取');
  } catch (e) {
    setStatus('模式切换失败：' + (e.message || e));
  }
}
function bindGrabMode(id, mode) {
  const el = $(id);
  if (el) el.addEventListener('click', () => { if (pendingGrabMode !== mode) applyGrabModeLive(mode); });
}
bindGrabMode('grabAuto', 'auto');
bindGrabMode('grabManual', 'manual');
bindGrabMode('qAuto', 'auto');
bindGrabMode('qManual', 'manual');

// 选择平台自动填充
$('cfgProvider').addEventListener('change', () => {
  const key = $('cfgProvider').value;
  if (PROVIDERS[key]) {
    $('cfgBase').value = PROVIDERS[key].baseURL;
    $('cfgModel').value = PROVIDERS[key].model;
  }
});

// 快捷键录制
function keyToHotkey(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Cmd');
  // 跳过单独按修饰键（只按 Ctrl 不算快捷键）
  const hasMod = parts.length > 0;
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return null;
  parts.push(key);
  return parts.join('+');
}

$('hotkeyRecord').addEventListener('click', () => {
  recordingHotkey = true;
  pendingHotkey = '';
  $('hotkeyText').textContent = '按下组合键…';
  $('hotkeyBox').classList.add('recording');
});
$('hotkeyReset').addEventListener('click', () => {
  pendingHotkey = 'Alt+Q';
  $('hotkeyText').textContent = pendingHotkey;
});

window.addEventListener('keydown', (e) => {
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  const combo = keyToHotkey(e);
  if (combo) {
    pendingHotkey = combo;
    $('hotkeyText').textContent = combo;
    recordingHotkey = false;
    $('hotkeyBox').classList.remove('recording');
  }
}, true);

$('btnSave').addEventListener('click', async () => {
  const patch = { ai: {} };
  const baseURL = $('cfgBase').value.trim();
  const apiKey = $('cfgKey').value.trim();
  const model = $('cfgModel').value.trim();
  if (baseURL) patch.ai.baseURL = baseURL;
  if (apiKey) patch.ai.apiKey = apiKey;
  if (model) patch.ai.model = model;
  if (pendingHotkey) patch.hotkey = pendingHotkey;
  patch.grabMode = pendingGrabMode;
  cfgCache = await window.api.saveConfig(patch);
  setStatus('设置已保存');
  $('setDrawer').classList.remove('open');
});

// 一键测试 Key
$('btnTest').addEventListener('click', async () => {
  const baseURL = $('cfgBase').value.trim() || cfgCache.ai.baseURL;
  const apiKey = $('cfgKey').value.trim() || cfgCache.ai.apiKey;
  if (!apiKey) { setStatus('请先填写 API Key'); return; }
  if (!baseURL) { setStatus('请先填写 API 地址'); return; }
  setStatus('测试中…');
  const r = await window.api.testKey({ baseURL, apiKey });
  setStatus(r.message);
});

// ---- 文本拖入面板（手动抓取模式：把选中文字拖到窗口里）----
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('drop-active');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-active'); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drop-active');
  const text = (e.dataTransfer && (e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text'))) || '';
  if (text.trim()) {
    $('source').value = text.trim();
    setStatus('已放入文本');
  }
});

// 初始化
(async function init() {
  const { config } = await window.api.getState();
  cfgCache = config;
  pendingGrabMode = config.grabMode === 'manual' ? 'manual' : 'auto';
  syncGrabButtons(); // 让主面板快捷按钮一打开就显示当前抓取模式
  applyTheme(THEMES[config.theme || 'dark']);
  if (!config.ai.apiKey) setStatus('未配置 API Key，请点 ⚙ 填写');
})();
