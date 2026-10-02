// 春晓学习助手 · 浏览器层 UI 冒烟（CDP 直连，无第三方依赖）
//
//   powershell -File scripts/smoke-ui.ps1        # 推荐：它负责起 Edge 无头 + 收尾
//   node scripts/smoke-ui.mjs                    # 或直连已开的 CDP 端点（默认 127.0.0.1:9222）
//
// 为什么需要这一层：Rust 单测、桌面冒烟、桥接冒烟都验证不到**渲染出来的界面**。
// 本脚本在真实 Chromium 内核里加载 `npm run dev` 提供的预览版页面，
// 断言 DOM 真的渲染出预期元素，并收集 console 报错与失败请求。
//
// ⚠ 浏览器预览模式（!isTauri()）走 `src/data/sample.ts` 的示例数据，
//   因此这里验证的是 UI 渲染与预览降级路径；**桌面 SQLite 链路不由本脚本覆盖**
//   （那是 scripts/smoke-desktop.ps1 与 Rust 单测的职责）。

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const BASE = process.env.APP_URL || "http://localhost:1420";
const TIMEOUT_MS = Number(process.env.UI_TIMEOUT_MS || 20000);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function getJson(path, method = "GET") {
  const res = await fetch(CDP + path, { method });
  return res.json();
}

// 记录所有 WebSocket，退出前统一关闭。
// ⚠ 不能直接 process.exit()：那时 WS 仍在关闭中，Node 会触发
//    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并让进程异常终止
//    （表现为莫名其妙的退出码 0xC0000409），从而吞掉真实结论。
const sockets = new Set();

async function finish(code) {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
  await new Promise((r) => setTimeout(r, 150));
  process.exit(code);
}

/** 极简 CDP 客户端：连一个 target 的 WebSocket，按 id 关联响应 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, TIMEOUT_MS);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("页面内异常：" + (r.exceptionDetails.text || "unknown"));
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.add(ws);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error("WebSocket 连接失败：" + (e.message || url))));
  });
}

/** 打开一个新标签页并建立会话。
 *  ⚠ Edge/Chrome 111+ 的 `/json/new` **只接受 PUT**：用 GET 会返回
 *  "Using unsafe HTTP verb GET to invoke /json/new"，随后 JSON 解析报错。 */
async function openPage() {
  const t = await getJson("/json/new?about:blank", "PUT");
  const ws = await connect(t.webSocketDebuggerUrl);
  const s = new CdpSession(ws);
  await s.send("Page.enable");
  await s.send("Runtime.enable");
  await s.send("Log.enable");
  await s.send("Network.enable");
  return { session: s, targetId: t.id };
}

async function closePage(targetId) {
  try {
    await fetch(`${CDP}/json/close/${targetId}`);
  } catch {
    /* ignore */
  }
}

/** 收集一次导航期间的 console 报错与失败请求 */
function attachCollectors(session) {
  const errors = [];
  const failedRequests = [];
  const badResponses = [];
  session.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" ");
      errors.push(text);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push(msg.params.entry.text);
    } else if (msg.method === "Network.loadingFailed") {
      failedRequests.push(`${msg.params.requestId}: ${msg.params.errorText}`);
    } else if (msg.method === "Network.responseReceived") {
      // 记下 **具体 URL**：只说"有个 404"没法定位，必须给出是哪个资源
      const r = msg.params.response || {};
      if (typeof r.status === "number" && r.status >= 400) {
        badResponses.push(`${r.status} ${r.url}`);
      }
    }
  });
  return { errors, failedRequests, badResponses };
}

async function goto(session, path) {
  const url = `${BASE}${path}`;
  await session.send("Page.navigate", { url });
  // 等 body 有内容（SPA 渲染是异步的）
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const n = await session.eval("document.body ? document.body.innerText.length : 0");
      if (n && n > 40) return url;
    } catch {
      /* 导航中会短暂失败 */
    }
  }
  return url;
}

/** 页面文本（判定用），失败返回空串 */
async function text(session) {
  try {
    return (await session.eval("document.body.innerText")) || "";
  } catch {
    return "";
  }
}

/**
 * 展开页面上所有 `<details>`（折叠区），用于**逐字校验被收进折叠区的契约项**。
 *
 * ⚠ 为什么必须有它：`document.body.innerText` **只包含当前渲染出来的文本**，
 *   收起状态的 `<details>` 内容不在其中。R3 起，掌握度公式、诚实边界原文这类
 *   工程口径被收进折叠区（主界面只留大白话），但契约 §一 的**逐字验收项**
 *   （「不是强化学习」「模型权重不会因此改变」）依然必须存在 ——
 *   所以校验前先展开：既不放弃逐字校验，也不会因为"收起来了"而误判通过。
 */
async function expandDetails(session) {
  try {
    await session.eval(
      "(() => { let n = 0; document.querySelectorAll('details').forEach((d) => { if (!d.open) { d.open = true; n++; } }); return n; })()",
    );
    // 展开后等一帧，确保 innerText 已按新布局重算
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    /* 页面没有 details 时忽略 */
  }
}

async function count(session, selector) {
  try {
    return (await session.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) || 0;
  } catch {
    return 0;
  }
}

async function attr(session, selector, name) {
  try {
    return await session.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`,
    );
  } catch {
    return null;
  }
}

async function main() {
  console.log(`CDP: ${CDP}\n应用: ${BASE}\n`);

  // ---- 初始状态：确认服务可达 ----
  let info;
  try {
    info = await getJson("/json/version");
  } catch (e) {
    console.error(`无法连上 CDP（${CDP}）：${e.message}`);
    console.error("请先由 scripts/smoke-ui.ps1 启动 Edge 无头，或手动：");
    console.error(
      '  msedge.exe --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cx-ui --window-size=1440,900 about:blank',
    );
    await finish(2);
  }
  console.log(`浏览器: ${info.Browser}`);
  try {
    const r = await fetch(BASE);
    console.log(`应用服务: HTTP ${r.status}（vite 预览）\n`);
  } catch (e) {
    console.error(`应用不可达（${BASE}）：请先 npm run dev。${e.message}`);
    await finish(2);
  }

  const { session, targetId } = await openPage();
  const { errors, badResponses } = attachCollectors(session);

  try {
    // ---------------- 入口（R6：已删掉「首页总览」，打开即落在课程页） ----------------
    // ⚠ R6 之前这里验的是 `/#/home` 首页。用户要求「先选择课程」并**删掉首页**，
    //   所以断言跟着改成：**根路径必须落到课程页**、旧链接 `/#/home` 不 404（重定向过去）。
    console.log("[1/10] 入口：根路径落到「课程」（旧的 /#/home 重定向）");
    await goto(session, "/#/");
    let t = await text(session);
    ok("渲染出内容", t.length > 40, `文本长度 ${t.length}`);
    ok("显示「本地单机 · 数据在本机」", t.includes("本地单机"), "未找到本机数据文案");
    ok(
      "根路径重定向到课程页",
      (await session.eval("location.hash")) === "#/courses",
      `实际 ${await session.eval("location.hash")}`,
    );
    await goto(session, "/#/home");
    ok(
      "旧的 /#/home 也能落到课程页（不 404）",
      (await session.eval("location.hash")) === "#/courses",
      `实际 ${await session.eval("location.hash")}`,
    );

    // ---------------- R2：吉祥物母版真的被加载并渲染 ----------------
    // 为什么放在这一层：**这是唯一能证明"形象真的画出来了"的地方**。
    // tsc 只能证明 import 语法对；vite build 只能证明被打包进去；
    // 只有真实浏览器里 `naturalWidth > 0` 才能证明 SVG 母版被解码、
    // 而不是一个 200 但内容坏掉的文件（那种情况不会 4xx，资源检查抓不到）。
    console.log("  · 吉祥物母版（R2）");
    const imgInfo = await session.eval(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return { src: el.currentSrc || el.src || "", complete: !!el.complete, nw: el.naturalWidth, w: el.width, h: el.height };
      };
      return { brand: pick('.brand-mark img'), list: pick('.course-card') };
    })()`);
    const brandImg = imgInfo && imgInfo.brand;
    ok(
      "侧栏品牌位用的是吉祥物母版（而不是文字方块）",
      !!brandImg && /mascot/.test(brandImg.src),
      JSON.stringify(imgInfo),
    );
    ok(
      "母版真的解码成功（naturalWidth > 0，不是坏图）",
      !!brandImg && brandImg.complete && brandImg.nw > 0,
      JSON.stringify(brandImg),
    );

    // ---------------- /courses ----------------
    console.log("\n[2/10] /courses 课程列表");
    await goto(session, "/#/courses");
    t = await text(session);
    ok("渲染出课程列表", t.includes("课程"), "未见课程相关文案");
    ok("含示例课程（预览数据）", t.includes("示例课程") || t.includes("课程"), "课程卡片缺失");

    // ---------------- /course/:id ----------------
    console.log("\n[3/10] 课程详情（先验知识 + 材料）");
    await goto(session, "/#/course/1");
    t = await text(session);
    ok("渲染出课程详情", t.length > 80, `文本长度 ${t.length}`);
    ok("有「先验知识」与「材料」两个页签", t.includes("先验知识") && t.includes("材料"), "页签缺失");

    // 先验知识的来源徽标（产品红线：AI 生成必须标注来源）
    const priorBadge =
      t.includes("AI 生成") || t.includes("待核对") || t.includes("教材") || t.includes("来源");
    ok("先验知识带来源徽标", priorBadge, "未见来源标注");

    // M2 新增：AI 生成知识骨架入口
    const genBtn = await count(session, "button");
    const hasGen = /AI\s*生成|生成知识骨架/.test(t);
    ok("有「AI 生成知识骨架」入口", hasGen, `按钮数 ${genBtn}，未匹配到入口文案`);

    // 材料页签
    const matTab = await session.eval(`(() => {
      const el = [...document.querySelectorAll('button, .tab, [role="tab"]')]
        .find(n => (n.textContent || '').includes('材料'));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    ok("可切到「材料」页签", matTab === true, "未找到可点击的页签");
    if (matTab) {
      await new Promise((r) => setTimeout(r, 400));
      t = await text(session);
      ok("材料页签渲染出内容", t.includes("材料"), "切换后内容为空");
      ok("导入入口存在（accept 多格式）", (await count(session, 'input[type="file"]')) > 0, "未找到文件输入");
      const accept = await attr(session, 'input[type="file"]', "accept");
      const acceptOk = !!accept && accept.includes(".pdf") && accept.includes(".docx");
      ok("导入接受 pdf 与 docx", acceptOk, `accept=${accept}`);
    }

    // ---------------- /assistant ----------------
    console.log("\n[4/10] /assistant 对话页");
    await goto(session, "/#/assistant");
    t = await text(session);
    ok("渲染出对话页", t.length > 40, `文本长度 ${t.length}`);
    const hasToggle = /先查材料|先查课程材料|材料/.test(t);
    ok("有「先查材料」开关", hasToggle, "未见材料检索开关");
    ok("有输入框", (await count(session, "textarea, input[type=text]")) > 0, "未找到输入框");

    // ---- R7：输入区与消息区**同宽**（用户实测反馈："输入窗口要跟上面的一样宽"）----
    // 根因：`.assistant-input textarea` 原本没给 `width` —— `<textarea>` 不给宽度时，
    //   宽度由 `cols` 属性决定（默认 20 字符 ≈ 190px），而它外面那层 `.assistant-drop`
    //   只是普通 block（不是 flex 子项），不会替它拉伸。于是输入框比消息区窄一大截。
    // 断言口径：两者都是 `.assistant-page`（flex column）的子项，应当撑满同一容器宽度。
    const w = await session.eval(`(() => {
      const m = document.querySelector('.assistant-messages');
      const ta = document.querySelector('.assistant-input textarea');
      if (!m || !ta) return null;
      return {
        messages: Math.round(m.getBoundingClientRect().width),
        input: Math.round(ta.getBoundingClientRect().width)
      };
    })()`);
    ok(
      "输入框与上方消息区同宽（R7 修：原来只有 cols=20 的宽度）",
      !!(w && Math.abs(w.messages - w.input) <= 2),
      JSON.stringify(w),
    );

    // ---- R7：AI 回复走 Markdown 渲染（旧债 T28）----
    // 用 `?course=1` 进入：这样被选中的必定是示例会话 31，它那条回答**故意写成 Markdown**
    // （见 `src/data/sample.ts` 里同一处注释）。断言必须能区分"真渲染"与"原样显示"：
    //   · 真渲染 → 有 `.md-body`、真 `<h2 class="md-heading">`、真 `<ul class="md-list">`；
    //   · 没渲染 → 那些 `#` / `**` 会原样留在气泡的 textContent 里。
    await goto(session, "/#/assistant?course=1");
    const md = await session.eval(`(() => {
      const bubble = document.querySelector('.msg.assistant .msg-bubble');
      if (!bubble) return { found: false };
      const txt = bubble.textContent || '';
      return {
        found: true,
        hasBody: !!bubble.querySelector('.md-body'),
        heading: (bubble.querySelector('.md-heading') || {}).textContent || '',
        listItems: bubble.querySelectorAll('.md-list li').length,
        bold: bubble.querySelectorAll('strong').length,
        rawMarkers: /#{1,6}\\s/.test(txt) || /\\*\\*/.test(txt)
      };
    })()`);
    ok("AI 回复走 Markdown 渲染（气泡里有 .md-body）", !!(md && md.found && md.hasBody), JSON.stringify(md));
    ok("标题渲染成真标题（不再是一堆 #）", !!(md && /一句话结论/.test(md.heading)), JSON.stringify(md));
    ok("列表渲染成真列表", !!(md && md.listItems >= 2), JSON.stringify(md));
    ok("气泡里不再原样出现 # 与 ** 标记", !!(md && !md.rawMarkers), JSON.stringify(md));

    // 紧凑模式（?float=1）—— M0 起就该正确
    await goto(session, "/#/assistant?float=1");
    const compact = await session.eval(`(() => ({
      hasShell: !!document.querySelector('.float-shell'),
      sidebar: document.querySelectorAll('.sidebar').length,
      topbar: document.querySelectorAll('.topbar').length
    }))()`);
    ok("?float=1 紧凑模式生效", compact && compact.hasShell === true, JSON.stringify(compact));
    ok("紧凑模式下无侧栏与顶栏", compact && compact.sidebar === 0 && compact.topbar === 0, JSON.stringify(compact));

    // ---------------- R4：粘贴图片提问（答疑页） ----------------
    // 真造一个 ClipboardEvent（带一张 1×1 PNG）打到 textarea 上，再断言：
    //   ① 出现了待发送缩略图；② 发送按钮如实变成「含 N 图」。
    // 为什么不用 Input.dispatchKeyEvent：那要真往系统剪贴板塞图，会污染用户剪贴板；
    // 这里构造的 DataTransfer 走的是**同一条** onPaste 处理链路。
    console.log("  · R4：答疑页粘贴图片");
    await goto(session, "/#/assistant");
    const pasted = await session.eval(`(async () => {
      const ta = document.querySelector('.assistant-input textarea') || document.querySelector('textarea');
      if (!ta) return { ok: false, why: '没找到 textarea' };
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      // 等一拍：压缩走的是 canvas → 异步
      await new Promise((r) => setTimeout(r, 400));
      const thumbs = document.querySelectorAll('.img-thumb img').length;
      const btn = [...document.querySelectorAll('.assistant-input button')]
        .map((b) => b.textContent || '').find((x) => /发送|生成中/.test(x)) || '';
      return { ok: true, thumbs, btn };
    })()`);
    ok("粘贴图片后出现待发送缩略图", !!(pasted && pasted.ok && pasted.thumbs > 0), JSON.stringify(pasted));
    ok(
      "发送按钮如实标注图片数量",
      !!(pasted && pasted.ok && /含\s*\d+\s*图/.test(pasted.btn)),
      `按钮文本=${pasted && pasted.btn}`,
    );
    const thumbBox = await session.eval(
      `(() => { const el = document.querySelector('.img-thumb img'); if (!el) return null; return { src: String(el.getAttribute('src') || '').slice(0, 22), w: el.naturalWidth }; })()`,
    );
    ok(
      "缩略图真的是 data: 图片且能解码（不是坏图）",
      !!(thumbBox && thumbBox.src.startsWith('data:image/') && thumbBox.w > 0),
      JSON.stringify(thumbBox),
    );

    // ---------------- /settings ----------------
    console.log("\n[5/10] /settings 数据设置（BYOK）");
    await goto(session, "/#/settings");
    t = await text(session);
    ok("渲染出设置页", t.length > 40, `文本长度 ${t.length}`);
    ok("有 API 地址 / Key / 模型字段", t.includes("API") || t.includes("Key"), "缺少 BYOK 字段");
    ok("有「测试连接」", t.includes("测试") , "缺少测试连接入口");
    ok("含诚实边界说明（不面向考试 / 数据在本机）", /不面向考试|课后|本机/.test(t), "缺少边界说明");
    // R4：图片识别（可选视觉模型）+ 三种图片提问方式
    ok("有「图片识别」区（可单独指定视觉模型）", /图片识别/.test(t), "缺少图片识别配置入口");
    const modeChips = await session.eval(
      `(() => { const want = ['自动','直接发图','先转成文字']; const got = [...document.querySelectorAll('.chip')].map((c) => (c.textContent||'').trim()); return want.filter((w) => got.includes(w)); })()`,
    );
    ok(
      "有「图片提问方式」三档（自动 / 直接发图 / 先转成文字）",
      Array.isArray(modeChips) && modeChips.length === 3,
      JSON.stringify(modeChips),
    );
    ok(
      "如实说明「现在会怎么走」",
      /现在会怎么走/.test(t),
      "缺少图片路由的如实说明",
    );

    // ---------------- 全站占位措辞扫描 ----------------
    // M4 之后所有板块都应落地，因此这里从"逐页查占位"改成**全站扫描**：
    // 任何路由都不该再出现"未实现 / 占位 / 方案稿 / Mn 实现"这类措辞。
    // 这条断言在"某页忘了接线"时特别有用（比逐个断言更防退化）。
    //
    // R3 追加同类扫描：**全站主界面不得出现工程口径原文**（公式、evidence、
    // localStorage、字段名/命令名……）。它们应当被收进可折叠的「说明」区 ——
    // 折叠状态下 `innerText` 取不到，所以这条扫描同时也在守护"默认收起"。
    // ⚠ 这条是"漏改一处就红"的守门断言：加文案时别把实现细节写回主界面。
    console.log("\n[6/10] 全站占位措辞扫描（不得有任何板块仍是占位页）");
    const ENGINEERING_LEAK =
      /拉普拉斯平滑|evidence\s*=\s*attempts|mastery\s*=\s*\(correct|localStorage|本机数据库|by_day|durationMs|profile_overview|focus_stats|严格\s*JSON/;
    for (const path of [
      "/#/home",
      "/#/courses",
      "/#/assistant",
      "/#/settings",
      "/#/notes",
      "/#/focus",
      "/#/questions",
      "/#/profile",
    ]) {
      await goto(session, path);
      const tx = await text(session);
      const hit = tx.match(/(未实现|占位|方案稿|待实现|M[0-9]\s*(实现|开放))/);
      ok(`${path} 无占位措辞`, !hit, `仍出现：${hit ? hit[0] : ""}`);
      const leak = tx.match(ENGINEERING_LEAK);
      ok(
        `${path} 主界面无工程口径原文（已收进折叠区）`,
        !leak,
        `仍出现：${leak ? leak[0] : ""} —— 应改为大白话或放进 <TechNote> 折叠区`,
      );
    }

    // ---------------- 诚实红线边界用例 ----------------
    console.log("\n[7/10] 边界用例（诚实红线：未配 Key 时不得假装有 AI）");

    await goto(session, "/#/course/1");
    const priorBefore = await count(session, '[class*="prior"]');
    const gen = await session.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(n => /AI\\s*生成|生成知识骨架/.test(n.textContent || ''));
      if (!b) return { found: false };
      return { found: true, disabled: !!b.disabled };
    })()`);
    ok("找得到「AI 生成知识骨架」按钮", !!(gen && gen.found), JSON.stringify(gen));
    if (gen && gen.found) {
      if (gen.disabled) {
        ok("未配 Key 时按钮被禁用（如实拦截，不给假结果）", true);
      } else {
        await session.eval(`(() => {
          const b = [...document.querySelectorAll('button')].find(n => /AI\\s*生成|生成知识骨架/.test(n.textContent || ''));
          if (b) b.click();
        })()`);
        await new Promise((r) => setTimeout(r, 1500));
        const tx = await text(session);
        ok(
          "未配 Key 时点击给出如实提示（引导去数据设置）",
          /数据设置|配置|API\s*Key/.test(tx),
          `未出现配置引导，文本长度 ${tx.length}`,
        );
        const priorAfter = await count(session, '[class*="prior"]');
        ok("未配 Key 时不得凭空插入先验知识", priorAfter <= priorBefore, `${priorBefore} → ${priorAfter}`);
      }
    }

    console.log("  · 对话页：未配 Key 发消息");
    await goto(session, "/#/assistant");
    const typed = await session.eval(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      // React 受控组件：必须走原生 value setter 再派发 input，否则 state 不更新
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, '什么是梯度下降？');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    ok("能把问题填进输入框（React 受控组件）", typed === true, "未找到 textarea");
    if (typed) {
      await session.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(n => /发送|提问/.test((n.textContent || '').trim()));
        if (b) b.click();
      })()`);
      let reply = "";
      const dl = Date.now() + 8000;
      while (Date.now() < dl) {
        await new Promise((r) => setTimeout(r, 300));
        reply = await text(session);
        if (/演示模式|不是\s*AI/.test(reply)) break;
      }
      ok(
        "未配 Key 时进入演示模式并明说「不是 AI 的回答」",
        /演示模式|不是\s*AI/.test(reply),
        "未出现演示模式说明：" + reply.slice(-160).replace(/\s+/g, " "),
      );
    }

    // ---------------- 新功能板块：笔记 / 番茄钟 ----------------
    console.log("\n[8/10] 新功能板块：笔记 / 番茄钟 / 题库 / 画像");
    // ⚠ 断言必须能**区分"真实页面"与"占位页"**：占位页同样会出现板块名、"创建"等词，
    //   早先版本就因此出现过"假通过"。这里额外断言**不出现占位措辞**，
    //   并要求真实控件/倒计时的特征文本。
    const PLACEHOLDER = /未实现|占位|方案稿|待实现|M[0-9]\s*(实现|开放)/;

    await goto(session, "/#/notes");
    const nt = await text(session);
    ok("笔记页已替换占位（无占位措辞）", !PLACEHOLDER.test(nt), "仍出现占位措辞：" + (nt.match(PLACEHOLDER) || [""])[0]);
    ok("有生成笔记入口", /生成笔记|新建笔记|笔记.{0,4}生成|生成.{0,4}笔记/.test(nt), "未见生成笔记入口");
    ok("注明内容来源或待核对口径", /待核对|AI\s*整理|自己写的|来源/.test(nt), "未见来源标注口径");

    console.log("  · 番茄钟页 /focus");
    await goto(session, "/#/focus");
    const ft = await text(session);
    ok("番茄钟页已替换占位（无占位措辞）", !PLACEHOLDER.test(ft), "仍出现占位措辞：" + (ft.match(PLACEHOLDER) || [""])[0]);
    ok("显示倒计时（MM:SS）", /\d{2}:\d{2}/.test(ft), "未看到倒计时");
    ok("有计时控件（开始/暂停）", /开始|暂停/.test(ft), "未见计时控件");
    ok(
      "写明「只计时与记录、不改动模型」",
      /不改动|只做?计时|仅计时|只计时/.test(ft),
      "缺少诚实边界说明",
    );
    ok("无数据时如实显示「暂无记录」而非造数据", /暂无记录|暂无数据|还没有/.test(ft), "未见如实空状态");

    // ---- 行为验证：只断言"有 MM:SS 文案"不够，必须证明计时器真的在走/暂停真的停 ----
    const readClock = () =>
      session.eval(`(() => { const m = document.body.innerText.match(/\\d{1,2}:\\d{2}/); return m ? m[0] : null; })()`);
    const clickByText = (re) =>
      session.eval(
        `(() => {
          const b = [...document.querySelectorAll('button')].find(n => ${re}.test((n.textContent || '').trim()));
          if (!b) return false;
          b.click();
          return true;
        })()`,
      );

    const c0 = await readClock();
    const started = await clickByText("/^开始/");
    ok("能找到并点击「开始」", started === true, "未找到以「开始」开头的按钮");
    if (started) {
      await new Promise((r) => setTimeout(r, 2600));
      const c1 = await readClock();
      ok("点击开始后倒计时真的在走", !!c0 && !!c1 && c1 !== c0, `前 ${c0} → 2.6s 后 ${c1}`);

      const paused = await clickByText("/^暂停/");
      ok("能找到并点击「暂停」", paused === true, "未找到以「暂停」开头的按钮");
      if (paused) {
        const p1 = await readClock();
        await new Promise((r) => setTimeout(r, 1800));
        const p2 = await readClock();
        ok("暂停后倒计时停住（既不走也不回退）", !!p1 && p1 === p2, `暂停时 ${p1} → 1.8s 后 ${p2}`);
      }
    }

    // ⚠ 判别"真实页面 vs 占位页"必须用**结构**依据，不能只比文案：
    //   ① 占位组件渲染 `.content .placeholder`（`Placeholder.tsx` 的 className）；
    //   ② 真实页面在**内容区**应有交互控件 —— 注意必须限定 `.content` 内，
    //      否则侧栏/顶栏的按钮会污染计数（本脚本第一版就在这儿假通过过）。
    const isPlaceholder = async () => (await count(session, ".content .placeholder")) > 0;
    const hasContentControls = async () =>
      (await count(session, ".content button, .content input, .content select, .content textarea")) > 0;

    console.log("  · 题库页 /questions");
    await goto(session, "/#/questions");
    const qt = await text(session);
    const qPh = await isPlaceholder();
    ok("题库页不是占位组件", !qPh, "内容区仍是 .placeholder —— 占位页");
    ok("题库页内容区含交互控件", await hasContentControls(), "内容区未找到 button/input/select/textarea");
    ok(
      "有练习/生成入口",
      !qPh && /练习|生成|出题/.test(qt),
      qPh ? "页面非真实实现" : "未见练习/生成入口",
    );
    ok("有错题本入口", !qPh && /错题/.test(qt), qPh ? "页面非真实实现" : "未见错题本");

    console.log("  · 学习画像页 /profile");
    await goto(session, "/#/profile");
    // R3 产品决定：工程口径（公式 / evidence / 诚实边界原文）**默认收进折叠区**，
    //   主界面只留大白话。因此这里分两步：
    //     ① 先按"收起态"取文本 → 守门断言「主界面不得出现工程口径原文」；
    //     ② 再展开折叠区取文本 → 契约 §一的**逐字**验收项照旧逐条校验。
    const ptCollapsed = await text(session);
    const pPh = await isPlaceholder();
    ok("画像页不是占位组件", !pPh, "内容区仍是 .placeholder —— 占位页");
    ok("画像页内容区含交互控件", await hasContentControls(), "内容区未找到 button/input/select/textarea");
    ok(
      "工程口径默认收进折叠区（主界面不含公式 / evidence 原文）",
      !pPh && !/拉普拉斯平滑|evidence\s*=\s*attempts|模型权重不会因此改变/.test(ptCollapsed),
      "主界面上仍直接出现工程口径原文 —— R3 的「主界面只讲大白话」被破坏",
    );
    await expandDetails(session);
    const pt = await text(session);
    // ---- 口径红线：契约 §一 把这几条列为**验收项**，必须在"渲染结果"里逐条对上 ----
    //  门槛用 `!pPh`：占位页的模块清单里本来就写着这些词，不加门槛会"假通过"。
    ok(
      "含「不是强化学习」声明（真实页面内）",
      !pPh && /不是强化学习/.test(pt),
      pPh ? "页面非真实实现" : "缺少核心口径声明（契约要求逐字出现）",
    );
    ok(
      "含「模型权重不会因此改变」（真实页面内）",
      !pPh && /模型权重不会因此改变/.test(pt),
      pPh ? "页面非真实实现" : "缺少「模型权重不会因此改变」",
    );
    ok(
      "含「只在本机 / 不参与训练」口径（真实页面内）",
      !pPh && /只在本机|不参与任何模型训练|上传与训练都不发生/.test(pt),
      pPh ? "页面非真实实现" : "缺少本机口径",
    );
    ok(
      "展示掌握度时带样本数口径（真实页面内）",
      !pPh && /样本|证据|次数/.test(pt),
      pPh ? "页面非真实实现" : "未见样本数口径",
    );
    ok(
      "无数据时如实显示「暂无记录 / 样本不足」（真实页面内）",
      !pPh && /暂无记录|暂无数据|样本不足|还没有/.test(pt),
      pPh ? "页面非真实实现" : "未见如实空状态",
    );

    // ---------------- R1：对话按课程展开（会话课程归属） ----------------
    // 契约 `docs/11-R1对话课程归属与先验知识提炼契约.md` §一 / §3.1 / §3.2，验**渲染出来的结果**：
    //   · 当前课程上下文必须始终可见；
    //   · 检索范围文案必须与所选课程一致（有上下文时不得再声称按"本机全库"检索）；
    //   · 必须能选到「不限定课程」——即不得静默套用"最近使用的课程"（§一 第 3 条）。
    // ⚠ 这一层正是唯一能抓到"接线缺失"的地方：Rust 单测 / 桌面冒烟 / 桥接冒烟都只验后端，
    //   而 R1 修的那个缺陷（`useChat` 从没拿到 `courseId`）恰恰只在渲染结果里露出。
    console.log("\n[9/10] R1：对话课程归属（检索范围 / 课程上下文 / 课程页入口）");
    const optionTexts = async () =>
      (await session.eval(
        `[...document.querySelectorAll('.content option')].map(o => o.textContent || '').join(' | ')`,
      )) || "";

    await goto(session, "/#/assistant?course=1");
    const at1 = await text(session);
    const sel1 = await count(session, ".content select");
    ok("对话页有课程选择器（内容区 select）", sel1 > 0, `内容区 select 数 = ${sel1}`);
    ok("有课程上下文时显示「检索范围」", /检索范围/.test(at1), "未出现「检索范围」");
    ok(
      "有课程上下文时不再声称按「全部课程材料（本机全库）」检索",
      !/全部课程材料（本机全库）/.test(at1),
      "仍写着全库 —— 检索范围与界面显示不一致（契约 §一 第 2 条）",
    );
    ok(
      "课程选择器里能选到「不限定课程」",
      /不限定课程/.test(await optionTexts()),
      "选项里没有「不限定课程」",
    );

    await goto(session, "/#/assistant");
    ok(
      "无课程参数时同样能选到「不限定课程」（不静默套用最近课程）",
      /不限定课程/.test(await optionTexts()),
      "选项里没有「不限定课程」",
    );

    // 课程页两个新入口：必须有**明确文案**，不靠"有交互控件"这类弱断言
    await goto(session, "/#/course/1");
    const rct = await text(session);
    const rcPh = await isPlaceholder();
    ok("课程页不是占位组件", !rcPh, "课程页是占位页");
    ok("课程页有「与该课程对话」入口", /与该课程对话/.test(rct), "未找到入口");
    ok(
      "课程页有「从本课对话提炼先验知识」入口",
      /提炼先验知识|从对话提炼/.test(rct),
      "未找到提炼入口",
    );

    // ---------------- R5：悬浮球对话记录与主窗口分开 ----------------
    // 契约 `docs/16-悬浮球轻量化与关联知识点契约.md` §六，验**渲染出来的结果**：
    //   · 默认只列主窗口的会话（球的记录不混进来）；
    //   · 必须有「含悬浮球记录」开关，打开后球的会话出现且**带来源徽标**；
    //   · 关掉后又不出现 —— 证明开关真的在起作用，而不是"碰巧出现了"。
    console.log("\n[10/10] R5：悬浮球记录与主窗口分开（开关 + 来源徽标）");
    await goto(session, "/#/assistant");
    ok(
      "对话页有会话区（chip 按钮）",
      (await count(session, ".session-bar button.chip")) > 0,
      "会话区没有 chip 按钮",
    );
    const beforeText = await text(session);
    ok(
      "默认不列悬浮球的会话",
      !/悬浮球问答/.test(beforeText),
      "默认就把球的会话列出来了 —— 没做到「与主窗口分开」",
    );
    ok("页面上有「含悬浮球记录」开关", /含悬浮球记录/.test(beforeText), "未找到开关");
    const clickToggle = async (needle) =>
      await session.eval(
        `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes(${JSON.stringify(needle)})); if (!b) return false; b.click(); return true; })()`,
      );
    ok("点击开关成功", (await clickToggle("含悬浮球记录")) === true, "未找到可点击的开关");
    await new Promise((r) => setTimeout(r, 500));
    const afterText = await text(session);
    ok("打开后列出悬浮球的会话", /悬浮球问答/.test(afterText), "打开后仍看不到球的会话");
    ok("球的会话带来源徽标「球」", (await count(session, ".chip-tag")) > 0, "未见 .chip-tag 徽标");
    await clickToggle("含悬浮球记录");
    await new Promise((r) => setTimeout(r, 500));
    ok("关掉后球会话再次消失", !/悬浮球问答/.test(await text(session)), "关掉后仍在列表里（开关没生效）");

    // ---------------- R9：课程跟随 / 笔记按天 / 一键核对 / 回车发送 ----------------
    // 四项都是用户原话提的，逐条给**能红的断言**：
    //   ①「在顶部切换课程后下面的每个功能对应的课程也要改」——根因是题库页/画像页各自用本地 state
    //     持有课程、**从不读 URL 的 `?course=`**（只有笔记页与对话页读了）。所以断言必须
    //     **换 URL 看页面文字有没有跟着换**：恒为"第一门课"就是没修好。
    //   ②「按天整理」——必须真的分组（≥2 组）、每组有条目、日期倒序。
    //   ③「核对添加一键核对功能」——按钮要标出待核对条数；点下去待核对必须清零、按钮消失。
    //   ④「Enter 发送、Shift+Enter 换行」——行为对：Shift+回车**不发送**、回车**发送**。
    console.log("\n[11/11] R9：课程跟随 · 笔记按天 · 一键核对 · 回车发送");

    const toolbarCourse = async () =>
      (await session.eval(
        `(() => { const el = document.querySelector('.qs-toolbar-note, .pf-toolbar-note'); return el ? (el.textContent || '').trim() : ''; })()`,
      )) || "";

    await goto(session, "/#/questions?course=1");
    const qc1 = await toolbarCourse();
    await goto(session, "/#/questions?course=2");
    const qc2 = await toolbarCourse();
    ok(
      "题库页跟随 URL 课程（换课会跟着换）",
      !!qc1 && !!qc2 && qc1 !== qc2,
      `course=1 → ${qc1} / course=2 → ${qc2}`,
    );
    await goto(session, "/#/profile?course=1");
    const pc1 = await toolbarCourse();
    await goto(session, "/#/profile?course=2");
    const pc2 = await toolbarCourse();
    ok(
      "画像页跟随 URL 课程（换课会跟着换）",
      !!pc1 && !!pc2 && pc1 !== pc2,
      `course=1 → ${pc1} / course=2 → ${pc2}`,
    );

    await goto(session, "/#/notes");
    const dayInfo = await session.eval(`(() => {
      const days = [...document.querySelectorAll('.notes-day')];
      return {
        groups: days.length,
        labels: days.map(d => ((d.querySelector('.notes-day-label') || {}).textContent || '').trim()),
        items: days.map(d => d.querySelectorAll('.notes-item').length),
        text: (document.querySelector('.notes-list-card') || {}).innerText || ''
      };
    })()`);
    ok("笔记列表按天分组（≥2 组）", !!(dayInfo && dayInfo.groups >= 2), JSON.stringify(dayInfo && dayInfo.labels));
    ok("每个分组里都有笔记", !!(dayInfo && dayInfo.items.length > 0 && dayInfo.items.every((n) => n >= 1)), JSON.stringify(dayInfo && dayInfo.items));
    ok(
      "分组按日期倒序（最近的在前）",
      (() => {
        const ls = ((dayInfo && dayInfo.labels) || []).filter((l) => l && l !== "未标日期");
        return ls.length >= 2 && ls.every((l, i) => i === 0 || ls[i - 1] >= l);
      })(),
      JSON.stringify(dayInfo && dayInfo.labels),
    );
    ok(
      "自己写的与 AI 整理的在同一份按天列表里",
      !!(dayInfo && /自己写的/.test(dayInfo.text) && /AI 整理/.test(dayInfo.text)),
      "两种来源没有同时出现在列表里",
    );

    // ③ 一键核对：预览模式下直接改 localStorage 示例库；把 confirm 顶成自动同意
    await goto(session, "/#/course/1");
    const verifyBtn = await session.eval(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /一键核对/.test(x.textContent || '')); return b ? { found: true, text: (b.textContent || '').trim() } : { found: false }; })()`,
    );
    ok(
      "课程页有「一键核对」并标出待核对条数",
      !!(verifyBtn.found && /一键核对（\d+ 条）/.test(verifyBtn.text)),
      JSON.stringify(verifyBtn),
    );
    const verifyRun = await session.eval(`(async () => {
      window.confirm = () => true;
      const unverified = () => document.querySelectorAll('.prior-item.unverified').length;
      const before = unverified();
      const b = [...document.querySelectorAll('button')].find(x => /一键核对/.test(x.textContent || ''));
      if (!b) return { ok: false, why: '没找到「一键核对」按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 700));
      return {
        ok: true,
        before,
        after: unverified(),
        stillThere: [...document.querySelectorAll('button')].some(x => /一键核对/.test(x.textContent || ''))
      };
    })()`);
    ok(
      "一键核对把待核对条目清零",
      !!(verifyRun.ok && verifyRun.before > 0 && verifyRun.after === 0),
      JSON.stringify(verifyRun),
    );
    ok(
      "核对完按钮消失（没有待核对就不摆灰按钮）",
      !!(verifyRun.ok && verifyRun.stillThere === false),
      JSON.stringify(verifyRun),
    );

    // ④ 回车发送 / Shift+回车换行（**行为断言**，不是"有没有绑定"）
    await goto(session, "/#/assistant");
    const enterBehavior = await session.eval(`(async () => {
      const ta = document.querySelector('.assistant-input textarea');
      if (!ta) return { ok: false, why: '没找到输入框' };
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const type = async (v) => {
        set.call(ta, v);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
      };
      const pressEnter = (shift) => ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true
      }));
      const bubbles = () => document.querySelectorAll('.msg.user').length;

      const before = bubbles();
      await type('回车行为断言');
      pressEnter(true);                       // Shift+回车 → 只换行，不发送
      await new Promise(r => setTimeout(r, 400));
      const afterShift = bubbles();
      const textKept = (ta.value || '').length > 0;
      pressEnter(false);                      // 回车 → 发送
      await new Promise(r => setTimeout(r, 1000));
      return { ok: true, before, afterShift, afterEnter: bubbles(), textKept };
    })()`);
    ok(
      "Shift+回车不发送（内容还留在输入框里）",
      !!(enterBehavior.ok && enterBehavior.afterShift === enterBehavior.before && enterBehavior.textKept),
      JSON.stringify(enterBehavior),
    );
    ok(
      "回车发送（消息真的发出去了）",
      !!(enterBehavior.ok && enterBehavior.afterEnter > enterBehavior.before),
      JSON.stringify(enterBehavior),
    );

    // ---------------- R12：课程选择器跟随新建课程 + 笔记沉浸式编辑器 ----------------
    //
    // 用户报的两个问题（原话）：
    //   ①「创建课程后主页左上角顶部的课程选择没有跟着更新」
    //   ②「笔记需要支持多模态……点笔记有一个单独文件窗口」
    //
    // ① 的根因是 `useCourses` 原来**每个组件各持一份 useState 副本**（共 10 份），
    //    只有发起写入的那一份会 refresh；侧栏选择器与顶栏胶囊是常驻组件，永远读不到新课。
    //    ⇒ 本段的关键是**不重新导航**（SPA 内切路由不会重载页面）：建完课直接读 DOM，
    //      这样"共享存储有没有真的广播"才会被验证到；一旦改回独立副本，它就会红。
    // ② 断言编辑页真的打开、工具栏齐、Markdown 有排版、**公式真的渲染成 KaTeX**、
    //    **图片真的能进正文**（用真实 File + DataTransfer 走 input[type=file]）。
    console.log("\n[12/12] R12：课程选择器跟随 · 笔记沉浸式编辑器（多模态）");

    await goto(session, "/#/courses");
    const pickerBefore = await session.eval(
      `(() => { const s = document.querySelector('.course-picker select'); return s ? [...s.options].map(o => o.textContent.trim()) : null; })()`,
    );
    const created = await session.eval(`(async () => {
      const name = '冒烟新课 ' + Date.now();
      const openBtn = [...document.querySelectorAll('button')].find(b => /新建课程/.test(b.textContent || ''));
      if (!openBtn) return { ok: false, why: '没找到「新建课程」按钮' };
      openBtn.click();
      await new Promise(r => setTimeout(r, 200));

      // React 受控 input：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange
      const input = document.querySelector('.form-grid input');
      if (!input) return { ok: false, why: '没找到课程名称输入框' };
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));

      const createBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建课程');
      if (!createBtn) return { ok: false, why: '没找到「创建课程」提交按钮' };
      createBtn.click();
      // 这里**刻意不导航、不刷新**：等的就是共享存储把新课广播给侧栏与顶栏
      await new Promise(r => setTimeout(r, 900));

      const sel = document.querySelector('.course-picker select');
      const opts = sel ? [...sel.options].map(o => o.textContent.trim()) : [];
      const chip = document.querySelector('.course-chip');
      return {
        ok: true,
        name,
        opts,
        hasNew: opts.some(t => t.includes(name)),
        selected: sel ? sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : '' : '',
        chip: chip ? (chip.textContent || '').trim() : '',
        hash: location.hash,
      };
    })()`);

    ok("侧栏课程选择器在新建课程后**无需刷新**就出现新课", !!(created.ok && created.hasNew),
      JSON.stringify({ before: pickerBefore, after: created.opts, why: created.why }));
    ok("新建的课立刻成为当前课程（选择器选中它）", !!(created.ok && created.selected.includes(created.name)),
      "selected=" + created.selected);
    ok("顶栏「当前课程」胶囊同步出现新课名", !!(created.ok && created.chip.includes(created.name)),
      "chip=" + created.chip);

    // —— 编辑页：从笔记列表点进去 ——
    await goto(session, "/#/notes");
    const opened = await session.eval(`(async () => {
      const main = document.querySelector('.notes-item-main');
      if (!main) return { ok: false, why: '笔记列表里没有条目' };
      main.click();
      await new Promise(r => setTimeout(r, 900));
      return {
        ok: true,
        hash: location.hash,
        shell: !!document.querySelector('.editor-shell-inner'),
        // 沉浸式：编辑页**不该**有侧栏与顶栏
        noSidebar: !document.querySelector('.sidebar'),
        noTopbar: !document.querySelector('.topbar'),
        toolbar: document.querySelectorAll('.editor-tool').length,
        hasTextarea: !!document.querySelector('.editor-textarea'),
        hasPreview: !!document.querySelector('.editor-preview'),
      };
    })()`);
    ok("点笔记进入独立编辑页（路由 /note/:id）", !!(opened.ok && /^#\/note\/\d+$/.test(opened.hash)), JSON.stringify(opened));
    ok("编辑页是沉浸式外壳（没有侧栏与顶栏）", !!(opened.shell && opened.noSidebar && opened.noTopbar), JSON.stringify(opened));
    ok("编辑页有工具栏 + 编辑区 + 预览区", !!(opened.toolbar >= 10 && opened.hasTextarea && opened.hasPreview),
      JSON.stringify(opened));

    // —— 多模态：正文输入 → 排版 + 公式（KaTeX）真的渲染 ——
    //    只断言 KaTeX 自己的 `.katex` / `.katex-display` 类，不依赖渲染器的包装类名。
    //    ⚠ 正文里全是反斜杠（LaTeX）：**不要**手写进模板字符串的转义里 ——
    //      在 Node 侧组好后用 `JSON.stringify` 注入，转义由 JSON 负责，可读也可复核。
    const mdForRender = [
      "# 主标题",
      "",
      "## 副标题",
      "",
      "行内公式：$E = mc^2$ 收尾。",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
      "$$",
      "",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n");
    const rendered = await session.eval(`(async () => {
      const ta = document.querySelector('.editor-textarea');
      if (!ta) return { ok: false, why: '没有正文输入框' };
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const md = ${JSON.stringify(mdForRender)};
      set.call(ta, md);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      const pv = document.querySelector('.editor-preview');
      if (!pv) return { ok: false, why: '没有预览区' };
      return {
        ok: true,
        h1: pv.querySelectorAll('.md-h1').length,
        h2: pv.querySelectorAll('.md-h2').length,
        pre: pv.querySelectorAll('.md-pre').length,
        // KaTeX 渲染成功的标志：存在 .katex 元素，且**没有** .katex-error
        katex: pv.querySelectorAll('.katex').length,
        katexDisplay: pv.querySelectorAll('.katex-display').length,
        katexError: pv.querySelectorAll('.katex-error').length,
        plainHasDollar: /\\$E = mc\\^2\\$/.test(pv.innerText || ''),
        dirty: (document.querySelector('.editor-dirty') || {}).textContent || '',
      };
    })()`);
    ok("编辑器预览渲染主/副标题（字号层级）", !!(rendered.ok && rendered.h1 === 1 && rendered.h2 === 1), JSON.stringify(rendered));
    ok("编辑器预览渲染代码块", !!(rendered.ok && rendered.pre === 1), JSON.stringify(rendered));
    ok("行内公式渲染成 KaTeX（且不再是 $…$ 源码）",
      !!(rendered.ok && rendered.katex >= 1 && rendered.katexError === 0 && rendered.plainHasDollar === false),
      JSON.stringify(rendered));
    ok("块级公式渲染成居中 KaTeX（.katex-display）", !!(rendered.ok && rendered.katexDisplay >= 1), JSON.stringify(rendered));
    ok("改动后状态标「未保存」", !!(rendered.ok && rendered.dirty.includes("未保存")), "dirty=" + rendered.dirty);

    // —— 多模态：图片走真实 File + DataTransfer（**真的能贴进正文**） ——
    const imgIn = await session.eval(`(async () => {
      const input = document.querySelector('.editor-toolbar input[type=file]');
      if (!input) return { ok: false, why: '没找到图片文件输入框' };
      const c = document.createElement('canvas');
      c.width = 12; c.height = 12;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c0392b'; ctx.fillRect(0, 0, 12, 12);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!blob) return { ok: false, why: 'canvas 没能产出 PNG' };
      const dt = new DataTransfer();
      dt.items.add(new File([blob], '冒烟图片.png', { type: 'image/png' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
      const ta = document.querySelector('.editor-textarea');
      const pv = document.querySelector('.editor-preview');
      return {
        ok: true,
        inText: /!\\[[^\\]]*\\]\\(data:image\\/png;base64,/.test((ta || {}).value || ''),
        rendered: pv ? pv.querySelectorAll('img[src^="data:image"]').length : -1,
      };
    })()`);
    ok("图片插入正文（dataURL 内联进 content_md）", !!(imgIn.ok && imgIn.inText), JSON.stringify(imgIn));
    ok("插入的图片在预览里真的渲染出来", !!(imgIn.ok && imgIn.rendered >= 1), JSON.stringify(imgIn));

    // —— 视图模式切换（编辑 / 分栏 / 预览） ——
    const modeSwitch = await session.eval(`(async () => {
      const btn = [...document.querySelectorAll('.editor-bar-right .chip')].find(b => b.textContent.trim() === '预览');
      if (!btn) return { ok: false, why: '没找到「预览」切换按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const only = {
        textarea: !!document.querySelector('.editor-textarea'),
        preview: !!document.querySelector('.editor-preview'),
      };
      const back = [...document.querySelectorAll('.editor-bar-right .chip')].find(b => b.textContent.trim() === '分栏');
      if (back) back.click();
      await new Promise(r => setTimeout(r, 300));
      return { ok: true, only, split: !!document.querySelector('.editor-textarea') && !!document.querySelector('.editor-preview') };
    })()`);
    ok("切「预览」只留渲染结果（编辑区隐藏）", !!(modeSwitch.ok && !modeSwitch.only.textarea && modeSwitch.only.preview), JSON.stringify(modeSwitch));
    ok("切回「分栏」编辑区与预览区都在", !!(modeSwitch.ok && modeSwitch.split), JSON.stringify(modeSwitch));

    // —— 保存：浏览器预览下**如实**报"仅桌面版可用"，不假装保存成功 ——
    const saveAttempt = await session.eval(`(async () => {
      const btn = [...document.querySelectorAll('.editor-bar-right button')].find(b => b.textContent.trim() === '保存');
      if (!btn) return { ok: false, why: '没找到「保存」按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 700));
      const err = document.querySelector('.settings-msg.err');
      return { ok: true, text: err ? (err.textContent || '').trim() : '' };
    })()`);
    ok("预览模式下保存如实报错（不假装保存成功）",
      !!(saveAttempt.ok && /桌面版/.test(saveAttempt.text)),
      JSON.stringify(saveAttempt));

    // ---------------- R13：侧栏「相关材料」+ 点材料直接打开 ----------------
    //
    // 用户原话：「在侧栏添加一个相关材料，点击材料可以直接跳转窗口（比如 pdf 点开就打开 pdf）」。
    //
    // 这一段的重点是**两条分支都要覆盖到**：
    //   ① 有原文件位置的材料 → 摆「打开」按钮；
    //   ② 没有原文件位置的材料（`file_path` 为空，早期按字节导入的）→ **不摆点了没反应的
    //      「打开」**，而是明说原因 + 给「补存原文件」入口。
    // 样例数据里两条都准备了（`data/sample.ts` 的 id=21/22 有路径，id=24 没有）。
    // 另外：浏览器预览下点「打开」**必须如实报错**（这是仅桌面版可用的动作），
    // 断言的就是"如实说做不到"，不是"假装打开成功"。
    console.log("\n[13/13] R13：侧栏「相关材料」· 打开原文件 · 诚实分支");

    await goto(session, "/#/courses");
    const navHas = await session.eval(
      `(() => { const items = [...document.querySelectorAll('.nav-item .nav-label')]; return items.map(n => (n.textContent || '').trim()); })()`,
    );
    ok("侧栏有「相关材料」入口", Array.isArray(navHas) && navHas.includes("相关材料"), JSON.stringify(navHas));

    const entered = await session.eval(`(async () => {
      const el = [...document.querySelectorAll('.nav-item')].find(a => /相关材料/.test(a.textContent || ''));
      if (!el) return { ok: false, why: '没找到入口' };
      el.click();
      await new Promise(r => setTimeout(r, 900));
      return {
        ok: true,
        hash: location.hash,
        page: !!document.querySelector('.materials-page'),
        groups: document.querySelectorAll('.materials-group').length,
      };
    })()`);
    ok("点侧栏入口进入相关材料页", !!(entered.ok && /^#\/materials/.test(entered.hash) && entered.page), JSON.stringify(entered));

    // ⚠ 上一步的落点取决于"当时有没有选中课程"（R12 段落刚建过一门课并选中了它，
    //    于是会落到 `?course=<新课>`）。所以"分组"这条**自己显式导航到不带课程参数的模式**，
    //    不去依赖上一步残留的状态 —— 断言依赖别人留下的状态，就会变成随机红。
    await goto(session, "/#/materials");
    const allCourses = await session.eval(`(() => ({
      groups: document.querySelectorAll('.materials-group').length,
      heads: [...document.querySelectorAll('.materials-group-head')].map(h => (h.textContent || '').trim()),
    }))()`);
    ok("不带课程参数时按课程分组（≥2 组）", allCourses.groups >= 2, JSON.stringify(allCourses));

    // 锁定某门课：只列这门课的材料
    await goto(session, "/#/materials?course=1");
    const locked = await session.eval(`(() => {
      const names = [...document.querySelectorAll('.materials-page .material-name')].map(n => (n.textContent || '').trim());
      return {
        names,
        groups: document.querySelectorAll('.materials-group').length,
        hasOtherCourse: names.some(n => /线代|板书/.test(n)),
        openBtns: document.querySelectorAll('.materials-page .mat-open-btn').length,
        repick: [...document.querySelectorAll('.materials-page button')].some(b => /补存原文件/.test(b.textContent || '')),
        honest: /只导入过内容，没有原文件位置/.test(document.body.innerText || ''),
      };
    })()`);
    ok("锁定课程后只列该课材料（不串课）", locked.names.length > 0 && !locked.hasOtherCourse, JSON.stringify(locked.names));
    ok("有原文件位置的材料摆「打开」按钮", locked.openBtns >= 1, "openBtns=" + locked.openBtns);
    ok("没有原文件位置的材料给「补存原文件」而不是「打开」", locked.repick === true, JSON.stringify(locked));
    ok("没有原文件位置时如实写明原因", locked.honest === true, "未出现「只导入过内容，没有原文件位置」");

    // 点「打开」：预览模式下必须如实报错
    const openClick = await session.eval(`(async () => {
      const b = document.querySelector('.materials-page .mat-open-btn');
      if (!b) return { ok: false, why: '没有「打开」按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 700));
      const err = document.querySelector('.settings-msg.err');
      return { ok: true, text: err ? (err.textContent || '').trim() : '' };
    })()`);
    ok("预览模式下点「打开」如实报错（不假装打开成功）",
      !!(openClick.ok && /桌面版/.test(openClick.text)),
      JSON.stringify(openClick));

    // ---------------- R14：触控笔手写笔记（平板优先） ----------------
    //
    // 这一段分两层，**两层都必须过**：
    //   ① **墨迹引擎的纯逻辑**（`lib/ink.ts`）：在真实浏览器里动态 import 这个模块跑一遍
    //      —— 序列化往返、坏数据拒绝、橡皮断笔、撤销/重做、压感与线宽映射。
    //      这层是"手写到底对不对"的地基，比 UI 层的像素断言更值得测；
    //   ② **手写页真的能写**：用**合成 PointerEvent**（pointerType='pen' + pressure）在画布上
    //      写一笔，然后用 `getImageData` 数**真的画上去了**的非白像素（不是只看"有没有报错"）。
    console.log("\n[14/14] R14：触控笔手写（引擎纯逻辑 + 画布真的落墨）");

    const engine = await session.eval(`(async () => {
      const ink = await import('/src/lib/ink.ts');
      const doc = ink.emptyDoc('grid');
      const h = ink.newHistory();
      ink.commitAddStroke(doc, h, 0, {
        tool: 'pen', color: '#1f2328', size: 3,
        pts: [{ x: 10, y: 10, p: 0.2 }, { x: 60, y: 80, p: 0.9 }, { x: 120, y: 40, p: 0.5 }],
      });
      const orig = doc.pages[0].strokes[0].pts.length;
      const back = ink.parseDoc(ink.serializeDoc(doc));
      const bad1 = ink.parseDoc('{"v":1,"pages":[{"paper":"grid"}]}');
      const bad2 = ink.parseDoc('not json');
      const strokes = [{ tool: 'pen', color: '#000000', size: 3,
        pts: Array.from({ length: 30 }, (_, i) => ({ x: i * 10, y: 50, p: 0.5 })) }];
      const after = ink.eraseAt(strokes, 150, 50, 12);
      const undone = ink.undo(doc, h);
      const nAfterUndo = doc.pages[0].strokes.length;
      const redone = ink.redo(doc, h);
      const nAfterRedo = doc.pages[0].strokes.length;
      const bgBad = ink.parseDoc('{"v":1,"pages":[{"paper":"grid","w":10,"h":10,"strokes":[],"bg":"javascript:alert(1)"}]}');
      return {
        points: back ? back.pages[0].strokes[0].pts.length : -1,
        orig,
        paper: back ? back.pages[0].paper : null,
        bad1: bad1 === null, bad2: bad2 === null,
        runsAfterErase: after.length,
        undone, redone, nAfterUndo, nAfterRedo,
        pMouse: ink.pressureOf({ pointerType: 'mouse', pressure: 0 }),
        pPen0: ink.pressureOf({ pointerType: 'pen', pressure: 0 }),
        pPen1: ink.pressureOf({ pointerType: 'pen', pressure: 1 }),
        wLo: ink.widthAt('pen', 4, 0), wHi: ink.widthAt('pen', 4, 1),
        bgRejected: bgBad.pages[0].bg === null,
        coalesced: typeof PointerEvent !== 'undefined' && 'getCoalescedEvents' in PointerEvent.prototype,
      };
    })()`);
    ok("引擎：序列化往返不丢点", engine.points === engine.orig && engine.points > 0, JSON.stringify(engine));
    ok("引擎：纸面样式能往返", engine.paper === "grid", "paper=" + engine.paper);
    ok("引擎：坏数据一律拒绝（不返回半截文档）", engine.bad1 === true && engine.bad2 === true, JSON.stringify(engine));
    ok("引擎：从中间擦一刀断成两段", engine.runsAfterErase === 2, "runs=" + engine.runsAfterErase);
    ok("引擎：撤销 / 重做对得上", engine.undone && engine.redone && engine.nAfterUndo === 0 && engine.nAfterRedo === 1, JSON.stringify(engine));
    ok("引擎：鼠标压感 0.5、笔压 0/1 如实映射", engine.pMouse === 0.5 && engine.pPen0 === 0 && engine.pPen1 === 1, JSON.stringify(engine));
    ok("引擎：压感越重线越粗", engine.wLo < engine.wHi, `${engine.wLo} vs ${engine.wHi}`);
    ok("引擎：底图只收 data:image（拒 javascript:）", engine.bgRejected === true, JSON.stringify(engine));

    // ---- R14b：标注符号 / 高亮带 / 框选平移（引擎层） ----
    const engine2 = await session.eval(`(async () => {
      const ink = await import('/src/lib/ink.ts');
      const doc = ink.emptyDoc('grid');
      const h = ink.newHistory();
      ink.commitAddStroke(doc, h, 0, {
        tool: 'stamp', color: '#ec1313', size: 3, glyph: '★', pts: [{ x: 100, y: 100, p: 0.5 }],
      });
      const back = ink.parseDoc(ink.serializeDoc(doc));
      const st = back.pages[0].strokes[0];
      const line = { tool: 'pen', color: '#1f2328', size: 3,
        pts: Array.from({ length: 600 }, (_, i) => ({ x: i, y: 100, p: 0.5 })) };
      const skip = { tool: 'stamp', color: '#000000', size: 3, glyph: '✓', pts: [{ x: 0, y: 0, p: 0.5 }] };
      const hl = ink.highlightFor([line, skip], '#f7ad31');
      const moved = ink.translateStrokes([line], 10, -5);
      const rc = ink.recolorStrokes([skip], '#4176e6');
      return {
        tool: st.tool, glyph: st.glyph, fontPx: ink.stampFontSize(3),
        hlCount: hl.length, hlBehind: hl[0] ? hl[0].behind === true : false,
        hlPts: hl[0] ? hl[0].pts.length : -1, hlColor: hl[0] ? hl[0].color : null,
        movedX: moved[0].pts[0].x, origX: line.pts[0].x,
        idxLen: ink.strokesInRect([line], 100, 90, 200, 110, 6).length,
        rcGlyph: rc[0].glyph, rcColor: rc[0].color,
        union: ink.unionBBox([line]) ? 1 : 0,
      };
    })()`);
    ok("引擎：标注符号能往返（工具/字形/字号）",
      engine2.tool === "stamp" && engine2.glyph === "★" && engine2.fontPx === 18, JSON.stringify(engine2));
    ok("引擎：高亮带在底层、抽稀、跳过符号",
      engine2.hlCount === 1 && engine2.hlBehind === true && engine2.hlPts <= 61 && engine2.hlPts > 1 && engine2.hlColor === "#f7ad31",
      JSON.stringify(engine2));
    ok("引擎：平移返回新对象（不动原笔迹）", engine2.movedX === engine2.origX + 10, JSON.stringify(engine2));
    ok("引擎：框选命中 + 外接框 + 换色保留符号",
      engine2.idxLen === 1 && engine2.union === 1 && engine2.rcGlyph === "✓" && engine2.rcColor === "#4176e6",
      JSON.stringify(engine2));

    // ---- R14b：符号面板 + 框选高亮（界面层） ----
    // ⚠ 这一段发生在"进手写页"的断言之前，所以必须**自己先导航过去**（不依赖上一段的落点）
    await goto(session, "/#/handwrite");
    const stamped = await session.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const cv = document.querySelector('.hw-canvas');
      const r = cv.getBoundingClientRect();
      const tool = re => [...document.querySelectorAll('.hw-tool')].find(b => new RegExp(re).test(b.textContent || ''));
      tool('标注符号').click();
      await wait(200);
      const glyphs = document.querySelectorAll('.hw-glyph').length;
      document.querySelectorAll('.hw-glyph')[0].click();
      await wait(150);
      cv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, pointerType: 'pen', isPrimary: true,
        bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 300, pressure: 0.5, buttons: 1 }));
      cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, pointerType: 'pen', isPrimary: true,
        bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 300, pressure: 0, buttons: 0 }));
      await wait(350);
      const ctx = cv.getContext('2d');
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let red = 0;
      for (let i = 0; i < data.length; i += 4 * 7) {
        if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100) red += 1;
      }
      return { glyphs, red, foot: (document.querySelector('.hw-foot') || {}).innerText || '' };
    })()`);
    ok("「标注符号」点开符号面板（≥20 个）", stamped.glyphs >= 20, "glyphs=" + stamped.glyphs);
    ok("点一下就盖上一个符号（笔数 +1）", /本页\s*1\s*笔/.test(stamped.foot || ""), JSON.stringify(stamped.foot));

    const selFlow = await session.eval(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const cv = document.querySelector('.hw-canvas');
      const r = cv.getBoundingClientRect();
      const tool = re => [...document.querySelectorAll('.hw-tool')].find(b => new RegExp(re).test(b.textContent || ''));
      const count = () => {
        const m = /本页\\s*(\\d+)\\s*笔/.exec((document.querySelector('.hw-foot') || {}).innerText || '');
        return m ? Number(m[1]) : -1;
      };
      const send = (pid, t, x, y, p) => cv.dispatchEvent(new PointerEvent(t, {
        pointerId: pid, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: r.left + x, clientY: r.top + y, pressure: p, buttons: t === 'pointerup' ? 0 : 1,
      }));
      // 先用钢笔画一笔（高亮只对笔迹生效，符号会被跳过）
      tool('钢笔').click(); await wait(150);
      send(21, 'pointerdown', 200, 200, 0.4);
      for (let i = 1; i <= 20; i += 1) send(21, 'pointermove', 200 + i * 8, 200 + i * 3, 0.5);
      send(21, 'pointerup', 360, 260, 0);
      await wait(320);
      const beforeN = count();
      // 框选刚画的那一笔
      tool('框选').click(); await wait(150);
      send(22, 'pointerdown', 120, 120, 0.5);
      for (let i = 1; i <= 10; i += 1) send(22, 'pointermove', 120 + i * 30, 120 + i * 20, 0.5);
      send(22, 'pointerup', 420, 320, 0);
      await wait(320);
      const selbar = document.querySelector('.hw-selbar');
      const selText = selbar ? selbar.innerText : '';
      const hlBtn = selbar ? [...selbar.querySelectorAll('button')].find(b => /高亮/.test(b.textContent || '')) : null;
      if (hlBtn) { hlBtn.click(); await wait(420); }
      const afterN = count();
      const msg = document.querySelector('.settings-msg');
      return { beforeN, afterN, selText, hasBar: !!selbar, clicked: !!hlBtn, notice: msg ? msg.innerText : '' };
    })()`);
    ok("框选后出现选区动作条（并报出选中几笔）",
      selFlow.hasBar === true && /已选中\s*[12]\s*笔/.test(selFlow.selText || ""),
      JSON.stringify(selFlow.selText));
    ok("「高亮」新增一条底层色带（笔数 +1）", selFlow.afterN === selFlow.beforeN + 1, JSON.stringify(selFlow));
    ok("高亮后如实说明它铺在字下面", /高亮/.test(selFlow.notice || ""), JSON.stringify(selFlow.notice));

    // ---- 识别为文字：未配 Key 时必须如实说做不到（不许假装识别了） ----
    const ocrClick = await session.eval(`(async () => {
      const b = [...document.querySelectorAll('.hw-stage-bar button')].find(x => /识别为文字/.test(x.textContent || ''));
      if (!b) return { ok: false, why: '没有识别按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 500));
      const m = document.querySelector('.hw-ocr-msg');
      return { ok: true, text: m ? m.innerText : '' };
    })()`);
    ok(
      "未配 Key 时「识别为文字」如实提示（不假装有离线识别）",
      !!(ocrClick.ok && /API Key|数据设置/.test(ocrClick.text)),
      JSON.stringify(ocrClick),
    );

    // —— 界面：侧栏入口 → 手写页 ——
    await goto(session, "/#/courses");
    const navInk = await session.eval(
      `(() => [...document.querySelectorAll('.nav-item .nav-label')].map(n => (n.textContent || '').trim()))()`,
    );
    ok("侧栏有「手写笔记」入口", Array.isArray(navInk) && navInk.includes("手写笔记"), JSON.stringify(navInk));

    await goto(session, "/#/handwrite");
    const shell = await session.eval(`(() => ({
      canvas: document.querySelectorAll('.hw-canvas').length,
      tools: document.querySelectorAll('.hw-tool').length,
      colors: document.querySelectorAll('.hw-color').length,
      papers: document.querySelectorAll('.hw-stage-bar .chip').length,
      noSidebar: !document.querySelector('.sidebar'),
      noTopbar: !document.querySelector('.topbar'),
      foot: (document.querySelector('.hw-foot') || {}).innerText || '',
    }))()`);
    ok("手写页渲染出画布", shell.canvas === 1, JSON.stringify(shell));
    ok("七种工具都在（笔/铅笔/直线/荧光/符号/橡皮/框选）", shell.tools === 7, "tools=" + shell.tools);
    ok("有调色板与四种纸面", shell.colors >= 4 && shell.papers === 4, JSON.stringify(shell));
    ok("手写页是沉浸式外壳（无侧栏与顶栏）", shell.noSidebar && shell.noTopbar, JSON.stringify(shell));

    // —— 合成笔事件：真的在画布上落墨 ——
    const drawn = await session.eval(`(async () => {
      const cv = document.querySelector('.hw-canvas');
      if (!cv) return { ok: false, why: '没有画布' };
      const r = cv.getBoundingClientRect();
      const ev = (type, x, y, p) => cv.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: r.left + x, clientY: r.top + y, pressure: p, buttons: 1, button: 0,
        width: 4, height: 4, tiltX: 12, tiltY: -6,
      }));
      ev('pointerdown', 160, 160, 0.25);
      for (let i = 1; i <= 24; i += 1) ev('pointermove', 160 + i * 9, 160 + Math.sin(i / 3) * 26, 0.3 + i / 40);
      ev('pointerup', 160 + 24 * 9, 160, 0);
      await new Promise(res => setTimeout(res, 350));
      const ctx = cv.getContext('2d');
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4 * 11) {
        if (data[i + 3] > 0 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) dark += 1;
      }
      const undoBtn = document.querySelector('.hw-tool-icon[aria-label="撤销"]');
      return {
        ok: true, dark,
        foot: (document.querySelector('.hw-foot') || {}).innerText || '',
        canUndo: !!undoBtn && !undoBtn.disabled,
      };
    })()`);
    ok("合成长按写一笔后画布真的出现墨迹（像素级）", !!(drawn.ok && drawn.dark > 20), JSON.stringify(drawn));
    ok("页脚如实报「本页 1 笔」", /本页\s*1\s*笔/.test(drawn.foot || ""), JSON.stringify(drawn.foot));
    ok("写过之后「撤销」可用", drawn.canUndo === true, JSON.stringify(drawn));

    // —— 撤销：笔数回到 0 ——
    const undoneUi = await session.eval(`(async () => {
      const b = document.querySelector('.hw-tool-icon[aria-label="撤销"]');
      if (!b) return { ok: false, why: '没有撤销按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 260));
      return { ok: true, foot: (document.querySelector('.hw-foot') || {}).innerText || '' };
    })()`);
    ok("撤销后本页回到 0 笔", /本页\s*0\s*笔/.test(undoneUi.foot || ""), JSON.stringify(undoneUi.foot));

    // —— 加页 / 翻页 ——
    const paged = await session.eval(`(async () => {
      const b = [...document.querySelectorAll('.hw-stage-bar button')].find(x => /加页/.test(x.textContent || ''));
      if (!b) return { ok: false, why: '没有加页按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 220));
      return { ok: true, pages: (document.querySelector('.hw-pages') || {}).innerText || '' };
    })()`);
    ok("加页后页码显示 2 页", /第\s*2\s*\/\s*2\s*页/.test(paged.pages || ""), JSON.stringify(paged));

    // —— 保存：浏览器预览下**如实**报"仅桌面版可用" ——
    const inkSave = await session.eval(`(async () => {
      const title = document.querySelector('.hw-title');
      if (title) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(title, '手写冒烟');
        title.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const btn = [...document.querySelectorAll('.hw-bar-right button')].find(b => b.textContent.trim() === '保存');
      if (!btn) return { ok: false, why: '没有保存按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 600));
      const msg = document.querySelector('.settings-msg');
      return { ok: true, text: (msg ? msg.textContent : '') || '' };
    })()`);
    ok(
      "手写笔记空页保存被如实拦下（不许落空笔记）",
      !!(inkSave.ok && /还没有写任何笔迹|桌面版/.test(inkSave.text)),
      JSON.stringify(inkSave),
    );

    // —— 笔自检面板：能打开且显示压感能力 ——
    const diagOn = await session.eval(`(async () => {
      const b = [...document.querySelectorAll('.hw-tools button')].find(x => /笔自检/.test(x.textContent || ''));
      if (!b) return { ok: false, why: '没有笔自检按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 200));
      const d = document.querySelector('.hw-diag');
      return { ok: true, shown: !!d, text: d ? d.innerText : '' };
    })()`);
    ok(
      "「笔自检」能展开并说实话（合并事件能力）",
      !!(diagOn.ok && diagOn.shown && /合并事件/.test(diagOn.text)),
      JSON.stringify(diagOn),
    );

    // ---------------- 资源与 console 总检查 ----------------
    console.log("\n[汇总检查] 资源与 console 报错");
    const uniqBad = [...new Set(badResponses)];
    ok(
      "无 4xx/5xx 资源请求",
      uniqBad.length === 0,
      uniqBad.slice(0, 5).join(" | "),
    );
    const real = errors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
    ok("页面无 console 报错", real.length === 0, real.slice(0, 3).join(" | "));
  } finally {
    session.close();
    await closePage(targetId);
  }

  console.log("");
  console.log(`UI 冒烟：PASS ${pass} / FAIL ${fail}`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  await finish(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("UI 冒烟异常：" + (e && e.stack ? e.stack : e));
  await finish(2);
});
