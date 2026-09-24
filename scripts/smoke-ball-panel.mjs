// 春晓学习助手 · 悬浮球面板**版面守门**（无头 Edge + CDP，零第三方依赖）
//
//   powershell -File scripts/smoke-ball-panel.ps1     # 推荐：它负责找 Edge 并转发退出码
//   node scripts/smoke-ball-panel.mjs --edge <msedge.exe> --panel <panel.html>
//
// 为什么需要这一层（0.7.0 的真实事故）：
//   R5 给面板加了「收起」——收起后窗口高 64px，而收起态要显示的内容
//   （输入框 38px + 按钮行 38px ≈ 100px）根本装不下，**按钮行被裁到窗口外**，
//   而"展开"按钮恰好就在那一行里 → 用户既点不到按钮、也回不到展开态。
//   Rust 单测 / 桥接冒烟 / 真机冒烟**全都碰不到这个缺陷**：它们的对象是数据与主程序，
//   没有人渲染过面板本身。所以这一层专门验"**渲染出来的版面里，关键控件是否真的在窗口内**"。
//
// 判据（每条都对应一次真实故障）：
//   1. 六个关键控件都存在且可见（两个输入框 / 两个按钮 / 两个抓取模式按钮）；
//   2. **每个控件都完整落在视口内** ← 直接抓"被裁到窗口外"；
//   3. 两个输入框与按钮行**互不重叠** ← 抓"flex 压过头导致叠在一起"；
//   4. 页面没有横向/纵向溢出；
//   5. 两个输入框各自**带可见标签** ← 抓"用户不知道哪个框是干什么的"；
//   6. 抓取模式两个按钮**带文字**（不是只有图标）← 抓"把带文字的功能换成图标按钮，用户以为功能没了"。
//
// 环境不可用（未装 Edge / CDP 起不来）→ exit 2（SKIP），**不冒充通过**。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EDGE = arg("edge", "");
const PANEL = arg("panel", path.resolve("floating-ball", "src", "renderer", "panel.html"));
const TIMEOUT_MS = Number(process.env.PANEL_TIMEOUT_MS || 20000);

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** panel.html 依赖 `window.api`（Electron preload 注入的）。这里给一份**桩**，
 *  否则渲染层第一行就抛异常、什么都测不到。 */
const STUB = `<script>
window.api = {
  getState: async () => ({
    config: { theme: 'dark', grabMode: 'auto', hotkey: 'Alt+Q',
      ai: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-stub', model: 'deepseek-chat' } },
    courses: [{ id: 1, name: '数据结构与算法' }, { id: 2, name: '操作系统' }],
    courseId: 1
  }),
  saveConfig: async (p) => p, runTask: () => {}, stopTask: () => {}, setTheme: () => {},
  openSkinPicker: () => {}, hidePanel: () => {}, quitApp: () => {}, move: () => {},
  testKey: async () => ({ message: 'ok' }), pushToApp: async () => ({ ok: true }),
  askMaterialSearch: () => {}, setCourse: () => {}, pushAsk: async () => ({ ok: true }),
  relateSearch: () => {}, relateSave: () => {},
  onTaskChunk: () => {}, onTaskDone: () => {}, onTaskError: () => {}, onSelectionResult: () => {},
  onApplyTheme: () => {}, onExternalRunTask: () => {}, onMaterialResult: () => {},
  onConfigSynced: () => {}, onCourses: () => {}, onRelateResult: () => {}, onRelateSaved: () => {}
};
</script>`;

function buildPreview(dir) {
  const html = fs.readFileSync(PANEL, "utf8")
    // 面板自己的 CSP 是 `script-src 'self'`，会连注入的桩脚本一起挡掉 →
    // 不渲染就等于没测。预览副本去掉 CSP，**产品代码的 CSP 一个字不改**。
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const withStub = html.replace('<script src="panel.js"></script>', STUB + '\n<script src="panel.js"></script>');
  // 填一点内容，让两个框都处于"有内容"的状态（空框测不出文字被裁）
  const fill = `<script>
window.addEventListener('DOMContentLoaded', () => {
  const s = document.getElementById('source');
  const q = document.getElementById('question');
  if (s) s.value = '摊还分析：把一次昂贵操作的代价摊到 n 次操作上。势能法用势函数描述预存的代价。';
  if (q) q.value = '势能法为什么能把扩容成本摊到常数？';
});
</script>`;
  const filled = withStub.replace('<script src="panel.js"></script>', fill + '\n<script src="panel.js"></script>');
  const file = path.join(dir, "panel-guard.html");
  fs.writeFileSync(file, filled, "utf8");
  fs.copyFileSync(path.join(path.dirname(PANEL), "panel.js"), path.join(dir, "panel.js"));
  return file;
}

/** 尺寸口径：最小尺寸（最容易出事的那个）与默认尺寸各测一遍 */
const SIZES = [
  { w: 360, h: 460, name: "最小尺寸 360×460" },
  { w: 420, h: 620, name: "默认尺寸 420×620" },
];

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const item = (label, sel) => {
    const el = q(sel);
    if (!el) return { label, sel, missing: true };
    return { label, sel, ...rect(el), text: (el.textContent || '').trim() };
  };
  const labels = [...document.querySelectorAll('.compose .field > .label')].map((el) => (el.textContent || '').trim());
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight,
    docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
    items: [
      item('内容框', '#source'),
      item('问题框', '#question'),
      item('问询按钮', '#btnAsk'),
      item('关联知识点按钮', '#btnRelate'),
      item('自动抓取按钮', '#qAuto'),
      item('手动拖入按钮', '#qManual'),
    ],
    labels,
  });
})()`;

function overlaps(a, b) {
  if (a.missing || b.missing) return false;
  return !(a.bottom <= b.y + 1 || b.bottom <= a.y + 1 || a.right <= b.x + 1 || b.right <= a.x + 1);
}

async function connect(port) {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* 还没起来 */ }
  }
  return null;
}

function makeSender(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
}

async function main() {
  if (!EDGE || !fs.existsSync(EDGE)) {
    console.log(`[SKIP] 未找到无头 Edge：${EDGE || "(未指定 --edge)"}`);
    process.exit(2);
  }
  if (!fs.existsSync(PANEL)) {
    console.log(`[SKIP] 未找到面板：${PANEL}`);
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-panel-guard-"));
  const file = buildPreview(dir);
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = path.join(dir, "profile");

  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore" });

  let ws = null;
  try {
    const target = await connect(port);
    if (!target) throw new Error("CDP 未就绪（Edge 没起来或端口被占）");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")));
    });
    const send = makeSender(ws);
    await send("Page.enable");
    await send("Runtime.enable");

    for (const size of SIZES) {
      console.log(`\n[${size.name}]`);
      await send("Emulation.setDeviceMetricsOverride", {
        width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false,
      });
      await send("Page.navigate", { url: "file:///" + file.replace(/\\/g, "/") });
      // 等渲染层把桩数据灌进去（课程下拉有内容即视为就绪）
      const deadline = Date.now() + TIMEOUT_MS;
      let ready = false;
      while (Date.now() < deadline) {
        await sleep(200);
        const r = await send("Runtime.evaluate", {
          expression: "document.querySelectorAll('#courseSel option').length",
          returnByValue: true,
        });
        if ((r.result.value || 0) > 1) { ready = true; break; }
      }
      ok("渲染层已就绪（课程下拉已由桩数据填充）", ready, "面板 JS 没跑起来（CSP / 语法 / 桩失效）");
      if (!ready) continue;

      const raw = await send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
      const m = JSON.parse(raw.result.value);
      const byLabel = Object.fromEntries(m.items.map((it) => [it.label, it]));
      const V = { w: m.vw, h: m.vh };

      // 1) 六个关键控件都在
      for (const it of m.items) {
        ok(`存在且可见：${it.label}`, !it.missing && it.w > 0 && it.h > 0,
          it.missing ? `选择器 ${it.sel} 找不到` : `尺寸 ${Math.round(it.w)}×${Math.round(it.h)}`);
      }
      // 2) **全部落在视口内** ← 0.7.0 的"按钮被裁到窗口外"就是这条挂
      for (const it of m.items) {
        if (it.missing) continue;
        const inside = it.y >= -1 && it.x >= -1 && it.bottom <= V.h + 1 && it.right <= V.w + 1;
        ok(`${it.label} 完整落在窗口内`, inside,
          `rect=(${Math.round(it.x)},${Math.round(it.y)})-(${Math.round(it.right)},${Math.round(it.bottom)}) 视口=${V.w}×${V.h}`);
      }
      // 3) 两个框与按钮行互不重叠
      const src = byLabel["内容框"]; const qst = byLabel["问题框"]; const act = byLabel["问询按钮"];
      ok("内容框与问题框不重叠", !overlaps(src, qst), "两个输入框叠在一起了");
      ok("问题框与按钮行不重叠", !overlaps(qst, act), "按钮压到输入框上了");
      // 4) 页面不溢出
      ok("页面无横向溢出", m.docW <= V.w + 1, `scrollWidth=${m.docW} > ${V.w}`);
      ok("页面无纵向溢出", m.docH <= V.h + 1, `scrollHeight=${m.docH} > ${V.h}`);
      // 5) 两个框都有可见标签
      ok("「抓取的内容」有可见标签", m.labels.some((t) => t.includes("抓取的内容")), JSON.stringify(m.labels));
      ok("「我要问什么」有可见标签", m.labels.some((t) => t.includes("我要问什么")), JSON.stringify(m.labels));
      // 6) 抓取模式按钮带文字（不是只有图标）
      ok("自动抓取按钮带文字", (byLabel["自动抓取按钮"].text || "").length >= 4, JSON.stringify(byLabel["自动抓取按钮"].text));
      ok("手动拖入按钮带文字", (byLabel["手动拖入按钮"].text || "").length >= 4, JSON.stringify(byLabel["手动拖入按钮"].text));

      // 7) **设置抽屉**（R11 补的那一层）
      //    为什么补：用户实测「悬浮球点开设置后窗口文字重叠」——
      //    抽屉原是 `.app` 的第三个 flex 兄弟，而 `.body` 的子项都是 `flex:0 0 auto` 且有 min-height，
      //    抽屉一占高就把 `.body` 压到比内容还矮，**子项直接溢出压到抽屉上**。
      //    这一层以前只测"主界面 6 个控件"，**从没打开过抽屉**，所以它漏过去了。
      //    断言口径：打开抽屉后 ① 每行都完整在视口内；② 行与行之间不重叠；
      //              ③ 抽屉不与被它盖住的内容区**产生视觉混排**（这里用"抽屉首行不得与内容框重叠"抓）。
      const drawer = await send("Runtime.evaluate", {
        expression: `(() => {
          const d = document.getElementById('setDrawer');
          if (!d) return JSON.stringify({ missing: true });
          d.classList.add('open');
          const rows = [...d.querySelectorAll('.row')];
          const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
          const first = rows[0] ? rect(rows[0]) : null;
          const src = document.getElementById('source');
          const srcRect = src ? rect(src) : null;
          const grabBox = document.querySelector('.drawer .grab-box');
          const grabText = grabBox ? (grabBox.textContent || '').trim() : '';
          return JSON.stringify({
            count: rows.length,
            rows: rows.map(rect),
            rect: rect(d),
            first, srcRect, grabText,
            vw: innerWidth, vh: innerHeight,
            docH: document.documentElement.scrollHeight,
          });
        })()`,
        returnByValue: true,
      });
      const dg = JSON.parse(drawer.result.value || "{}");
      ok("设置抽屉能打开且有内容", !dg.missing && dg.count >= 5, `行数=${dg.count}`);
      if (!dg.missing && dg.count >= 5) {
        const outRows = dg.rows.filter((r) => r.y < -1 || r.x < -1 || r.bottom > dg.vh + 1 || r.right > dg.vw + 1);
        ok("抽屉每一行都完整落在窗口内", outRows.length === 0,
          `${outRows.length} 行越界，例如 ${JSON.stringify(outRows[0] || {})} 视口=${dg.vw}×${dg.vh}`);
        let stacked = 0; let sample = null;
        for (let i = 1; i < dg.rows.length; i++) {
          const a = dg.rows[i - 1]; const b = dg.rows[i];
          const bad = !(a.bottom <= b.y + 1 || b.bottom <= a.y + 1 || a.right <= b.x + 1 || b.right <= a.x + 1);
          if (bad) { stacked++; sample = sample || { a, b }; }
        }
        ok("抽屉内各行不重叠", stacked === 0, `${stacked} 对重叠，例如 ${JSON.stringify(sample || {})}`);
        ok("抽屉不压到内容框（文字不叠字）", !dg.srcRect || !dg.first ||
          !(dg.first.bottom > dg.srcRect.y + 1 && dg.first.y < dg.srcRect.bottom - 1 &&
            dg.first.right > dg.srcRect.x + 1 && dg.first.x < dg.srcRect.right - 1),
          `抽屉首行=${JSON.stringify(dg.first)} 内容框=${JSON.stringify(dg.srcRect)}`);
      }
    }
  } catch (e) {
    console.log(`[SKIP] 环境不可用：${e.message}`);
    try { ws?.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(2);
  }

  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log("");
  console.log(`面板版面守门：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("面板版面守门异常：" + (e && e.message ? e.message : e));
  process.exit(2);
});
