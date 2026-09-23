// 春晓学习助手 · SVG → PNG 光栅化器（零第三方依赖）
//
//   node scripts/svg-to-png.mjs --svg src/assets/mascot.svg --out out.png --size 512 [--pad 24] [--cdp 9226]
//
// 为什么要自己写：
//   · 项目约定 **不新增任何依赖**，而 Windows 没有内置 SVG 光栅化器；
//   · App 图标必须从**同一份矢量母版**产出（`src/assets/mascot.svg`），
//     否则「App 内的形象」与「exe 图标」会各画一套、慢慢漂移。
//   于是借已经在用的 Chromium 内核（Edge 无头）+ CDP 做光栅化 —— 与 `smoke-ui.mjs` 同一套手法。
//
// 关键实现点（都是踩过才知道的）：
//   · **透明背景**要两道设置：`Emulation.setDefaultBackgroundColorOverride`（页面底）
//     ＋ `Page.captureScreenshot{omitBackground:true}`（截图 omit alpha 合成白底）。只做后者会得到白底。
//   · 起浏览器必须 `stdio: 'ignore'`：受限环境下用管道 stdio 起子进程会 EPERM。
//   · 用 `file://` 临时页面而不是 `data:` URL：Chrome 对顶层 `data:` 导航有额外限制。
//   · Edge 会拉起一堆子进程，退出必须 `taskkill /T`（只杀父进程会留孤儿占着调试端口）。
//
// 退出码：0 成功 / 2 环境不可用（找不到 Edge 或起不来）

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = { pad: 0, cdp: 9226, edge: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--svg") out.svg = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--size") out.size = Number(argv[++i]);
    else if (a === "--pad") out.pad = Number(argv[++i]);
    else if (a === "--cdp") out.cdp = Number(argv[++i]);
    else if (a === "--edge") out.edge = argv[++i];
  }
  return out;
}

function findEdge(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  const cands = [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || "";
}

function buildHtml(svgText, size, pad) {
  const inner = Math.max(1, size - pad * 2);
  // 母版自带 viewBox，靠 CSS 拉伸到 inner；不在这里改写它的属性，保持"母版即唯一真相"
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
#stage{width:${inner}px;height:${inner}px;margin:${pad}px}
#stage>svg{display:block;width:100%;height:100%}
</style></head><body><div id="stage">${svgText}</div></body></html>`;
}

const sockets = new Set();
async function hardExit(code) {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
  await new Promise((r) => setTimeout(r, 80));
  process.exit(code);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || "CDP error"));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeoutMs);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.svg || !args.out || !args.size) {
    console.error("用法：node scripts/svg-to-png.mjs --svg <file> --out <file> --size <px> [--pad <px>] [--cdp <port>]");
    await hardExit(2);
  }
  if (!existsSync(args.svg)) {
    console.error(`找不到 SVG 母版：${args.svg}`);
    await hardExit(2);
  }
  const edge = findEdge(args.edge);
  if (!edge) {
    console.error("[SKIP] 未找到 msedge.exe —— 无法光栅化 SVG（本机没装 Edge 时请保留既有图标产物，不要清空）");
    await hardExit(2);
  }

  const svgText = readFileSync(args.svg, "utf8");
  const work = mkdtempSync(path.join(tmpdir(), "cx-raster-"));
  const profile = path.join(work, "profile");
  mkdirSync(profile, { recursive: true });
  const htmlPath = path.join(work, "page.html");
  writeFileSync(htmlPath, buildHtml(svgText, args.size, args.pad), "utf8");
  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

  const child = spawn(
    edge,
    [
      "--headless=new",
      `--remote-debugging-port=${args.cdp}`,
      `--user-data-dir=${profile}`,
      `--window-size=${args.size},${args.size}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    // ⚠ 必须 ignore：受限环境下用管道 stdio 起子进程会 EPERM
    { stdio: "ignore" },
  );

  let code = 2;
  try {
    const deadline = Date.now() + 40000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${args.cdp}/json/version`);
        version = await r.json();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!version) throw new Error(`Edge 的 CDP 端点未就绪（127.0.0.1:${args.cdp}）`);

    const targets = await (await fetch(`http://127.0.0.1:${args.cdp}/json`)).json();
    const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
    if (!page) throw new Error("未找到 page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    sockets.add(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(new Error("WS 连接失败：" + (e.message || ""))));
    });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: args.size,
      height: args.size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // 透明背景第 1 道：页面底色设为全透明
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    await cdp.send("Page.navigate", { url: fileUrl });

    // 等 SVG 真正画完（readyState + 字体就绪 + 一帧余量）
    const paintDeadline = Date.now() + 20000;
    for (;;) {
      const state = await cdp.eval("document.readyState").catch(() => "");
      const fonts = await cdp.eval("document.fonts ? document.fonts.status : 'loaded'").catch(() => "loaded");
      const hasSvg = await cdp.eval("!!document.querySelector('#stage svg')").catch(() => false);
      if (state === "complete" && fonts === "loaded" && hasSvg) break;
      if (Date.now() > paintDeadline) throw new Error("等待页面绘制超时");
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 250));

    // 透明背景第 2 道：截图时 omitBackground
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      omitBackground: true,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: args.size, height: args.size, scale: 1 },
    });
    const buf = Buffer.from(shot.data, "base64");
    if (buf.length < 200) throw new Error(`截图内容过小（${buf.length} B），可能没渲染出来`);
    mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    writeFileSync(args.out, buf);
    console.log(`  ${path.basename(args.out)}  ${args.size}x${args.size}  ${buf.length} B  (${version.Browser})`);
    code = 0;
  } catch (e) {
    console.error(`光栅化失败：${e && e.message ? e.message : e}`);
  } finally {
    // Edge 是多进程，必须杀进程树，否则孤儿会一直占着调试端口
    if (child && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
    // 按临时 profile 路径兜底清理（taskkill 偶尔漏掉已脱离的孙进程）
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile.replace(/\\/g, "\\\\")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "ignore" },
    );
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await hardExit(code);
}

main().catch(async (e) => {
  console.error("svg-to-png 异常：" + (e && e.stack ? e.stack : e));
  await hardExit(2);
});
