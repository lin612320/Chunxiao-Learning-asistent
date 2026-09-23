// Vite 开发服务器 + Electron 悬浮球（春晓）一键联调
//
//   npm run dev:all
//
// 做三件事：
//   1. 启动 Vite（端口 1420）
//   2. 等端口就绪后，spawn Electron 悬浮球（--child，不抢全局快捷键）
//   3. 任一进程退出 → 一起收摊

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const BALL_DIR = path.join(ROOT, "floating-ball");
const PORT = 1420;

// 在 dist/ 下按版本号取**最新**的便携版（不要写死版本号，否则重打包后指向旧包）
function newestPortable(dir) {
  if (!fs.existsSync(dir)) return null;
  const ver = (n) => (n.match(/\d+/g) || []).map(Number);
  const cands = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("春晓助手") && n.endsWith(".exe"))
    .sort((a, b) => {
      const va = ver(a);
      const vb = ver(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] || 0) - (vb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  return cands.length ? path.join(dir, cands[cands.length - 1]) : null;
}

// 解析 Electron 可执行文件（开发态 → win-unpacked → 最新便携版）
function resolveElectron() {
  const dev = path.join(BALL_DIR, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(dev)) return dev;
  const unpacked = path.join(BALL_DIR, "dist", "win-unpacked", "春晓助手.exe");
  if (fs.existsSync(unpacked)) return unpacked;
  return newestPortable(path.join(BALL_DIR, "dist"));
}

// 探测 Vite 是否就绪（避免球先起来、主程序还没供上）
function waitForVite(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/" }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

const children = [];
function shutdown(code = 0) {
  for (const c of children) {
    if (c && !c.killed) {
      try { c.kill(); } catch { /* ignore */ }
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

(async () => {
  console.log("[dev:all] 启动 Vite …");
  const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, stdio: "inherit", shell: true });
  children.push(vite);
  vite.on("exit", (code) => shutdown(code ?? 0));

  const ready = await waitForVite();
  if (!ready) {
    console.warn(`[dev:all] Vite 在 ${PORT} 端口未就绪，仍尝试启动悬浮球（球可独立运行）`);
  } else {
    console.log(`[dev:all] Vite 就绪：http://localhost:${PORT}`);
  }

  const electron = resolveElectron();
  if (!electron) {
    console.warn("[dev:all] 未找到 Electron。请先在 floating-ball/ 下执行 npm install");
    console.warn("[dev:all] （Vite 仍在运行，可只调前端：http://localhost:1420）");
    return;
  }

  console.log(`[dev:all] 启动春晓悬浮球：${electron}`);
  const ball = spawn(electron, [BALL_DIR, "--child"], {
    cwd: BALL_DIR,
    stdio: "inherit",
    windowsHide: false,
  });
  children.push(ball);
  ball.on("exit", (code) => {
    console.log(`[dev:all] 悬浮球退出（code=${code}）`);
  });
})();
