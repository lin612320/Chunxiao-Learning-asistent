// 春晓学习助手 · **桌面真机** UI 冒烟（CDP 直连 WebView2，无第三方依赖）
//
//   powershell -File scripts/smoke-desktop-ui.ps1      # 推荐：它负责隔离库 + 起 vite + 起主程序 + 还原
//   node scripts/smoke-desktop-ui.mjs                  # 或直连已开的 CDP 端点（默认 127.0.0.1:9224）
//
// 为什么需要这一层（补 T17 的核心缺口）：
//   `scripts/smoke-ui.mjs` 只能跑**浏览器预览模式**（`!isTauri()` → `src/data/sample.ts` 示例数据），
//   因此它天然抓不到"前端没把参数传给 Rust"这类**接线缺陷** —— R1 修的正是这种
//   （`useChat` 从没拿到 `courseId`，而 sample.ts 的预览会话**恰好带了 course_id**，
//   于是预览全绿、桌面全死）。本脚本驱动的是**真桌面应用**：真 WebView2 + 真 Tauri IPC + 真 SQLite。
//
// ⚠ 本脚本会**真的写库**，因此第一件事是**隔离自检**：只允许跑在"空库 + 未配 Key"的隔离环境上
//   （表现为演示模式 → 不会调用任何模型）。`.ps1` 已把真实库移开，自检不通过就**不再执行**任何
//   写库断言 —— 这条是踩过真实事故后加的：早期版本用改 `APPDATA` 来隔离（无效），
//   结果把测试数据写进了用户的真实库，还花掉了用户一次真实的模型调用（见 docs/12 事故记录）。

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9224";
const TIMEOUT_MS = Number(process.env.UI_TIMEOUT_MS || 25000);

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

// ⚠ 不要用 process.exit()：WebSocket 仍在关闭中时 Node 会触发
//   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，异常退出码会吞掉真实结论。
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

async function text(session) {
  try {
    return (await session.eval("document.body.innerText")) || "";
  } catch {
    return "";
  }
}

async function count(session, selector) {
  try {
    return (await session.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) || 0;
  } catch {
    return 0;
  }
}

/** 等到页面渲染出内容（SPA 异步渲染） */
async function waitBody(session) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const n = await session.eval("document.body ? document.body.innerText.length : 0");
      if (n && n > 40) return true;
    } catch {
      /* 导航中会短暂失败 */
    }
  }
  return false;
}

/** 只改 hash（不整页导航），等目标文案出现 */
async function gotoHash(session, hash, expectRe) {
  await session.eval(`location.hash = ${JSON.stringify(hash)};`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const t = await text(session);
    if (!expectRe || expectRe.test(t)) return t;
  }
  return await text(session);
}

async function main() {
  console.log(`CDP: ${CDP}\n`);

  let info;
  try {
    info = await getJson("/json/version");
  } catch (e) {
    console.error(`无法连上 CDP（${CDP}）：${e.message}`);
    await finish(2);
  }
  console.log(`浏览器内核: ${info.Browser}`);

  // 桌面应用只有一个页面 target —— **attach 到它**，不要 /json/new（WebView2 不支持新建标签页）
  let targets;
  try {
    targets = await getJson("/json");
  } catch (e) {
    console.error(`读取 target 列表失败：${e.message}`);
    await finish(2);
  }
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
  if (!page) {
    console.error("未找到 type=page 的 target（主程序窗口没起来？）");
    console.error(JSON.stringify(targets, null, 2));
    await finish(2);
  }
  console.log(`主程序窗口: ${page.url}\n`);

  const ws = await connect(page.webSocketDebuggerUrl);
  const session = new CdpSession(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");

  const consoleErrors = [];
  session.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(
        (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "),
      );
    }
  });

  try {
    ok("主程序窗口已渲染出内容", await waitBody(session), "body 文本过短");

    // 必须跑在**真 Tauri 环境**里：否则本脚本与 smoke-ui 就没区别了（会失去它的全部意义）
    const inTauri = await session.eval(`'__TAURI_INTERNALS__' in window`);
    ok("页面运行在真 Tauri 环境（不是浏览器预览）", inTauri === true, `__TAURI_INTERNALS__ = ${inTauri}`);

    // ---------------- 隔离自检（**写库前置条件**）----------------
    // 隔离库是全新空库 → settings 里没有 Key → 界面进入演示模式、**不会调用任何模型**。
    // 这条同时证明两件事：① 我们没在用用户的真实库；② 本次测试不会产生模型费用。
    console.log("\n[隔离自检] 必须跑在空库（演示模式）上，否则拒绝执行写库断言");
    await gotoHash(session, "#/assistant", /与春晓对话/);
    const t0 = await text(session);
    const isolated = /演示模式/.test(t0);
    ok(
      "隔离自检：空库无 Key ⇒ 演示模式（既没碰真实库，也不会调模型）",
      isolated,
      "未出现「演示模式」—— 隔离库可能没生效，已拒绝执行后续写库断言",
    );

    if (!isolated) {
      ok(
        "R1 端到端断言未执行（隔离自检失败，拒绝在非隔离库上写数据）",
        false,
        "请检查 .ps1 的数据库隔离是否生效（真实库 *.smoke-bak 是否被移开）",
      );
    } else {
      // ---------------- R1：对话按课程展开（真机 + 真 SQLite）----------------
      console.log("\n[R1] 课程归属：提问 → 落库 → 只在所属课程下可见");

      // ⚠ 课程 id 必须**从界面读**，不许硬编码：这库是空的，id 由播种决定；
      //   早期版本硬编码 1，而用户真实库里没有 id=1 的课程 → 整条断言链失去意义。
      //   另外必须确认**会话栏类名唯一** —— 早期版本里新加的"课程上下文栏"复用了
      //   `.session-bar`，导致 querySelector 抓到选择器栏、三条断言全部**假通过**。
      const scopeBars = await count(session, ".chat-scope-bar");
      const sessionBars = await count(session, ".session-bar");
      ok("课程上下文栏存在且唯一（.chat-scope-bar = 1）", scopeBars === 1, `实际 ${scopeBars} 个`);
      ok("会话列表栏存在且唯一（.session-bar = 1）", sessionBars === 1, `实际 ${sessionBars} 个`);

      // R6：课程列表现在**读侧栏的课程选择器**（`.course-picker select`）。
      //   对话页那个「在聊哪门课」下拉已删（课程由侧栏 + 顶栏胶囊负责，页内再放就是三处重复），
      //   所以这里必须改口径 —— 否则读不到课程 id，后面三条断言全部连带假失败。
      const optionValues = await session.eval(
        `[...document.querySelectorAll('.course-picker select option, .chat-scope-bar select option')].map(o => o.value).filter(v => v !== '')`,
      );
      const courseId = Number(Array.isArray(optionValues) ? optionValues[0] : NaN);
      ok("从界面读到一门真实课程（用于端到端断言）", Number.isInteger(courseId) && courseId > 0, `option values = ${JSON.stringify(optionValues)}`);

      // ---------------- R4：图片随消息落库（真机 + 真 SQLite）----------------
      // 直接打真 Rust 命令，不依赖 UI 时序：save 一条带图的消息 → load 回来逐字比对。
      //   两条断言各有意义：① 图片真的进库并能取回；② **无图消息必须回 null 而不是空数组**
      //   —— 前端要靠这个区分"这轮没图"与"图数组为空"（Rust 侧刻意这么设计）。
      const imgRound = await session.eval(`(async () => {
        const inv = window.__TAURI_INTERNALS__.invoke;
        const one = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
        const sid = await inv('chat_session_create', { courseId: ${courseId}, title: 'R4图片落库自检' });
        await inv('chat_history_save', { sessionId: sid, messages: [
          { role: 'user', content: '看这张图', images: [one] },
          { role: 'assistant', content: '收到', images: null }
        ]});
        const hist = await inv('chat_history_load', { sessionId: sid });
        const out = {
          n: hist.length,
          img0: hist[0] && hist[0].images && hist[0].images[0] ? String(hist[0].images[0]).slice(0, 22) : null,
          img1: hist[1] ? hist[1].images : 'missing'
        };
        // ⚠ 用完就删：这些自检会话若留着，会污染后面 R1 的「会话列表」断言
        //   （上一版就因此让三条 R1 断言连带失败 —— 自检不该改变被测对象的状态）
        await inv('chat_session_delete', { id: sid });
        return out;
      })()`);
      ok(
        "图片随消息真的落进 SQLite 并能取回",
        !!(imgRound && imgRound.n === 2 && imgRound.img0 && imgRound.img0.startsWith("data:image/png")),
        JSON.stringify(imgRound),
      );
      ok(
        "无图消息回传 null（不是空数组）",
        !!(imgRound && imgRound.img1 === null),
        JSON.stringify(imgRound),
      );

      // 超限必须**整条拒绝**（否则单条消息就能把本机库撑到不可用）
      const tooBig = await session.eval(`(async () => {
        const inv = window.__TAURI_INTERNALS__.invoke;
        const sid = await inv('chat_session_create', { courseId: ${courseId}, title: 'R4超限自检' });
        const huge = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024);
        let res;
        try {
          await inv('chat_history_save', { sessionId: sid, messages: [{ role: 'user', content: '超大图', images: [huge] }] });
          res = { threw: false };
        } catch (e) {
          res = { threw: true, msg: String(e) };
        }
        await inv('chat_session_delete', { id: sid }); // 同上：不留痕迹
        return res;
      })()`);
      ok(
        "超过 6 MB 的图片被整条拒绝并给出可读错误",
        !!(tooBig && tooBig.threw && /图片太大/.test(tooBig.msg || "")),
        JSON.stringify(tooBig),
      );

      const stamp = Date.now().toString().slice(-6);
      const question = `R1冒烟课程归属${stamp}`;
      /** 只读**会话列表栏**（不是课程上下文栏）里的文本 */
      const sessionBarText = async () => {
        try {
          return (await session.eval(`(document.querySelector('.session-bar') || {}).innerText || ''`)) || "";
        } catch {
          return "";
        }
      };

      await gotoHash(session, `#/assistant?course=${courseId}`, /与春晓对话/);
      const scopeTxt = await text(session);
      ok("有课程上下文时显示「检索范围」", /检索范围/.test(scopeTxt), "未出现「检索范围」");
      ok(
        "有课程上下文时不再声称按「全部课程材料（本机全库）」检索",
        !/全部课程材料（本机全库）/.test(scopeTxt),
        "检索范围文案与实际上下文不一致（契约 §一 第 2 条）",
      );

      // 输入问题（React 受控组件：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange）
      const typed = await session.eval(`(() => {
        const ta = document.querySelector('.assistant-input textarea');
        if (!ta) return { found: false };
        const d = Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value');
        d.set.call(ta, ${JSON.stringify(question)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return { found: true, value: ta.value };
      })()`);
      ok("找到输入框并填入问题", !!(typed && typed.found && typed.value === question), JSON.stringify(typed));

      const clicked = await session.eval(`(() => {
        const b = [...document.querySelectorAll('.assistant-input button')].find(n => /发送|生成中/.test(n.textContent || ''));
        if (!b) return { found: false };
        if (b.disabled) return { found: true, disabled: true };
        b.click();
        return { found: true, disabled: false };
      })()`);
      ok("点到了「发送」", !!(clicked && clicked.found && !clicked.disabled), JSON.stringify(clicked));

      // 等回复（演示模式：不调模型，但仍会**新建带 course_id 的会话**并写死文案）
      const deadline = Date.now() + TIMEOUT_MS;
      let replied = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (/这不是 AI 的回答/.test(await text(session))) {
          replied = true;
          break;
        }
      }
      const errBox = await session.eval(`(document.querySelector('.settings-msg.err') || {}).innerText || ''`);
      ok(
        "演示模式下给出了如实回复（未假装有 AI，也没调模型）",
        replied,
        `未等到演示回复；页面错误框 = ${JSON.stringify(String(errBox).slice(0, 200))}`,
      );

      // **核心断言**：重新加载（= 从 SQLite 真读一次），该会话必须出现在**该课程**的会话列表里。
      // 若 course_id 没落库（恒 NULL），或前端根本没把 courseId 传下去，这里必红。
      await session.send("Page.reload", { ignoreCache: true });
      await waitBody(session);
      await gotoHash(session, `#/assistant?course=${courseId}`, /与春晓对话/);
      const bar1 = await sessionBarText();
      const appeared = bar1.includes(question);
      ok(
        `重载后该会话出现在课程 ${courseId} 的会话列表里（course_id 真的落库了）`,
        appeared,
        `会话栏文本：${JSON.stringify(bar1.slice(0, 200))}`,
      );

      if (!appeared) {
        // ⚠ 防假通过：正向断言没过时，"换个课程就消失"是**恒真**的（本来就没有），
        //   必须把它记为失败而不是跳过 —— 这正是早期版本被自己骗过的地方。
        ok(
          "切到不存在的课程后该会话消失（证明按课程过滤真的生效）",
          false,
          "前置断言未通过：会话压根没出现在课程上下文里，此时「消失」毫无信息量（防假通过）",
        );
        ok(
          "回到「不限定课程」后该会话重新可见",
          false,
          "前置断言未通过，同上不计为通过",
        );
      } else {
        const ghostId = courseId + 100000;
        await gotoHash(session, `#/assistant?course=${ghostId}`, /与春晓对话/);
        const bar2 = await sessionBarText();
        ok(
          `切到不存在的课程（${ghostId}）后该会话消失（证明按课程过滤真的生效）`,
          !bar2.includes(question),
          `会话栏文本：${JSON.stringify(bar2.slice(0, 200))}`,
        );

        await gotoHash(session, "#/assistant", /与春晓对话/);
        const bar3 = await sessionBarText();
        ok(
          "回到「不限定课程」后该会话重新可见",
          bar3.includes(question),
          `会话栏文本：${JSON.stringify(bar3.slice(0, 200))}`,
        );
      }
    }

    // ---------------- 诚实红线 ----------------
    console.log("\n[边界] 真桌面下不得有 console 报错");
    const real = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
    ok("页面无 console 报错", real.length === 0, real.slice(0, 3).join(" | "));
  } finally {
    session.close();
  }

  console.log("");
  console.log(`桌面真机 UI 冒烟：PASS ${pass} / FAIL ${fail}`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f);
  }
  await finish(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("桌面真机 UI 冒烟异常：" + (e && e.stack ? e.stack : e));
  await finish(2);
});
