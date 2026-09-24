// 悬浮球面板渲染逻辑（R5.1）
//
// 版面就三件事（用户原话「就这些」）：
//   ① 一个框**拖入/抓取内容**（`#source`）；
//   ② 一个框**写我要问什么**（`#question`）；
//   ③ 两个按钮：**问询** / **关联知识点**。
// 抓取模式（自动 / 手动拖入）是**两个带文字的按钮**，常驻可见 —— 不许再收成图标按钮。
//
// ⚠ R5.1 删掉的「收起」：它把面板压到 64px，而收起后要显示的内容（输入框 + 按钮行）约需 100px，
//   于是按钮行被裁在窗口外、连"展开"按钮本身都点不到，高度还持久化了 —— 重启也出不来。
//   这个功能是加戏，用户没要，已整块移除（`windows.applyCollapsedSize` / `panel:set-collapsed` /
//   `config.panelCollapsed` 一并删干净，并在 config.load() 里自愈旧配置留下的坏值）。
//
// 与主程序的分工：
//   · 本文件**不做检索、不写库** —— 「关联」的两步都经桥接文件交给主程序
//     （`relate_search` 只读 / `relate_save` 才写），再经 `to-ball.json` 回传；
//   · 课程是**主程序持有**的单一事实来源（`settings.ball.course_id`），这里只显示与回写；
//   · 一次问答完成后把「问题 + 回答 + 图片」回推主程序落库（`action:"ask"`）——
//     球是独立应用，用户可能压根没开主程序界面，所以这件事不能依赖任何页面在跑。

const $ = (id) => document.getElementById(id);

let running = false;      // 是否有任务在跑
let buffer = '';          // 结果区正文
let extractBuf = '';      // 「提炼知识点」的原始输出（单独一个槽，别和结果区混）
let cfgCache = null;
let recordingHotkey = false;
let pendingHotkey = '';
let pendingGrabMode = 'auto';
let toastTimer = null;

/** 落库时附带的原文上限（避免一段超长材料把会话撑爆；超出如实标注截断） */
const RECORD_CONTEXT_MAX = 2000;

// ---- 主题（R11：换成「DeepSeek 云鲸纸面」maid-whale-webui 的深浅两套令牌；
//      与 `src/main/skins.js` 的 PANEL_THEMES **必须一致** ——
//      渲染进程拿不到主进程那份，所以这里是同一组值的第二份拷贝。改一处就要改两处。）----
const THEMES = {
  dark: { name:'深色', bg:'#172435', haze:'rgba(18,31,47,.52)', drawerBg:'#1c2d42', surface:'rgba(28,45,66,.96)', border:'rgba(167,199,216,.18)', text:'#e4edf2', muted:'#b9c8d2', accent:'#83bcdc', inputBg:'rgba(23,36,53,.92)', codeBg:'rgba(28,45,66,.98)', codeText:'#e4edf2' },
  light: { name:'白色', bg:'#eef6f8', haze:'rgba(255,254,249,.60)', drawerBg:'#f7f9f6', surface:'rgba(247,249,246,.94)', border:'rgba(72,112,132,.22)', text:'#243746', muted:'#486170', accent:'#5aa7d8', inputBg:'rgba(255,255,252,.96)', codeBg:'rgba(239,246,247,.98)', codeText:'#243746' }
};

function applyTheme(theme) {
  const r = document.documentElement.style;
  r.setProperty('--bg', theme.bg);
  if (theme.haze) r.setProperty('--haze', theme.haze);
  if (theme.drawerBg) r.setProperty('--drawer-bg', theme.drawerBg);
  r.setProperty('--surface', theme.surface);
  r.setProperty('--border', theme.border);
  r.setProperty('--text', theme.text);
  r.setProperty('--muted', theme.muted);
  r.setProperty('--accent', theme.accent);
  r.setProperty('--accent-2', theme.name === '白色' ? '#69acc8' : '#6ea3c2');
  r.setProperty('--input-bg', theme.inputBg);
  r.setProperty('--code-bg', theme.codeBg);
  r.setProperty('--code-text', theme.codeText);
  const b = $('btnTheme');
  if (b) b.textContent = theme.name === '白色' ? '☀' : '🌙';
}

function toggleTheme() {
  const next = cfgCache.theme === 'dark' ? 'light' : 'dark';
  cfgCache.theme = next;
  applyTheme(THEMES[next]);
  window.api.setTheme(next);
}

// ---- Markdown 渲染 ----
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderMarkdown(md) {
  const parts = String(md).split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl > -1 ? part.slice(nl + 1) : part;
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    } else {
      html += renderInline(part);
    }
  });
  return html;
}

function renderInline(text) {
  const lines = String(text).split(/\n/);
  let out = '';
  let inUl = false, inOl = false, inBq = false;
  let para = [];
  const closeLists = () => { if (inUl){out+='</ul>';inUl=false;} if (inOl){out+='</ol>';inOl=false;} };
  const closeBq = () => { if (inBq){out+='</blockquote>';inBq=false;} };
  const flushPara = () => { if (para.length) { out += `<p>${inlineFmt(para.join(' '))}</p>`; para = []; } };

  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s+/.test(line)) {
      flushPara(); closeLists(); closeBq();
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      out += `<h${m[1].length}>${inlineFmt(m[2])}</h${m[1].length}>`;
    } else if (/^\s*>\s?/.test(line)) {
      flushPara();
      if (!inBq) { closeLists(); out += '<blockquote>'; inBq = true; }
      out += `<p>${inlineFmt(line.replace(/^\s*>\s?/, ''))}</p>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      flushPara(); closeBq();
      if (inOl){out+='</ol>';inOl=false;}
      if (!inUl){out+='<ul>';inUl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushPara(); closeBq();
      if (inUl){out+='</ul>';inUl=false;}
      if (!inOl){out+='<ol>';inOl=true;}
      out += `<li>${inlineFmt(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(); closeLists(); closeBq();
      out += '<hr>';
    } else if (line.trim() === '') {
      flushPara(); closeLists(); closeBq();
    } else {
      closeBq();
      para.push(line);
    }
  });
  flushPara(); closeLists(); closeBq();
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
function appendBuffer(text) { buffer += text; renderResult(true); }

function setStatus(t) {
  const el = $('status');
  if (!el) return;
  el.textContent = t || '';
  el.title = t || '';
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  // 状态是"如实说明"的出口，别让它长期占着：8 秒后淡出（悬停仍可看到全文）
  if (t) toastTimer = setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 8000);
}

function setRunning(v) {
  running = v;
  ['btnAsk', 'btnRelate'].forEach((id) => { const el = $(id); if (el) el.disabled = v; });
  updateResultButtons();
}

/** 结果行按钮的显隐**只有一个来源**：停止只在跑着时出现，复制/清空只在有内容时出现。
 *  ⚠ 0.7.0 把"停止"的显隐写在 `setRunning` 里，而它**初始时没被调用过** ——
 *    于是面板一打开就挂着一个"停止"按钮（空结果时尤其突兀）。 */
function updateResultButtons() {
  $('btnStop').style.display = running ? '' : 'none';
  const hasText = (buffer || '').trim().length > 0;
  $('btnCopy').style.display = hasText ? '' : 'none';
  $('btnClear').style.display = hasText ? '' : 'none';
}

// ---- 任务执行（统一的流式出口） ----
let curTaskId = 0;
let taskHandlers = null;

function beginTask(kind, opts, handlers) {
  if (running) return false;
  running = true;
  setRunning(true);
  const id = ++curTaskId;
  taskHandlers = Object.assign({}, handlers);
  window.api.runTask(kind, opts, id);
  return true;
}

window.api.onTaskChunk(({ id, chunk }) => {
  if (id !== curTaskId || !taskHandlers || !taskHandlers.chunk) return;
  taskHandlers.chunk(chunk);
});
window.api.onTaskDone(({ id, aborted }) => {
  if (id !== curTaskId) return;
  const h = taskHandlers;
  taskHandlers = null;
  running = false;
  setRunning(false);
  if (h && h.done) h.done(!!aborted);
});
window.api.onTaskError(({ id, message }) => {
  if (id !== curTaskId) return;
  const h = taskHandlers;
  taskHandlers = null;
  running = false;
  setRunning(false);
  if (h && h.error) h.error(message);
  else { appendBuffer(`\n\n> 错误：${message}`); setStatus('出错'); }
});

// ---- 结果区按钮 ----
$('btnClear').addEventListener('click', () => {
  if (running) window.api.stopTask && window.api.stopTask();
  setRunning(false);
  buffer = '';
  setStatus('');
  renderResult(false);
});
$('btnStop').addEventListener('click', () => window.api.stopTask());
$('btnCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(buffer); setStatus('已复制'); }
  catch { setStatus('复制失败'); }
});
updateResultButtons();

// ---- 抓到的文字进来 → 填「抓取的内容」框（**不动**「我要问什么」） ----
window.api.onSelectionResult((text) => {
  if (text) {
    $('source').value = text;
    autoGrow();
    renderCandidateBlock();
    setStatus('已抓取文字，填在「抓取的内容」里');
  } else {
    setStatus('未抓取到文字（请先选中文本）');
  }
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

// ---------------------------------------------------------------------------
// 课程上下文
// ---------------------------------------------------------------------------
let courses = [];
let courseId = null;
/** 是否已拿到过一次课程列表（用来区分"还没读到"与"确实一门课都没有"） */
let coursesLoaded = false;

function renderCourses() {
  const sel = $('courseSel');
  if (!sel) return;
  const wanted = courseId == null ? '' : String(courseId);
  if (courses.length === 0) {
    // R5.2：下拉为空时**必须说清是哪一种空** —— 0.7.1 的缺陷就是"一门课都没有"却什么都不说，
    //   用户只看到一个不含任何课程的下拉，无从判断是"没建课"还是"没连上主程序"。
    sel.innerHTML = coursesLoaded
      ? '<option value="">（还没有课程）</option>'
      : '<option value="">（正在读取课程…）</option>';
    sel.value = '';
  } else {
    sel.innerHTML =
      '<option value="">不限定课程</option>' +
      courses.map((c) => `<option value="${c.id}">${escapeHtml(String(c.name || ''))}</option>`).join('');
    sel.value = wanted;
    if (sel.value !== wanted) sel.value = ''; // 当前课程已被删：回到「不限定课程」，不留选不中的值
  }
  renderScope();
}

/** 如实显示当前范围 —— 界面写什么，检索就必须按什么走（docs/11 §一 第 2 条） */
function renderScope() {
  const hint = $('scopeHint');
  if (!hint) return;
  if (courses.length === 0) {
    hint.textContent = coursesLoaded ? '未读到课程' : '正在读取…';
    hint.title = coursesLoaded
      ? '春晓主程序里还没有课程，或主程序没在运行。在春晓「课程」页新建一门课，再点开这个下拉即可看到。'
      : '正在向春晓主程序读取课程列表…';
    return;
  }
  const c = courses.find((x) => String(x.id) === String(courseId));
  hint.textContent = courseId == null ? '范围：全部课程' : `范围：${c ? c.name : '已选课程'}`;
  // R7：这里原来写「知识点入库需要先选一门课」——「入库」是工程词。
  //   同时补上一句口径：范围**默认跟着主窗口当前课程走**（R7 起由主程序同步），
  //   免得用户以为"我没在这儿选过课，它怎么知道查哪门"。
  hint.title = courseId == null
    ? '关联检索查全部课程；要把提炼出的知识点存进某门课，得先在上面选一门课'
    : '关联检索只查这门课；「加入本课」也会存进这门课（范围默认跟着主窗口当前课程走，可以在这里改）';
}

$('courseSel')?.addEventListener('change', () => {
  const v = $('courseSel').value;
  courseId = v ? Number(v) : null;
  window.api.setCourse(courseId);
  renderScope();
  renderCandidateBlock(); // 选课状态变了，「提炼/加入本课」的可用性要跟着变
  setStatus(courseId ? '已切到这门课：检索与入库都按它走' : '已改为「不限定课程」：检索查全部课程');
});

// R5.2：**每次点开下拉都刷新一次**（课程可能刚在主程序里新建 / 改名 / 删除）
$('courseSel')?.addEventListener('mousedown', () => {
  if (window.api.requestCourses) void window.api.requestCourses();
});

window.api.onCourses((p) => {
  courses = Array.isArray(p && p.courses) ? p.courses : [];
  courseId = p && p.courseId != null ? Number(p.courseId) : null;
  coursesLoaded = true;
  renderCourses();
});

// ---------------------------------------------------------------------------
// 图片：Ctrl+V 粘贴截图（**不做**屏幕抓取，用户用系统截图工具截）
// ---------------------------------------------------------------------------
let pendingImages = [];
const MAX_IMG_EDGE = 1600;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

function dataUrlBytes(u) {
  const i = (u || '').indexOf(',');
  if (i < 0) return (u || '').length;
  const b64 = u.slice(i + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 压缩到最长边 1600（与主程序 lib/images.ts 同口径），优先 PNG、过大转 JPEG */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w0 = img.naturalWidth || img.width;
      const h0 = img.naturalHeight || img.height;
      if (!w0 || !h0) return reject(new Error('尺寸读不出来'));
      const scale = Math.min(1, MAX_IMG_EDGE / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const png = cv.toDataURL('image/png');
      resolve(dataUrlBytes(png) <= 1_200_000 ? png : cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来')); };
    img.src = url;
  });
}

function renderImages() {
  const strip = $('imgStrip');
  const hint = $('imgHint');
  if (!strip) return;
  strip.innerHTML = '';
  pendingImages.forEach((src, i) => {
    const box = document.createElement('span');
    box.className = 'img-thumb';
    const im = document.createElement('img');
    im.src = src;
    im.alt = `第 ${i + 1} 张待发送的图片`;
    im.title = '点击放大';
    im.addEventListener('click', () => {
      const w = window.open('', '_blank');
      if (w) w.document.write(`<title>图片</title><img src="${src}" style="max-width:100%">`);
    });
    const x = document.createElement('button');
    x.className = 'img-thumb-x';
    x.textContent = '×';
    x.title = '移除这张';
    x.addEventListener('click', () => {
      pendingImages = pendingImages.filter((_, k) => k !== i);
      renderImages();
      renderCandidateBlock();
    });
    box.appendChild(im);
    box.appendChild(x);
    strip.appendChild(box);
  });
  if (hint) {
    const total = pendingImages.reduce((n, u) => n + dataUrlBytes(u), 0);
    hint.textContent = pendingImages.length
      ? `已放入 ${pendingImages.length} 张（共 ${humanBytes(total)}），会随这次提问一起发给模型`
      : '';
  }
}

async function takeImages(files) {
  const rejected = [];
  let total = pendingImages.reduce((n, u) => n + dataUrlBytes(u), 0);
  for (const f of files) {
    try {
      const dataUrl = await compressImage(f);
      const bytes = dataUrlBytes(dataUrl);
      if (total + bytes > MAX_TOTAL_BYTES) {
        rejected.push(`「${f.name || '粘贴的图片'}」没放进来：加上它共 ${humanBytes(total + bytes)}，超过 ${humanBytes(MAX_TOTAL_BYTES)} 上限`);
        continue;
      }
      total += bytes;
      pendingImages.push(dataUrl);
    } catch (e) {
      rejected.push(`「${f.name || '粘贴的图片'}」没放进来：${e.message || e}`);
    }
  }
  renderImages();
  renderCandidateBlock();
  if (rejected.length) setStatus(rejected.join('；'));
}

function filesFromClipboard(dt) {
  const files = [];
  if (!dt) return files;
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

// 两个框都支持粘贴截图（截图后手最容易落在哪个框就在哪个框粘）
[$('source'), $('question')].forEach((el) => {
  el.addEventListener('paste', (e) => {
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return; // 纯文本粘贴不拦，走默认行为
    e.preventDefault();
    void takeImages(files);
  });
});

// 整窗拖入：文本落进「抓取的内容」，图片进缩略图条
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('drop-active'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => {
  e.preventDefault(); dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop-active'); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drop-active');
  const dt = e.dataTransfer;
  if (!dt) return;
  const imgs = Array.from(dt.files || []).filter((f) => String(f.type || '').startsWith('image/'));
  if (imgs.length) { void takeImages(imgs); return; }
  const text = dt.getData('text/plain') || dt.getData('text') || '';
  if (text.trim()) {
    $('source').value = text.trim();
    autoGrow();
    renderCandidateBlock();
    setStatus('已放入「抓取的内容」');
  }
});

// ---- 两个框都自适应增高 ----
//
// 上限跟着窗口高度走：面板被拉矮时，内容框别把结果区挤成一条缝
// （输入区不参与 flex 压缩，所以这里必须自己收敛，否则高窗口的内容一多就会顶掉结果区）。
function autoGrowEl(el, min, cssMax) {
  if (!el) return;
  el.style.height = 'auto';
  const dynMax = Math.max(min, Math.min(cssMax, Math.round(window.innerHeight * 0.24)));
  el.style.height = Math.min(dynMax, Math.max(min, el.scrollHeight)) + 'px';
}
function autoGrow() {
  autoGrowEl($('source'), 44, 150);
  autoGrowEl($('question'), 32, 110);
}
// 窗口被拉伸/缩小后重算，免得上限还停在旧视口上
window.addEventListener('resize', () => autoGrow());

/** 面板空间小：优先保证"两个框 + 两个按钮"能用 */
function currentContent() { return ($('source').value || '').trim(); }
function currentQuestion() { return ($('question').value || '').trim(); }

// ---------------------------------------------------------------------------
// 「问询」：内容作上下文，问题作问题
// ---------------------------------------------------------------------------
let pendingAsk = null;

function askNow() {
  const content = currentContent();
  const question = currentQuestion();
  const images = pendingImages.slice();
  if (!content && !question && images.length === 0) {
    setStatus('请先拖入/抓取一段内容，或粘贴一张截图，再写「我要问什么」');
    ($('source').value ? $('question') : $('source')).focus();
    return;
  }
  const asked = question || content; // 没写问题：把内容本身问出去（与旧版行为一致）
  // 落库文本：两个框都有时，把原文一并存下来（**截断并如实标注**），
  // 否则回看历史时看不出"当时是就哪段话问的"。
  const record = question && content
    ? `${question}\n\n---\n（就以下内容提问）\n${content.slice(0, RECORD_CONTEXT_MAX)}${content.length > RECORD_CONTEXT_MAX ? '\n…（内容过长，记录时已截断；完整内容未入库）' : ''}`
    : asked;

  pendingAsk = { question: record, images };
  pendingImages = [];
  renderImages();
  clearCandidates();
  buffer = '';
  renderResult(true);
  $('resultTitle').textContent = '问询结果';
  setStatus(images.length ? `问春晓中…（含 ${images.length} 张图）` : '问春晓中…');
  beginTask('ask', { question: asked, context: question ? content : '', images }, {
    chunk: (c) => appendBuffer(c),
    done: (aborted) => {
      renderResult(false);
      setStatus(aborted ? '已停止' : '完成');
      const ask = pendingAsk;
      pendingAsk = null;
      // 把「问题 + 回答 + 图片」回推主程序落库（球是独立应用，不能依赖任何页面在跑）
      if (ask && !aborted && buffer.trim()) {
        void window.api.pushAsk({ text: ask.question, answer: buffer, images: ask.images })
          .then((r) => {
            if (r && r.ok) setStatus('完成 · 已存进春晓（悬浮球记录）');
            else setStatus('完成（存进春晓失败：' + ((r && r.error) || '未知') + '）');
          });
      }
    },
    error: (msg) => { appendBuffer(`\n\n> 错误：${msg}`); renderResult(false); setStatus('出错'); },
  });
}
$('btnAsk').addEventListener('click', askNow);

// 「我要问什么」框里**回车即问询**（Shift+回车换行）。
// ⚠ 必须避开中文输入法的候选确认：`isComposing` / keyCode 229 时不发送，
//   否则"打拼音时按回车选词"会变成"把半截拼音发出去"。
$('question').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  askNow();
});

// ---------------------------------------------------------------------------
// 「关联知识点」三步：查（本地只读）→ 抽（AI 出候选）→ 确认后才入库
// ---------------------------------------------------------------------------
let relateTimer = null;
let lastRelateText = '';
let candidates = [];

function clearCandidates() {
  candidates = [];
  const area = $('candArea');
  if (area) area.remove();
}

function candArea() {
  let area = $('candArea');
  if (!area) {
    area = document.createElement('div');
    area.id = 'candArea';
    $('result').insertAdjacentElement('afterend', area);
  }
  return area;
}

function renderRelateHits(msg) {
  const kw = (msg && msg.kw) || '';
  const materials = (msg && msg.materials) || [];
  const priors = (msg && msg.priors) || [];
  const kps = (msg && msg.kps) || [];
  const total = materials.length + priors.length + kps.length;

  let out = `> 关联知识点 · 本地检索\n>\n> 检索词：\`${kw || '（空）'}\` ｜ 范围：${courseId == null ? '全部课程（本机）' : '当前选中的课程（本机）'}\n\n`;
  if (total === 0) {
    out += '**没有查到相关内容。**\n\n' + (msg && msg.note ? `> ${msg.note}\n` : '');
    return out;
  }
  if (materials.length) {
    out += `### 材料片段（${materials.length}）\n\n`;
    materials.forEach((r, i) => {
      const p = r.page ? ` · 第 ${r.page} 页` : '';
      out += `**${i + 1}. ${r.material || '未知材料'}**${p}\n\n${(r.snippet || '').slice(0, 200)}\n\n`;
    });
  }
  if (priors.length) {
    out += `### 先验知识（${priors.length}）\n\n`;
    priors.forEach((r) => { out += `- **${r.topic}**${r.summary ? `：${r.summary}` : ''}\n`; });
    out += '\n';
  }
  if (kps.length) {
    out += `### 知识点（${kps.length}）\n\n`;
    kps.forEach((r) => { out += `- ${r.name}\n`; });
    out += '\n';
  }
  return out;
}

function relateNow() {
  const content = currentContent();
  const question = currentQuestion();
  const images = pendingImages.slice();
  const text = content || question; // 关联检索以「抓取的内容」为主，没内容才退回问题
  if (!text && images.length === 0) { setStatus('请先在「抓取的内容」里拖入/抓取一段内容'); return; }
  clearCandidates();
  lastRelateText = text;

  buffer = !text && images.length
    ? '> 关联知识点 · 本地检索\n>\n> 这次只有图片、没有文字，本机检索用不上关键词。\n> 点下面的「提炼候选知识点」直接把图里的知识点读出来。\n'
    : '> 关联知识点 · 本地检索\n>\n> 正在请春晓在你导入的材料、已核对的先验知识与知识点里查找…\n';
  renderResult(true);
  $('resultTitle').textContent = '关联结果';
  setStatus('本机检索中…');

  if (text) {
    window.api.relateSearch(text);
    if (relateTimer) clearTimeout(relateTimer);
    relateTimer = setTimeout(() => {
      relateTimer = null;
      appendBuffer('\n> ⚠ 没有收到春晓的回应。\n>\n> 请确认「春晓」主程序已启动（本机检索由它执行）。\n');
      setStatus('未连接主程序');
      renderCandidateBlock();
    }, 6000);
  }
  renderCandidateBlock();
}

window.api.onRelateResult((msg) => {
  if (relateTimer) { clearTimeout(relateTimer); relateTimer = null; }
  buffer = renderRelateHits(msg);
  renderResult(false);
  const n = ((msg && msg.materials) || []).length + ((msg && msg.priors) || []).length + ((msg && msg.kps) || []).length;
  setStatus(n ? `命中 ${n} 条` : '未命中');
  renderCandidateBlock();
});

/** 「提炼 → 确认 → 加入本课」这一块（随课程/内容变化重建） */
function renderCandidateBlock() {
  clearCandidates();
  const content = currentContent();
  const question = currentQuestion();
  const hasImages = pendingImages.length > 0;
  if (!content && !question && !hasImages) return; // 什么内容都没有时不显示这一块，省空间

  const area = candArea();
  const box = document.createElement('div');
  box.className = 'cand';

  const head = document.createElement('div');
  head.className = 'cand-head';
  head.textContent = courseId == null
    ? '知识点必须归属到某门课程 —— 请先在上面「课程」里选一门，才能把提炼出的知识点加入本课。'
    : '先让模型从「抓取的内容」里提炼候选知识点，你核对、勾选之后才会写进这门课（不会自动入库）。';
  box.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'cand-actions';
  const btn = document.createElement('button');
  btn.className = 'btn primary small';
  btn.textContent = '提炼候选知识点';
  btn.title = '用能看图的主模型读文字与截图，列出候选知识点';
  btn.disabled = courseId == null || running;
  btn.addEventListener('click', () => extractCandidates());
  actions.appendChild(btn);
  box.appendChild(actions);
  area.appendChild(box);
}

function extractCandidates() {
  if (courseId == null) { setStatus('请先选一门课程'); return; }
  const content = currentContent();
  const question = currentQuestion();
  const images = pendingImages.slice();
  if (!content && !question && images.length === 0) { setStatus('没有可提炼的内容'); return; }

  // 有独立问题时把它作为"特别想弄清楚的"，一并交给模型（不丢用户意图）
  const askText = (content || question) +
    (content && question ? `\n\n（用户特别想弄清楚的是：${question}）` : '');

  clearCandidates();
  const area = candArea();
  const box = document.createElement('div');
  box.className = 'cand';
  box.id = 'candBox';
  box.innerHTML = '<div class="cand-head">正在提炼候选知识点…（这一步会调用模型，图片会一起发过去）</div>';
  area.appendChild(box);
  setStatus('提炼中…');

  extractBuf = '';
  beginTask('extract', { question: askText, images }, {
    chunk: (c) => {
      extractBuf += c;
      const el = $('candBox');
      if (el) el.querySelector('.cand-head').textContent = `正在提炼… 已收到 ${extractBuf.length} 字`;
    },
    done: () => { renderCandidatesFrom(extractBuf); },
    error: (msg) => {
      const el = $('candBox');
      if (el) el.innerHTML = `<div class="cand-head" style="color:var(--danger)">提炼失败：${escapeHtml(msg)}</div>`;
      setStatus('提炼失败');
    },
  });
}

/** 把模型输出解析成候选列表。**解析不出来就如实说不出来**，不猜、不硬凑。 */
function parseCandidates(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { error: '模型没有返回可解析的 JSON。' };
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { return { error: `JSON 解析失败：${e.message}` }; }
  const items = Array.isArray(obj) ? obj : (Array.isArray(obj.items) ? obj.items : null);
  if (!items) return { error: '返回的 JSON 里没有 items 数组。' };
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const topic = String(it.topic || '').trim();
    if (!topic) continue;
    out.push({
      topic: topic.slice(0, 200),
      summary: it.summary ? String(it.summary).trim() : '',
      detail: it.detail ? String(it.detail).trim() : '',
      parent_topic: it.parent_topic ? String(it.parent_topic).trim() : '',
    });
  }
  if (out.length === 0) return { error: '模型没有给出任何知识点候选。' };
  return { items: out };
}

function renderCandidatesFrom(raw) {
  const parsed = parseCandidates(raw);
  clearCandidates();
  const area = candArea();
  const box = document.createElement('div');
  box.className = 'cand';

  if (parsed.error) {
    box.innerHTML = `<div class="cand-head" style="color:var(--danger)">没能解析出候选知识点：${escapeHtml(parsed.error)}<br>模型的原始输出在下面，可复制后手工整理。</div>`;
    const raw2 = document.createElement('div');
    raw2.className = 'hit';
    raw2.innerHTML = `<div class="hit-src">模型原始输出</div><div class="hit-body"><pre>${escapeHtml(String(raw || '').slice(0, 4000))}</pre></div>`;
    box.appendChild(raw2);
    area.appendChild(box);
    setStatus('解析失败');
    return;
  }

  candidates = parsed.items;
  const head = document.createElement('div');
  head.className = 'cand-head';
  head.textContent = `提炼出 ${candidates.length} 个候选知识点。请核对内容（可直接改），取消勾选的不会写入。`;
  box.appendChild(head);

  candidates.forEach((c, i) => {
    const item = document.createElement('label');
    item.className = 'cand-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = String(i);
    const fields = document.createElement('div');
    fields.className = 'cand-fields';
    const t = document.createElement('input');
    t.className = 'cand-topic';
    t.value = c.topic;
    t.placeholder = '知识点名称';
    t.addEventListener('input', () => { candidates[i].topic = t.value; });
    const s = document.createElement('input');
    s.className = 'cand-sum';
    s.value = c.summary || '';
    s.placeholder = '一句话说明（可空）';
    s.addEventListener('input', () => { candidates[i].summary = s.value; });
    fields.appendChild(t);
    fields.appendChild(s);
    if (c.parent_topic) {
      const p = document.createElement('div');
      p.className = 'cand-sum';
      p.style.color = 'var(--muted)';
      p.textContent = `上级：${c.parent_topic}`;
      fields.appendChild(p);
    }
    item.appendChild(cb);
    item.appendChild(fields);
    box.appendChild(item);
  });

  const actions = document.createElement('div');
  actions.className = 'cand-actions';
  const add = document.createElement('button');
  add.className = 'btn primary small';
  add.textContent = '加入本课知识点';
  add.disabled = courseId == null;
  add.addEventListener('click', () => saveCandidates(box));
  const cancel = document.createElement('button');
  cancel.className = 'btn small';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => { clearCandidates(); setStatus('已取消，未写入任何内容'); });
  actions.appendChild(add);
  actions.appendChild(cancel);
  box.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'cand-head';
  note.style.marginTop = '6px';
  note.textContent = '写入后会标成「球抓取 · 待核对」，来源可追溯；只有你核对过才算数。';
  box.appendChild(note);

  area.appendChild(box);
  setStatus(`提炼出 ${candidates.length} 个候选`);
}

function saveCandidates(box) {
  const checked = Array.from(box.querySelectorAll('input[type=checkbox]'))
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.idx));
  const items = checked
    .map((i) => candidates[i])
    .filter((c) => c && String(c.topic || '').trim())
    .map((c) => {
      const o = { topic: c.topic.trim() };
      if (c.summary && c.summary.trim()) o.summary = c.summary.trim();
      if (c.detail && c.detail.trim()) o.detail = c.detail.trim();
      if (c.parent_topic && c.parent_topic.trim()) o.parent_topic = c.parent_topic.trim();
      return o;
    });
  if (items.length === 0) { setStatus('没有勾选任何知识点'); return; }
  if (courseId == null) { setStatus('请先选一门课程'); return; }

  box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  setStatus(`正在加入 ${items.length} 条…`);
  window.api.relateSave({
    courseId,
    items,
    sourceRef: lastRelateText ? lastRelateText.slice(0, 200) : '',
  });
}

window.api.onRelateSaved((msg) => {
  if (!msg) return;
  const area = candArea(); // 已被清掉时重建一个，避免"写进去了却什么都不显示"
  if (msg.ok) {
    candidates = [];
    area.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'cand-head';
    line.style.color = 'var(--ok)';
    line.textContent = `✓ 已写入这门课的先验知识 ${msg.count} 条（来源：球抓取 · 待核对），可在春晓「课程」页核对。`;
    area.appendChild(line);
    setStatus(`已加入 ${msg.count} 条知识点`);
  } else {
    // 失败**保留候选**（用户可改完重试），只把原因追加进去并放开按钮
    area.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    const err = document.createElement('div');
    err.className = 'cand-head';
    err.style.color = 'var(--danger)';
    err.textContent = '加入失败：' + (msg.error || '未知错误') + '（候选还在，改完可以再试一次）';
    area.appendChild(err);
    setStatus('加入失败：' + (msg.error || '未知错误'));
  }
});

$('btnRelate').addEventListener('click', relateNow);

// 主程序从命令行/托盘发起的任务
window.api.onExternalRunTask(({ kind, opts }) => {
  const text = (opts && (opts.text || opts.question)) || '';
  if (text) { $('source').value = text; autoGrow(); }
  if (kind === 'relate') relateNow();
  else if (kind === 'ask') askNow();
});

// ---------------------------------------------------------------------------
// 抓取模式（自动抓取 / 手动拖入）—— **两个带文字的按钮**，正文里常驻可见
// ---------------------------------------------------------------------------
function syncGrabButtons() {
  const auto = pendingGrabMode !== 'manual';
  $('qAuto')?.classList.toggle('active', auto);
  $('qManual')?.classList.toggle('active', !auto);
  $('grabAuto')?.classList.toggle('active', auto);
  $('grabManual')?.classList.toggle('active', !auto);
  const hint = $('grabHint');
  if (hint) {
    hint.textContent = auto
      ? '🔄 自动模式：鼠标选中文字松开即自动抓取并弹出面板'
      : '✋ 手动模式：不主动抓取，把选中的文字拖到悬浮球或本面板的「抓取的内容」框里';
  }
}

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
$('qAuto')?.addEventListener('click', () => { if (pendingGrabMode !== 'auto') applyGrabModeLive('auto'); });
$('qManual')?.addEventListener('click', () => { if (pendingGrabMode !== 'manual') applyGrabModeLive('manual'); });
$('grabAuto')?.addEventListener('click', () => { if (pendingGrabMode !== 'auto') applyGrabModeLive('auto'); });
$('grabManual')?.addEventListener('click', () => { if (pendingGrabMode !== 'manual') applyGrabModeLive('manual'); });

// ---------------------------------------------------------------------------
// 顶栏其余按钮
// ---------------------------------------------------------------------------
$('btnSkinPicker').addEventListener('click', () => window.api.openSkinPicker());
$('btnTheme').addEventListener('click', () => toggleTheme());
$('btnApp').addEventListener('click', async () => {
  const text = currentContent() || currentQuestion() || '';
  const res = await window.api.pushToApp(text, 'prefill');
  if (res && res.ok) setStatus(text ? '已把「抓取的内容」推送到春晓主窗口' : '已拉起春晓');
  else setStatus('操作失败：' + ((res && res.error) || '未知错误'));
});
$('btnSettings').addEventListener('click', async () => {
  $('setDrawer').classList.toggle('open');
  if ($('setDrawer').classList.contains('open')) await fillSettings();
});
$('btnClose').addEventListener('click', () => window.api.hidePanel());

// 顶栏拖动（位移按"起始位置 + 光标增量"计算，见 main.js 的 panel:move）
const topBar = $('top');
let drag = null;
topBar.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
  topBar.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(e.screenX - drag.sx) > 3 || Math.abs(e.screenY - drag.sy) > 3) drag.moved = true;
  if (drag.moved && window.api.move) window.api.move(dx, dy);
});
window.addEventListener('mouseup', () => { if (drag) { topBar.classList.remove('dragging'); drag = null; } });

// ---------------------------------------------------------------------------
// 设置抽屉
// ---------------------------------------------------------------------------
const PROVIDERS = {
  deepseek:  { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai:    { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  dashscope: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu:     { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  moonshot:  { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  qwen:      { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  glm:       { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }
};

async function fillSettings() {
  if (!cfgCache) cfgCache = (await window.api.getState()).config;
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

$('cfgProvider').addEventListener('change', () => {
  const key = $('cfgProvider').value;
  if (PROVIDERS[key]) {
    $('cfgBase').value = PROVIDERS[key].baseURL;
    $('cfgModel').value = PROVIDERS[key].model;
  }
});

function keyToHotkey(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Cmd');
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

$('btnTest').addEventListener('click', async () => {
  const baseURL = $('cfgBase').value.trim() || cfgCache.ai.baseURL;
  const apiKey = $('cfgKey').value.trim() || cfgCache.ai.apiKey;
  if (!apiKey) { setStatus('请先填写 API Key'); return; }
  if (!baseURL) { setStatus('请先填写 API 地址'); return; }
  setStatus('测试中…');
  const r = await window.api.testKey({ baseURL, apiKey });
  setStatus(r.message);
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
(async function init() {
  const st = await window.api.getState();
  const config = st.config;
  cfgCache = config;
  pendingGrabMode = config.grabMode === 'manual' ? 'manual' : 'auto';
  syncGrabButtons();
  applyTheme(THEMES[config.theme || 'dark']);
  courses = Array.isArray(st.courses) ? st.courses : [];
  courseId = st.courseId != null ? Number(st.courseId) : null;
  renderCourses();
  renderImages();
  autoGrow();
  $('source').focus();
  // R5.2：面板一打开就**主动要一次**课程列表 —— 课程只在主程序 push 时才有的话，
  //   点球 / 热键 / 托盘这几条打开路径会得到一个空下拉（0.7.1 的真实缺陷）。
  if (window.api.requestCourses) void window.api.requestCourses();
  if (!config.ai.apiKey) setStatus('未配置 API Key，请点 ⚙ 填写');
})();
