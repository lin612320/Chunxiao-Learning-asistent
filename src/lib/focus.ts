// 番茄钟命令封装（M3 契约 §二「番茄钟」/ §4.2 番茄钟页）。
//
// 互操作口径（docs/01-M0骨架契约.md §四.1，已冻结，逐字遵循）：
//   · 命令参数一律 **camelCase**：courseId / planMin / actualMin / days / limit；
//   · 行返回字段一律 **snake_case**：started_at / plan_min / actual_min / completed / kind；
//   · 空列表一律返回 `[]`（不返回 null）；前端按数组处理。
//
// 写入类（focus_start / focus_finish / focus_notify）一律走 invokeStrict：
// 失败会抛出可读中文错误，由调用方接住展示，绝不静默吞掉。
// 读取类（focus_stats / focus_list）走 callRust：拿不到就如实降级为「暂无记录」，不造数据。
//
// 浏览器预览（!isTauri()）降级：
//   · 统计 / 列表 → null / []，界面显示「暂无记录」并说明原因（不编造柱状图）；
//   · 系统通知 → 不调用命令，返回 sent=false + 如实说明；
//   · 写记录 → 由 useFocus 走内存临时 id（见 PREVIEW_RECORD_NOTE），不冒充落库。

import { callRust, invokeStrict, isTauri } from "./tauri";

/** 阶段类型：与 Rust 侧 `kind` 取值逐字一致（非法值由 Rust 给可读中文错误） */
export type FocusKind = "focus" | "break";

/** 偏好持久化的 localStorage 键（契约 §4.2 固定为 chunxiao:focus） */
export const LS_FOCUS = "chunxiao:focus";

/** 时长范围（契约 §4.2：专注 1–120 分钟、休息 1–60 分钟） */
export const FOCUS_RANGE = { min: 1, max: 120 } as const;
export const BREAK_RANGE = { min: 1, max: 60 } as const;

export interface FocusPrefs {
  focusMin: number;
  breakMin: number;
}

/** 默认 25 / 5 分钟（番茄工作法的常见默认值；只是默认，用户可改） */
export const DEFAULT_PREFS: FocusPrefs = { focusMin: 25, breakMin: 5 };

export const KIND_LABEL: Record<FocusKind, string> = { focus: "专注", break: "休息" };

/** 预览模式的如实说明（文案口径统一放这里，避免各页面各说一套） */
export const PREVIEW_RECORD_NOTE =
  "网页预览模式：这次计时只留在当前页面，刷新就没了。装好的桌面版才会把记录保存下来。";
export const PREVIEW_STATS_NOTE =
  "网页预览里看不到本机的专注统计，所以这里只显示「暂无记录」，我们不会编数字。";
export const PREVIEW_NOTIFY_NOTE = "网页预览里发不了系统通知；桌面版会在阶段结束时提醒你。";

export function rangeOf(kind: FocusKind): { min: number; max: number } {
  return kind === "focus" ? FOCUS_RANGE : BREAK_RANGE;
}

/** 把任意输入收敛到该阶段的合法分钟数（非法/越界一律夹紧，不用假值凑数） */
export function clampMin(kind: FocusKind, v: number): number {
  const r = rangeOf(kind);
  const fallback = kind === "focus" ? DEFAULT_PREFS.focusMin : DEFAULT_PREFS.breakMin;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(r.max, Math.max(r.min, Math.round(v)));
}

// ---------------------------------------------------------------------------
// 偏好：localStorage（键 chunxiao:focus，存 { focusMin, breakMin }）
// ---------------------------------------------------------------------------

export function loadFocusPrefs(): FocusPrefs {
  try {
    const raw = localStorage.getItem(LS_FOCUS);
    if (!raw) return { ...DEFAULT_PREFS };
    const o = JSON.parse(raw) as Partial<FocusPrefs> | null;
    // 逐字段夹紧：旧版本残留 / 手改坏的值一律回到合法范围
    return {
      focusMin: clampMin("focus", Number(o?.focusMin ?? DEFAULT_PREFS.focusMin)),
      breakMin: clampMin("break", Number(o?.breakMin ?? DEFAULT_PREFS.breakMin)),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveFocusPrefs(p: FocusPrefs): void {
  try {
    localStorage.setItem(
      LS_FOCUS,
      JSON.stringify({
        focusMin: clampMin("focus", p.focusMin),
        breakMin: clampMin("break", p.breakMin),
      }),
    );
  } catch {
    // 隐私模式 / 存储配额用尽：偏好只在本次会话内生效，不影响计时本身
  }
}

// ---------------------------------------------------------------------------
// 行 / 统计结构（字段名逐字按后端 snake_case）
// ---------------------------------------------------------------------------

export interface FocusRow {
  id: number;
  course_id: number | null;
  kind: string;
  plan_min: number;
  actual_min: number | null;
  completed: number;
  started_at: string;
  ended_at: string | null;
}

export interface FocusDayStat {
  /** 本地日期（后端按本地日期聚合；前端只展示，不自己算） */
  date: string;
  min: number;
}

export interface FocusStats {
  today_min: number;
  week_min: number;
  sessions: number;
  by_day: FocusDayStat[];
}

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * 规整后端返回的统计对象。
 * 缺失字段一律兜底为 0 / []，**绝不推算**（例如不按 sessions 去估分钟数）；
 * 返回 null 表示「这不是一个可用的统计对象」→ 界面按「暂无记录」显示。
 */
export function normalizeStats(raw: unknown): FocusStats | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const days: FocusDayStat[] = Array.isArray(o.by_day)
    ? o.by_day
        .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
        .map((d) => ({ date: asText(d.date), min: Math.max(0, asNum(d.min)) }))
    : [];
  return {
    today_min: Math.max(0, asNum(o.today_min)),
    week_min: Math.max(0, asNum(o.week_min)),
    sessions: Math.max(0, asNum(o.sessions)),
    by_day: days,
  };
}

function normalizeRow(raw: unknown): FocusRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = asNum(o.id, NaN);
  if (!Number.isFinite(id)) return null; // 没有 id 的行无法收尾，直接丢弃（不假装有记录）
  const courseId = o.course_id == null ? null : asNum(o.course_id, NaN);
  return {
    id,
    course_id: courseId != null && Number.isFinite(courseId) ? courseId : null,
    kind: asText(o.kind),
    plan_min: Math.max(0, asNum(o.plan_min)),
    actual_min: o.actual_min == null ? null : Math.max(0, asNum(o.actual_min)),
    completed: asNum(o.completed) ? 1 : 0,
    started_at: asText(o.started_at),
    ended_at: o.ended_at == null ? null : asText(o.ended_at),
  };
}

// ---------------------------------------------------------------------------
// 命令封装
// ---------------------------------------------------------------------------

/** 近 N 天统计；返回 null = 读不到（预览模式，或命令失败已记 console） */
export async function focusStats(days = 7): Promise<FocusStats | null> {
  if (!isTauri()) return null;
  const raw = await callRust<unknown>("focus_stats", { days });
  return normalizeStats(raw);
}

/** 专注记录列表（按 started_at 倒序，由后端排序）；读不到就返回 [] */
export async function focusList(limit = 20): Promise<FocusRow[]> {
  if (!isTauri()) return [];
  const raw = await callRust<unknown>("focus_list", { limit });
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRow).filter((r): r is FocusRow => r !== null);
}

/**
 * 阶段**开始**时调用，拿回记录 id（后续 focus_finish 必须带这个 id）。
 * courseId 固定传 null：本页不关联具体课程（契约 §4.2 的调用形状就是 null）。
 */
export async function focusStart(
  kind: FocusKind,
  planMin: number,
  courseId: number | null = null,
): Promise<number> {
  if (kind !== "focus" && kind !== "break") {
    throw new Error(`阶段类型不合法：${String(kind)}（只能是 focus / break）。`);
  }
  const minutes = clampMin(kind, planMin);
  const id = await invokeStrict<number>("focus_start", { courseId, kind, planMin: minutes });
  if (!Number.isFinite(Number(id))) {
    throw new Error("后端没有返回有效的记录 id，本次阶段未开始（不会出现没有开始时间的记录）。");
  }
  return Number(id);
}

/** 阶段**结束**时调用：completed=true 走完整个阶段，false 表示中途重置/离开 */
export async function focusFinish(id: number, actualMin: number, completed: boolean): Promise<void> {
  const minutes = Math.max(0, Math.round(Number.isFinite(actualMin) ? actualMin : 0));
  await invokeStrict<void>("focus_finish", { id, actualMin: minutes, completed });
}

/**
 * 阶段结束的系统通知（`tauri-plugin-notification`）。
 * - 桌面版：走 invokeStrict，失败抛可读中文错误（由调用方决定是否展示）；
 * - 浏览器预览：**不调用命令**，返回 sent=false + 如实说明，绝不假装发过通知。
 */
export async function focusNotify(
  title: string,
  body: string,
): Promise<{ sent: boolean; note: string | null }> {
  if (!isTauri()) return { sent: false, note: PREVIEW_NOTIFY_NOTE };
  await invokeStrict<void>("focus_notify", { title, body });
  return { sent: true, note: null };
}
