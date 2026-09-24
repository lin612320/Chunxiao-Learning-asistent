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
import { invoke } from "@tauri-apps/api/core";
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

/**
 * R7：把**主窗口当前正在看的课程**告诉悬浮球（球默认跟随它检索）。
 *
 * 为什么要有这一步：球的检索范围是球自己的设置，默认「不限定课程」——
 * 用户在《数据库系统》里划词点「关联知识点」，实际会**查全库**，与按钮上写的
 * 「先在这门课的材料 / 先验知识 / 知识点里查」不符（`docs/11` §一 第 2 条：
 * 界面写什么就必须按什么查）。由主窗口在课程上下文变化时同步一次，两边就一致了。
 *
 * ⚠ 只在桌面版有意义（球是外部进程）；浏览器预览下静默跳过。
 *   失败也不弹窗：这只是"让球更准一点"，不该打扰用户，更不该拦住导航。
 *
 * ⚠⚠ **刻意不走 `callRust` / `invokeStrict`**：这两个封装失败时都会 `console.error`，
 *    而真机 UI 冒烟把 console error 当成失败（`scripts/smoke-desktop-ui.mjs`）。
 *    这是一次**尽力而为**的后台同步（不是用户触发的写入），失败只该留个 warn：
 *    0.7.2 的旧 exe 里没有 `ball_set_course`，本轮实测每次导航都会刷 3 条 console error，
 *    把真机冒烟整层打红 —— 那条红**指向的是版本不匹配，不是功能坏了**，不该让它冒充功能失败。
 */
export async function ballSyncCourse(courseId: number | null) {
  if (!isTauri()) return;
  try {
    await invoke<void>("ball_set_course", { courseId });
  } catch (e) {
    console.warn("[ball] 同步课程范围失败（不影响主界面，下次切换课程会重试）:", e);
  }
}

// ---------------------------------------------------------------------------
// floating-ball → 主程序 推送监听（双模式）
// ---------------------------------------------------------------------------

export interface BallPushPayload {
  text: string;
  action: string; // prefill | ask | material_search | set_course | …
  ts: number;
  /**
   * R4（`docs/11` §六 冻结字段）：这次推送所属的课程。
   * `action === "ask"` 时，主程序**已把问答写进该课程的会话**，前端只需刷新界面。
   *
   * ⚠ R5 起那个会话是**球专属**的（`chat_sessions.origin = "ball"`，标题「悬浮球问答」）：
   * 主窗口默认只列 `origin = "app"` 的会话，所以球的问答**不会插进**用户正在看的那个对话里
   * （用户要的「对话记录与主窗口分开」）。打开「含悬浮球记录」后才会一并列出。
   */
  course_id?: number | null;
  /** R4：`action === "ask"` 时主程序落库所用的会话 id（R5 起必为球专属会话） */
  session_id?: number;
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
