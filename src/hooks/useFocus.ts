// 专注（番茄钟）数据层：偏好持久化 + 记录写入 + 统计读取。
//
// 桌面版走 Rust(SQLite focus_sessions)；浏览器预览(!isTauri())：
//   · 统计 / 记录列表 → 如实降级为「暂无记录」（不造数据，不编柱状图）；
//   · 阶段开始 / 结束 → 不写库，用**负数内存 id** 占位（负数不可能与数据库自增 id 撞号），
//     并在界面上说明「本次计时没有落库」。绝不假装记录成功。
//
// 写入类操作一律 invokeStrict（失败可读且可见）；读不到统计不弹错误，
// 只在 `statsFailed` 上标出来，让界面自己措辞。

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/tauri";
import {
  clampMin,
  focusFinish,
  focusList,
  focusStart,
  focusStats,
  loadFocusPrefs,
  saveFocusPrefs,
  type FocusKind,
  type FocusPrefs,
  type FocusRow,
  type FocusStats,
} from "../lib/focus";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 一个正在进行的阶段句柄：local=true 表示只存在于内存（预览模式），没有数据库行 */
export interface FocusSessionHandle {
  id: number;
  local: boolean;
}

export interface UseFocusResult {
  prefs: FocusPrefs;
  setFocusMin: (v: number) => void;
  setBreakMin: (v: number) => void;
  stats: FocusStats | null;
  records: FocusRow[];
  loading: boolean;
  /** 统计读取失败（与"确实没有记录"必须区分：前者说明原因，后者显示暂无记录） */
  statsFailed: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  refresh: () => Promise<void>;
  startSession: (kind: FocusKind, planMin: number) => Promise<FocusSessionHandle | null>;
  finishSession: (handle: FocusSessionHandle, actualMin: number, completed: boolean) => Promise<void>;
}

export function useFocus(): UseFocusResult {
  const [prefs, setPrefs] = useState<FocusPrefs>(() => loadFocusPrefs());
  const [stats, setStats] = useState<FocusStats | null>(null);
  const [records, setRecords] = useState<FocusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statsFailed, setStatsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 预览模式的临时 id：从 -1 递减，只保证"本次会话内唯一"，不作为数据库 id */
  const localIdRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await focusStats(7);
      const list = await focusList(8);
      setStats(s);
      setRecords(list);
      // isTauri() 为真却拿不到统计对象 → 视为读取失败（区分于"没有记录"）
      setStatsFailed(isTauri() && s === null);
    } catch (e) {
      // callRust 已吞掉命令异常；这里只兜底意料之外的错误
      setStats(null);
      setRecords([]);
      setStatsFailed(true);
      console.error("[focus] 读取统计失败：", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // 偏好（localStorage 键 chunxiao:focus）
  // ---------------------------------------------------------------------------

  const setFocusMin = useCallback((v: number) => {
    setPrefs((prev) => {
      const next = { ...prev, focusMin: clampMin("focus", v) };
      saveFocusPrefs(next);
      return next;
    });
  }, []);

  const setBreakMin = useCallback((v: number) => {
    setPrefs((prev) => {
      const next = { ...prev, breakMin: clampMin("break", v) };
      saveFocusPrefs(next);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // 记录写入
  // ---------------------------------------------------------------------------

  /**
   * 阶段开始：调 focus_start 拿 id。
   * 返回 null 表示**记录失败**（错误已写进 error）——调用方据此不要开始计时，
   * 否则会出现"计时了但库里没有这条记录"的错觉。
   */
  const startSession = useCallback(
    async (kind: FocusKind, planMin: number): Promise<FocusSessionHandle | null> => {
      if (!isTauri()) {
        localIdRef.current -= 1;
        return { id: localIdRef.current, local: true };
      }
      try {
        const id = await focusStart(kind, planMin, null);
        setError(null);
        return { id, local: false };
      } catch (e) {
        setError(`记录本次阶段的开始时间失败：${errText(e)}（计时未开始，避免出现没有开始时间的记录）`);
        return null;
      }
    },
    [],
  );

  /**
   * 阶段结束：按 completed 收尾。
   * 预览模式（local 句柄）没有数据库行可收尾，直接跳过（界面已说明不落库）。
   */
  const finishSession = useCallback(
    async (handle: FocusSessionHandle, actualMin: number, completed: boolean): Promise<void> => {
      if (handle.local || !isTauri()) return;
      try {
        await focusFinish(handle.id, actualMin, completed);
        setError(null);
        await refresh();
      } catch (e) {
        setError(
          `记录本次阶段的结束时间失败：${errText(e)}（这条记录会缺少结束时间，可重开页面后到「数据设置」检查本机数据库）`,
        );
      }
    },
    [refresh],
  );

  return {
    prefs,
    setFocusMin,
    setBreakMin,
    stats,
    records,
    loading,
    statsFailed,
    error,
    setError,
    refresh,
    startSession,
    finishSession,
  };
}
