import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

// floating-ball 项目根目录（与本项目同级）
const BALL_DIR = path.resolve(__dirname, "floating-ball");

// 桥接目录：与 Electron userData 同址（包名 chunxiao-ball）
const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const BRIDGE_DIR = path.join(APPDATA, "chunxiao-ball");
// 球 → 主程序（主程序读）
const BRIDGE_FILE = path.join(BRIDGE_DIR, "from-ball.json");
// 主程序 → 球（球读）
const CTRL_FILE = path.join(BRIDGE_DIR, "to-ball.json");

// 在 dist/ 下按版本号取**最新**的便携版（不要写死版本号，否则重打包后指向旧包）
function newestPortable(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const ver = (n: string) => (n.match(/\d+/g) ?? []).map(Number);
  const cands = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("春晓助手") && n.endsWith(".exe"))
    .sort((a, b) => {
      const va = ver(a);
      const vb = ver(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] ?? 0) - (vb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  return cands.length ? path.join(dir, cands[cands.length - 1]) : null;
}

// 找 Electron 可执行文件（与 Rust 端 resolve_ball 的探测顺序保持一致）
function resolveElectron(): string | null {
  const dev = path.join(BALL_DIR, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(dev)) return dev;
  const unpacked = path.join(BALL_DIR, "dist", "win-unpacked", "春晓助手.exe");
  if (fs.existsSync(unpacked)) return unpacked;
  return newestPortable(path.join(BALL_DIR, "dist"));
}

// spawn 悬浮球（单实例锁保证不会重复启动）
let spawned = false;
function ensureBallRunning() {
  if (spawned) return true;
  const electron = resolveElectron();
  if (!electron) {
    console.warn("[ball-bridge] 找不到 Electron 可执行文件，无法自动启动春晓");
    return false;
  }
  console.log(`[ball-bridge] 自动启动春晓: ${electron}`);
  try {
    const proc = spawn(electron, [BALL_DIR, "--child"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    proc.unref();
    spawned = true;
    proc.on("error", () => { spawned = false; });
    proc.on("exit", () => { spawned = false; });
    return true;
  } catch (e) {
    console.warn(`[ball-bridge] 启动春晓失败: ${(e as Error).message}`);
    return false;
  }
}

// 纯 JS 桥接轮询插件
// 双向：读 from-ball.json 推给浏览器；浏览器发命令 → Vite spawn 悬浮球 + 写 to-ball.json
function ballBridgePlugin(): Plugin {
  let lastTs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    name: "ball-bridge-poller",
    configureServer(server) {
      console.log(`[ball-bridge] 监听 ${BRIDGE_FILE}`);
      console.log(`[ball-bridge] 控制端点 POST /__ball_cmd__ → 春晓进程`);

      // 1. 悬浮球 → 主程序：轮询桥接文件推给浏览器
      timer = setInterval(() => {
        try {
          if (!fs.existsSync(BRIDGE_FILE)) return;
          const content = fs.readFileSync(BRIDGE_FILE, "utf8");
          const msg = JSON.parse(content);
          if (msg.ts && msg.ts > lastTs) {
            lastTs = msg.ts;
            server.hot.send("ball-push", {
              text: msg.text ?? "",
              action: msg.action ?? "prefill",
              ts: msg.ts,
            });
            try { fs.unlinkSync(BRIDGE_FILE); } catch {}
          }
        } catch {
          // 文件不存在 / JSON 错误都是正常情况
        }
      }, 1200);

      // 2. 主程序 → 悬浮球：收到命令时先确保球活着，再写控制文件
      server.middlewares.use("/__ball_cmd__", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

          const started = ensureBallRunning();
          if (!started && body.cmd !== "quit") {
            res.statusCode = 503;
            res.end(JSON.stringify({ ok: false, error: "春晓无法启动" }));
            return;
          }

          fs.writeFileSync(CTRL_FILE, JSON.stringify(body, null, 2), "utf8");
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
    },
    closeServer() {
      if (timer) clearInterval(timer);
    },
  };
}

const plugins: Plugin[] = [react(), ballBridgePlugin()];

// 版本号只有**一个来源**：package.json。
// 通过 define 注入到前端（`__APP_VERSION__`），这样界面里显示的版本
// 不可能与 package.json / Cargo.toml / tauri.conf.json 的口径漂移。
const APP_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export default defineConfig({
  plugins,
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
