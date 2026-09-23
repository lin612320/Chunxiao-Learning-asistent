// 与 Rust 后端通信的辅助封装（Tauri v2 invoke）。

import { invoke } from "@tauri-apps/api/core";

/** 是否运行在 Tauri 桌面环境里（true 表示可由 Rust 后端提供服务） */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 调用 Rust 侧命令。
 * - 在 Tauri 环境正常调用；
 * - 在纯浏览器/仅前端预览时返回 null，方便先用占位数据开发 UI。
 *
 * ⚠️ 会吞掉错误：命令失败时返回 null，调用方无法区分「成功但无数据」与「失败」。
 *    写入类操作（新增 / 保存 / 删除）请改用 invokeStrict，否则用户点了没反应也看不到原因。
 */
export async function callRust<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    console.error(`[tauri] 调用 ${cmd} 失败：`, e);
    return null;
  }
}

/**
 * 严格调用 Rust 命令：失败直接抛出（错误文本来自 Rust），供写入类操作使用。
 *
 * 参数命名：Tauri v2 默认把 Rust 侧 snake_case 的参数名映射为 **camelCase** 再从 JS 读取，
 * 例如 Rust `course_id` 必须传 `courseId`。名字写错不会报「未知字段」：
 * Option 字段会静默变成 None（数据被丢弃），必填字段则整条命令失败。
 */
export async function invokeStrict<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("当前为浏览器预览模式，该操作仅桌面版可用。");
  }
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[tauri] 调用 ${cmd} 失败：`, e);
    throw new Error(msg);
  }
}
