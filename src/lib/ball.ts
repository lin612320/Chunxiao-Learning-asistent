// Electron 悬浮球调用封装
//
// 三模式自适应：
//   1. Tauri 桌面模式 → Rust 端 spawn + 文件轮询 → Tauri event 推送
//   2. Vite 浏览器模式 → 写反向控制文件 → floating-ball 轮询执行
//   3. 纯浏览器（无桥接） → 所有函数静默跳过
//
// 命令名以《01-M0骨架契约》§三 为准：
//   ball_start_cmd / ball_show / ball_hide / ball_prefill / ball_quit

import { callRust, invokeStrict, isTauri } from "./tauri";
import { listen } from "@tauri-apps/api/event";

// 前端（浏览器）访问不了文件系统，反向控制通过 fetch 调 Vite 插件来写控制文件
async function sendBallCmd(cmd: string, extra: Record<string, unknown> = {}) {
  if (isTauri()) return; // Tauri 走 Rust invoke，不进这里
  // Vite 模式：通过 fetch POST 给 Vite 插件，插件写控制文件
  try {
    await fetch("/__ball_cmd__", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), cmd, ...extra }),
    });
  } catch {
    // fetch 失败说明 Vite 没启 ball 插件，静默跳过
  }
}

/** 启动春晓悬浮球（Tauri 模式直接 spawn；Vite 模式由 dev:all 提前拉起） */
export async function ballStart() {
  if (!isTauri()) return;
  try {
    // 无参命令（与母本一致）：启动后的一切指令经控制文件下发，不走进程参数
    await invokeStrict<void>("ball_start_cmd");
  } catch (e) {
    console.warn("[ball] 启动失败:", e);
  }
}

/** 让悬浮球显示到桌面（打开面板）；失败时弹出可见提示（含具体原因） */
export async function ballShow() {
  if (isTauri()) {
    try {
      await invokeStrict<void>("ball_show");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[ball] show 失败:", msg);
      try {
        window.alert(`春晓悬浮球启动失败：${msg}`);
      } catch {
        /* ignore */
      }
    }
  } else {
    await sendBallCmd("show");
  }
}

/** 隐藏悬浮球面板（进程不退出） */
export async function ballHide() {
  if (isTauri()) {
    await callRust<void>("ball_hide");
  } else {
    await sendBallCmd("hide");
  }
}

/** 把一段文本预填进悬浮球面板（划词抓取 / 手动拖入的落点） */
export async function ballPrefill(text: string) {
  if (isTauri()) {
    await callRust<void>("ball_prefill", { text });
  } else {
    await sendBallCmd("prefill", { text });
  }
}

/** 彻底退出悬浮球进程 */
export async function ballQuit() {
  if (isTauri()) {
    await callRust<void>("ball_quit");
  } else {
    await sendBallCmd("quit");
  }
}

// ---------------------------------------------------------------------------
// floating-ball → 主程序 推送监听（双模式）
// ---------------------------------------------------------------------------

export interface BallPushPayload {
  text: string;
  action: string; // prefill | ask
  ts: number;
}

/**
 * 监听 floating-ball 推送过来的文字
 * 自动适配 Tauri event / Vite HMR / 静默跳过
 */
export async function onBallPush(handler: (payload: BallPushPayload) => void) {
  // 1. Tauri 桌面模式
  if (isTauri()) {
    const unlisten = await listen<BallPushPayload>("ball-push", (e) => {
      handler(e.payload);
    });
    return unlisten;
  }

  // 2. Vite HMR 模式（dev:all 启用了 vite-ball-bridge 插件）
  // @ts-expect-error - import.meta.hot 是 Vite 专属
  if (import.meta.hot?.on) {
    // @ts-expect-error
    import.meta.hot.on("ball-push", (payload: BallPushPayload) => {
      handler(payload);
    });
    return () => { /* Vite HMR 不需要手动取消 */ };
  }

  // 3. 纯浏览器模式（无桥接）
  return () => {};
}
