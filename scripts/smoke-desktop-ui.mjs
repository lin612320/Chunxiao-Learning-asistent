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

    // ---------------- R13：相关材料（真机 + 真 IPC）----------------
    // 浏览器层只能验到"点打开会如实报错（仅桌面版可用）"；这一层验的是**真 IPC 真的注册了**、
    // 参数名真的对得上、以及新命令的**拒绝路径**真的会拒绝。
    //
    // ⚠ 这里**刻意不调用会写盘的正常路径**：`material_store_file` 成功时会往
    //   `%APPDATA%\com.chunxiao.study\materials\` 落文件，而 .ps1 只隔离了数据库文件，
    //   素材目录是共享的 —— 测试不该往用户的素材目录里塞东西。
    //   "真的写盘 + 指纹命名 + 同内容复用"由 Rust 单测
    //   `store_material_bytes_names_fingerprints_and_reuses` 在临时目录里覆盖。
    console.log("\n[R13] 相关材料：新命令在真桌面下已注册且拒绝路径正确");

    // ⚠ 这一段**必须挂在隔离自检通过之后**：下面那条「空库时如实说还没有材料」
    //   只有在隔离出来的空库上才成立；否则拿真实库跑必红（用户库里本来就有材料）。
    //   断言依赖"空库"这个前提，就得待在为它准备的分支里 —— 这正是前面那条教训。
    if (isolated) {

    const navR13 = await session.eval(
      `(() => [...document.querySelectorAll('.nav-item .nav-label')].map(n => (n.textContent || '').trim()))()`,
    );
    ok(
      "真机侧栏有「相关材料」入口",
      Array.isArray(navR13) && navR13.includes("相关材料"),
      JSON.stringify(navR13),
    );

    await gotoHash(session, "#/materials", /相关材料/);
    // ⚠ 轮询等 `.materials-page` 真的挂上再断言：侧栏本来就含「相关材料」四个字，
    //   拿它当等待条件会**在页面还没渲染时立刻通过**，断言就变成随机红/绿。
    const matPage = await session.eval(`(async () => {
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('.materials-page')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      return {
        page: !!document.querySelector('.materials-page'),
        items: document.querySelectorAll('.material-item').length,
        empty: /还没有材料/.test(document.body.innerText || ''),
      };
    })()`);
    ok("真机下材料页能打开（走真 SQLite）", matPage.page === true, JSON.stringify(matPage));
    ok(
      "空库时如实说「还没有材料」（不摆假数据）",
      matPage.empty === true && matPage.items === 0,
      JSON.stringify(matPage),
    );

    const r13 = await session.eval(`(async () => {
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) return { ok: false, why: '拿不到 __TAURI_INTERNALS__.invoke' };
      const call = async (cmd, args) => {
        try { return { ok: true, v: await inv(cmd, args) }; }
        catch (e) { return { ok: false, e: String(e && e.message ? e.message : e) }; }
      };
      // 只打**拒绝路径**（不会写盘、不改库）
      const badB64 = await call('material_store_file', { fileName: '冒烟.txt', dataB64: 'not-base64!!' });
      const badId = await call('material_set_path', { id: 999999, filePath: 'X:/nope' });
      return { ok: true, badB64, badId };
    })()`);
    ok(
      "material_store_file 已注册：非法 base64 被如实拒绝",
      !!(r13.ok && r13.badB64 && r13.badB64.ok === false && /base64/.test(r13.badB64.e || '')),
      JSON.stringify(r13.badB64),
    );
    ok(
      "material_set_path 已注册：不存在的材料报错（不静默成功）",
      !!(r13.ok && r13.badId && r13.badId.ok === false),
      JSON.stringify(r13.badId),
    );

    }  // end if (isolated)：R13

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
