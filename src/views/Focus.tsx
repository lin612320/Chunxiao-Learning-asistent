// 番茄钟页面（M3 契约 §4.2）。
//
// 只做三件事：计时、把阶段记进本机数据库、读回统计。
// **不改动任何模型**：本页不调用模型、不生成内容、不写先验知识/笔记。
//
// 计时口径（重要）：
//   倒计时以**绝对时间戳差**为准（`endAt - Date.now()`），不是"每个 tick 减 1 秒"。
//   原因：浏览器会对后台标签页 / 最小化窗口的定时器做节流，`setInterval` 可能被降到
//   1 秒甚至 1 分钟才触发一次；累加式倒计时会因此越走越慢，跟真实时间脱节。
//   用时间戳算差值，哪怕中间一次 tick 都没跑，回到前台也能立刻对上真实剩余时间。
//
// 记录口径（契约 §4.2）：
//   阶段**开始**调 focus_start 拿 id；阶段**结束**调 focus_finish。
//   中途「重置」以及**离开页面**都会按 `completed: false` 收尾 ——
//   绝不留下"永远没有 ended_at 的悬挂记录"。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocus, type FocusSessionHandle } from "../hooks/useFocus";
import { isTauri } from "../lib/tauri";
import {
  focusNotify,
  KIND_LABEL,
  PREVIEW_NOTIFY_NOTE,
  PREVIEW_STATS_NOTE,
  rangeOf,
  type FocusKind,
} from "../lib/focus";
import "./Focus.css";

/** 阶段状态：idle=未开始/已归零、running=计时中、paused=已暂停（保留剩余时间） */
type Status = "idle" | "running" | "paused";

/** 当前正在记录的阶段（handle.local=true 表示预览模式，没有数据库行） */
interface ActivePhase {
  handle: FocusSessionHandle;
  kind: FocusKind;
  planMin: number;
}

/** 进度环几何：半径 88 / 描边 10，周长用来说 stroke-dasharray */
const RING_R = 88;
const RING_C = 2 * Math.PI * RING_R;

function fmtClock(ms: number): string {
  // 向上取整：刚开始时显示满额（25:00），走到 0 才显示 00:00
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function shortDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[2]}-${m[3]}` : d;
}

export default function Focus() {
  const {
    prefs,
    setFocusMin,
    setBreakMin,
    stats,
    records,
    loading,
    statsFailed,
    error,
    setError,
    startSession,
    finishSession,
  } = useFocus();

  const preview = !isTauri();

  const [phase, setPhase] = useState<FocusKind>("focus");
  const [status, setStatus] = useState<Status>("idle");
  const [leftMs, setLeftMs] = useState(prefs.focusMin * 60000);
  /** 阶段切换 / 重置 / 通知结果的如实提示（不是错误，只是让用户知道发生了什么） */
  const [phaseMsg, setPhaseMsg] = useState<string | null>(null);

  /** 当前阶段应在什么时刻结束（epoch ms）；null = 没有在跑 */
  const endAtRef = useRef<number | null>(null);
  /** 剩余毫秒的同步镜像：事件回调里读"当前"剩余时间，不能依赖 state 的异步更新 */
  const leftRef = useRef(leftMs);
  const sessionRef = useRef<ActivePhase | null>(null);
  /** 阶段自然结束的重入锁：tick 每 200ms 一次，异步收尾期间不能再触发一次 */
  const endingRef = useRef(false);
  /** phase 的镜像，供定时器回调读取（避免闭包读到旧值） */
  const phaseRef = useRef<FocusKind>(phase);

  const planMin = phase === "focus" ? prefs.focusMin : prefs.breakMin;
  const totalMs = planMin * 60000;

  const setLeft = useCallback((ms: number) => {
    leftRef.current = ms;
    setLeftMs(ms);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // 未开始时，计时显示跟随时长设置
  useEffect(() => {
    if (status === "idle") setLeft(totalMs);
  }, [status, totalMs, setLeft]);

  // ---------------------------------------------------------------------------
  // 记录收尾
  // ---------------------------------------------------------------------------

  /**
   * 收尾一个阶段：写 actual_min + completed，并按需刷新统计。
   * actualMin 由调用方按"计划时长 − 剩余时长"算（暂停的时间不算专注）。
   */
  const closePhase = useCallback(
    async (s: ActivePhase, elapsedMs: number, completed: boolean) => {
      sessionRef.current = null;
      endAtRef.current = null;
      await finishSession(s.handle, Math.max(0, Math.round(elapsedMs / 60000)), completed);
    },
    [finishSession],
  );

  // ---------------------------------------------------------------------------
  // 开始 / 暂停 / 继续
  // ---------------------------------------------------------------------------

  const beginPhase = useCallback(
    async (kind: FocusKind, minutes: number) => {
      // 先记库拿 id，再开计时：记录失败就不开始（不让界面显示一段"没被记录"的专注）
      const handle = await startSession(kind, minutes);
      if (!handle) return;
      const now = Date.now();
      sessionRef.current = { handle, kind, planMin: minutes };
      endAtRef.current = now + minutes * 60000;
      setLeft(minutes * 60000);
      setStatus("running");
    },
    [setLeft, startSession],
  );

  /**
   * 阶段自然走完：收尾（completed=true）→ 发通知 → 自动切到下一阶段并继续。
   * 专注 → 休息 → 专注 …… 循环，符合契约 §4.2。
   */
  const handleStageEnd = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    try {
      const finished = phaseRef.current;
      const s = sessionRef.current;
      const minutes = finished === "focus" ? prefs.focusMin : prefs.breakMin;
      sessionRef.current = null;
      endAtRef.current = null;
      setLeft(0);

      if (s) await closePhase(s, minutes * 60000, true);

      // 系统通知：桌面版真发；预览模式不调命令，如实说明没发
      const isFocus = finished === "focus";
      const title = isFocus ? "专注结束" : "休息结束";
      const body = isFocus ? "专注结束，休息一下 ☕" : "休息结束，继续加油 🌱";
      try {
        const r = await focusNotify(title, body);
        setPhaseMsg(
          r.sent
            ? `「${KIND_LABEL[finished]}」已结束，已发系统通知：${title}`
            : `「${KIND_LABEL[finished]}」已结束；未发系统通知：${r.note ?? PREVIEW_NOTIFY_NOTE}`,
        );
      } catch (e) {
        setPhaseMsg(
          `「${KIND_LABEL[finished]}」已结束；系统通知发送失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 自动切下一阶段并继续
      const next: FocusKind = isFocus ? "break" : "focus";
      const nextMin = next === "focus" ? prefs.focusMin : prefs.breakMin;
      phaseRef.current = next;
      setPhase(next);
      setStatus("idle");
      setLeft(nextMin * 60000);
      await beginPhase(next, nextMin);
    } finally {
      endingRef.current = false;
    }
  }, [beginPhase, closePhase, prefs.breakMin, prefs.focusMin, setLeft]);

  // tick 回调放进 ref：定时器只创建一次，不必因回调变化重建
  const stageEndRef = useRef(handleStageEnd);
  useEffect(() => {
    stageEndRef.current = handleStageEnd;
  }, [handleStageEnd]);

  /**
   * 倒计时定时器：只在 running 时存在，暂停 / 重置 / 卸载都会清掉。
   * 每 200ms 只是"刷新显示"，真实剩余时间永远由 `endAt - Date.now()` 决定（见文件头注释）。
   */
  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => {
      const end = endAtRef.current;
      if (end == null) return;
      const left = end - Date.now();
      if (left <= 0) {
        setLeft(0);
        void stageEndRef.current();
      } else {
        setLeft(left);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [status, setLeft]);

  const handleStartPause = useCallback(async () => {
    if (status === "running") {
      const end = endAtRef.current;
      if (end != null) setLeft(Math.max(0, end - Date.now()));
      endAtRef.current = null;
      setStatus("paused");
      return;
    }
    if (status === "paused") {
      endAtRef.current = Date.now() + leftRef.current;
      setStatus("running");
      return;
    }
    setPhaseMsg(null);
    await beginPhase(phase, planMin);
  }, [beginPhase, phase, planMin, setLeft, status]);

  /** 重置：把当前阶段按"未完成"收尾后归零，不留悬挂记录 */
  const handleReset = useCallback(async () => {
    const s = sessionRef.current;
    if (s) {
      const elapsed = Math.max(0, s.planMin * 60000 - leftRef.current);
      await closePhase(s, elapsed, false);
      setPhaseMsg(
        `已重置：本段「${KIND_LABEL[s.kind]}」按未完成收尾（记录会标为未完成，不会留下没有结束时间的记录）。计时未开始的部分没有记录。`,
      );
    } else {
      setPhaseMsg(null);
    }
    endAtRef.current = null;
    setStatus("idle");
    setLeft(totalMs);
  }, [closePhase, setLeft, totalMs]);

  /** 未开始时手动切换阶段（计时中不允许切，避免记录与显示对不上） */
  const switchPhase = useCallback(
    (k: FocusKind) => {
      if (status !== "idle") return;
      setPhase(k);
      phaseRef.current = k;
      setLeft((k === "focus" ? prefs.focusMin : prefs.breakMin) * 60000);
      setPhaseMsg(null);
    },
    [prefs.breakMin, prefs.focusMin, setLeft, status],
  );

  // ---------------------------------------------------------------------------
  // 卸载兜底
  // ---------------------------------------------------------------------------

  // 离开页面 / 关闭窗口时收尾正在进行的阶段（fire-and-forget）：
  // 契约要求不留"永远没有 ended_at 的悬挂记录"，所以这里必须写回一次 completed=false。
  useEffect(() => {
    return () => {
      const s = sessionRef.current;
      sessionRef.current = null;
      endAtRef.current = null;
      if (!s) return;
      const elapsed = Math.max(0, s.planMin * 60000 - leftRef.current);
      void finishSession(s.handle, Math.round(elapsed / 60000), false);
    };
  }, [finishSession]);

  // ---------------------------------------------------------------------------
  // 展示计算
  // ---------------------------------------------------------------------------

  const ratio = totalMs > 0 ? Math.min(1, Math.max(0, 1 - leftMs / totalMs)) : 0;
  const clock = fmtClock(leftMs);
  const running = status === "running";
  const idle = status === "idle";
  const stepDisabled = !idle;

  const focusRange = rangeOf("focus");
  const breakRange = rangeOf("break");

  const maxDayMin = useMemo(() => {
    if (!stats || stats.by_day.length === 0) return 1;
    return Math.max(1, ...stats.by_day.map((d) => d.min));
  }, [stats]);

  const noStats = !stats || (stats.sessions === 0 && stats.today_min === 0 && stats.week_min === 0);

  return (
    <div className="page-stack focus-page">
      <div className="section-head">
        <div>
          <h2 style={{ marginBottom: 4 }}>专注计时</h2>
          <span className="muted">
            番茄钟：专注 → 休息 → 专注 自动循环 · 本地单机 · 数据在本机
          </span>
        </div>
        <span className="tag">只计时与记录 · 不改动模型</span>
      </div>

      {error && (
        <div className="settings-msg err" onClick={() => setError(null)} title="点一下关闭这条提示">
          {error}
        </div>
      )}
      {phaseMsg && (
        <div className="settings-msg ok" onClick={() => setPhaseMsg(null)} title="点一下关闭这条提示">
          {phaseMsg}
        </div>
      )}

      {preview && (
        <div className="demo-banner">
          <span>
            <b>浏览器预览模式</b>：本次计时只留在当前页面，刷新就没了；装好的桌面版才会把记录保存下来。
          </span>
        </div>
      )}

      <section className="card focus-timer-card">
        <div className="focus-phase-chips">
          {(["focus", "break"] as FocusKind[]).map((k) => (
            <button
              key={k}
              className={"focus-chip" + (phase === k ? " active" : "")}
              disabled={!idle}
              title={idle ? `切到「${KIND_LABEL[k]}」阶段（未开始时可以切）` : "计时进行中不能切阶段，先暂停或重置"}
              onClick={() => switchPhase(k)}
            >
              {KIND_LABEL[k]}
              {phase === k ? " · 当前" : ""}
            </button>
          ))}
          <span className="muted focus-status">
            {status === "running" ? "计时中" : status === "paused" ? "已暂停（剩余时间已保留）" : "未开始"}
          </span>
        </div>

        <div className="focus-ring-row">
          <div className="focus-ring-wrap">
            <svg className="focus-ring" viewBox="0 0 200 200" role="img" aria-label={`${KIND_LABEL[phase]}剩余 ${clock}`}>
              <circle className="focus-ring-track" cx="100" cy="100" r={RING_R} />
              <circle
                className={"focus-ring-bar" + (phase === "break" ? " is-break" : "")}
                cx="100"
                cy="100"
                r={RING_R}
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - ratio)}
              />
            </svg>
            <div className="focus-ring-center">
              <div className="focus-clock">{clock}</div>
              <div className="focus-clock-label">
                {KIND_LABEL[phase]} · 共 {planMin} 分钟
              </div>
            </div>
          </div>

          <div className="focus-controls">
            <button className="focus-main-btn" onClick={() => void handleStartPause()}>
              {running ? "暂停" : status === "paused" ? "继续" : `开始${KIND_LABEL[phase]}`}
            </button>
            <button
              className="ghost-btn"
              disabled={idle && leftMs >= totalMs}
              title="把当前阶段按「未完成」收尾并归零"
              onClick={() => void handleReset()}
            >
              重置
            </button>
            <p className="muted focus-tip">
              倒计时按真实经过的时间算：切到别的标签页或把窗口最小化都不会走偏。阶段结束后会自动切到下一阶段并继续。
              阶段结束后自动切到下一阶段并继续。
            </p>
          </div>
        </div>

        <div className="focus-durations">
          <div className="focus-duration">
            <span className="focus-duration-label">专注时长</span>
            <div className="focus-stepper">
              <button
                className="focus-step-btn"
                disabled={stepDisabled || prefs.focusMin <= focusRange.min}
                title={stepDisabled ? "计时进行中不能改时长，先暂停或重置" : "减少 1 分钟"}
                onClick={() => setFocusMin(prefs.focusMin - 1)}
              >
                −
              </button>
              <span className="focus-duration-value">{prefs.focusMin} 分钟</span>
              <button
                className="focus-step-btn"
                disabled={stepDisabled || prefs.focusMin >= focusRange.max}
                title={stepDisabled ? "计时进行中不能改时长，先暂停或重置" : "增加 1 分钟"}
                onClick={() => setFocusMin(prefs.focusMin + 1)}
              >
                ＋
              </button>
            </div>
            <span className="muted">范围 {focusRange.min}–{focusRange.max} 分钟</span>
          </div>

          <div className="focus-duration">
            <span className="focus-duration-label">休息时长</span>
            <div className="focus-stepper">
              <button
                className="focus-step-btn"
                disabled={stepDisabled || prefs.breakMin <= breakRange.min}
                title={stepDisabled ? "计时进行中不能改时长，先暂停或重置" : "减少 1 分钟"}
                onClick={() => setBreakMin(prefs.breakMin - 1)}
              >
                −
              </button>
              <span className="focus-duration-value">{prefs.breakMin} 分钟</span>
              <button
                className="focus-step-btn"
                disabled={stepDisabled || prefs.breakMin >= breakRange.max}
                title={stepDisabled ? "计时进行中不能改时长，先暂停或重置" : "增加 1 分钟"}
                onClick={() => setBreakMin(prefs.breakMin + 1)}
              >
                ＋
              </button>
            </div>
            <span className="muted">范围 {breakRange.min}–{breakRange.max} 分钟</span>
          </div>
        </div>

        <p className="muted focus-note">
          时长偏好保存在本机浏览器存储里，下次打开还在。
          {stepDisabled ? "正在计时，时长暂时锁定。" : ""}
        </p>
      </section>

      <section className="card">
        <h3>专注统计</h3>
        {statsFailed ? (
          <p className="empty">
            暂时读不到本机统计（这次读取没有返回数据）。这里不会用估算的数字顶上，
            请稍后重试或到「数据设置」检查本机数据。
          </p>
        ) : noStats ? (
          <p className="empty">
            暂无记录。
            {preview
              ? PREVIEW_STATS_NOTE
              : "完成一段专注或休息后，这里会显示今日分钟数与近 7 天柱状图。"}
          </p>
        ) : (
          <>
            <div className="stat-row">
              <div className="stat">
                <div className="stat-value">{stats.today_min}</div>
                <div className="stat-label">今日专注分钟数</div>
              </div>
              <div className="stat">
                <div className="stat-value">{stats.week_min}</div>
                <div className="stat-label">近 7 天专注分钟数</div>
              </div>
              <div className="stat">
                <div className="stat-value">{stats.sessions}</div>
                <div className="stat-label">近 7 天阶段记录数（含休息）</div>
              </div>
            </div>

            <div className="focus-chart" role="img" aria-label="近 7 天专注分钟数柱状图">
              {stats.by_day.length === 0 ? (
                <p className="muted">这次读取没有返回按天的数据。</p>
              ) : (
                stats.by_day.map((d) => (
                  <div className="focus-bar-col" key={d.date} title={`${d.date}：${d.min} 分钟`}>
                    <span className="focus-bar-value">{d.min > 0 ? d.min : ""}</span>
                    <div className="focus-bar-track">
                      <div
                        className="focus-bar"
                        style={{ height: `${Math.max(d.min > 0 ? 4 : 0, (d.min / maxDayMin) * 100)}%` }}
                      />
                    </div>
                    <span className="focus-bar-date">{shortDate(d.date)}</span>
                  </div>
                ))
              )}
            </div>
            <p className="muted focus-note">
              数据来自本机保存的专注记录（按本地日期聚合），只统计你实际记录的阶段，未做任何推算或补值。
            </p>
          </>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>最近记录</h3>
          <span className="muted">本机数据 · 最多 8 条</span>
        </div>
        {loading ? (
          <p className="loading-line">加载中…</p>
        ) : records.length === 0 ? (
          <p className="empty">暂无记录。开始一段计时后，这里会显示每个阶段的计划时长与实际时长。</p>
        ) : (
          <ul className="focus-record-list">
            {records.map((r) => {
              const kind = r.kind === "break" ? "休息" : r.kind === "focus" ? "专注" : r.kind;
              const done = r.completed === 1;
              return (
                <li key={r.id} className="focus-record-item">
                  <span className={"focus-record-kind" + (r.kind === "break" ? " is-break" : "")}>{kind}</span>
                  <span className="focus-record-time">{r.started_at || "（无开始时间）"}</span>
                  <span className="tag">
                    计划 {r.plan_min} 分钟 · 实际 {r.actual_min ?? "—"} 分钟
                  </span>
                  <span className={"tag" + (done ? "" : " tag-warn")}>
                    {done ? "已完成" : "未完成"}
                  </span>
                  {r.ended_at ? null : <span className="tag tag-warn">没有结束时间</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card focus-honest">
        <h3>这一页的边界（如实说明）</h3>
        <ul className="focus-honest-list">
          <li>
            <b>本页只做计时与记录，不改动任何模型。</b>
            它不生成内容、不训练模型、不调整任何参数，也不会"越用越聪明"。
          </li>
          <li>
            系统通知与记录<b>只在桌面版可用</b>；网页预览下计时仍然准，但不会保存，通知也不会发出
            （界面上会如实标注）。
          </li>
          <li>统计数字全部来自本机保存的真实记录；没有记录就显示「暂无记录」，不做任何估算或补值。</li>
          <li>面向课后理解与复习，不面向考试场景；专注时长的记录只是自我管理工具，不代表学习效果。</li>
        </ul>
      </section>
    </div>
  );
}
