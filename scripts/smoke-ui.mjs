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
    // ---------------- /home ----------------
    console.log("[1/9] /home 首页");
    await goto(session, "/#/home");
    let t = await text(session);
    ok("渲染出首页内容", t.length > 40, `文本长度 ${t.length}`);
    ok("显示「本地单机 · 数据在本机」", t.includes("本地单机"), "未找到本机数据文案");
    ok("未被重定向到其它路由", (await session.eval("location.hash")) === "#/home");

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
      return { brand: pick('.brand-mark img'), home: pick('.home-mascot') };
    })()`);
    const brandImg = imgInfo && imgInfo.brand;
    const homeImg = imgInfo && imgInfo.home;
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
    ok(
      "首页欢迎区有吉祥物且尺寸非零",
      !!homeImg && homeImg.complete && homeImg.nw > 0 && homeImg.w > 0 && homeImg.h > 0,
      JSON.stringify(homeImg),
    );

    // ---------------- /courses ----------------
    console.log("\n[2/9] /courses 课程列表");
    await goto(session, "/#/courses");
    t = await text(session);
    ok("渲染出课程列表", t.includes("课程"), "未见课程相关文案");
    ok("含示例课程（预览数据）", t.includes("示例课程") || t.includes("课程"), "课程卡片缺失");

    // ---------------- /course/:id ----------------
    console.log("\n[3/9] 课程详情（先验知识 + 材料）");
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
    console.log("\n[4/9] /assistant 对话页");
    await goto(session, "/#/assistant");
    t = await text(session);
    ok("渲染出对话页", t.length > 40, `文本长度 ${t.length}`);
    const hasToggle = /先查课程材料|材料/.test(t);
    ok("有「先查课程材料再回答」开关", hasToggle, "未见材料检索开关");
    ok("有输入框", (await count(session, "textarea, input[type=text]")) > 0, "未找到输入框");

    // 紧凑模式（?float=1）—— M0 起就该正确
    await goto(session, "/#/assistant?float=1");
    const compact = await session.eval(`(() => ({
      hasShell: !!document.querySelector('.float-shell'),
      sidebar: document.querySelectorAll('.sidebar').length,
      topbar: document.querySelectorAll('.topbar').length
    }))()`);
    ok("?float=1 紧凑模式生效", compact && compact.hasShell === true, JSON.stringify(compact));
    ok("紧凑模式下无侧栏与顶栏", compact && compact.sidebar === 0 && compact.topbar === 0, JSON.stringify(compact));

    // ---------------- /settings ----------------
    console.log("\n[5/9] /settings 数据设置（BYOK）");
    await goto(session, "/#/settings");
    t = await text(session);
    ok("渲染出设置页", t.length > 40, `文本长度 ${t.length}`);
    ok("有 API 地址 / Key / 模型字段", t.includes("API") || t.includes("Key"), "缺少 BYOK 字段");
    ok("有「测试连接」", t.includes("测试") , "缺少测试连接入口");
    ok("含诚实边界说明（不面向考试 / 数据在本机）", /不面向考试|课后|本机/.test(t), "缺少边界说明");

    // ---------------- 全站占位措辞扫描 ----------------
    // M4 之后所有板块都应落地，因此这里从"逐页查占位"改成**全站扫描**：
    // 任何路由都不该再出现"未实现 / 占位 / 方案稿 / Mn 实现"这类措辞。
    // 这条断言在"某页忘了接线"时特别有用（比逐个断言更防退化）。
    //
    // R3 追加同类扫描：**全站主界面不得出现工程口径原文**（公式、evidence、
    // localStorage、字段名/命令名……）。它们应当被收进可折叠的「说明」区 ——
    // 折叠状态下 `innerText` 取不到，所以这条扫描同时也在守护"默认收起"。
    // ⚠ 这条是"漏改一处就红"的守门断言：加文案时别把实现细节写回主界面。
    console.log("\n[6/9] 全站占位措辞扫描（不得有任何板块仍是占位页）");
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
    console.log("\n[7/9] 边界用例（诚实红线：未配 Key 时不得假装有 AI）");

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
    console.log("\n[8/9] 新功能板块：笔记 / 番茄钟 / 题库 / 画像");
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
    console.log("\n[9/9] R1：对话课程归属（检索范围 / 课程上下文 / 课程页入口）");
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
