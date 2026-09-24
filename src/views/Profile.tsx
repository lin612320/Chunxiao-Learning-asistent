// 学习画像页（M4 契约 docs/10-M4契约.md §3.2 / §一 口径红线）。
//
// 本页只做一件事：把**本机作答记录**统计出来的画像如实地摆出来。
//   · 掌握度是本机统计量，公式 mastery = (correct + 1) / (attempts + 2)（拉普拉斯平滑），
//     每条都**同时给出 evidence（支撑样本数）**——这是硬要求，不是可选项；
//   · 样本不足（attempts < min_evidence）的条目只显示灰态「样本不足（n 次）」，不给数字、不进弱项榜；
//   · 「你说的（自述缺漏）」与「统计的（掌握度 / 弱项）」**分区展示**，绝不混成一张榜；
//   · 页面显眼位置有诚实边界声明（契约 §一 第 3 条**原文逐字**，不改写、不放脚注）。
// 不做的事：不训练模型、不上传任何数据、不画没有数据支撑的曲线。
//
// 图表（掌握度热力图 / 条状图）全部是纯 CSS + DOM 手写，不引入任何图表库。

import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useProfile } from "../hooks/useProfile";
import { parseCourseParam } from "../lib/courseScope";
import { isTauri } from "../lib/tauri";
import {
  BAND_LABEL,
  LOCAL_ONLY_NOTE,
  MASTERY_FORMULA_NOTE,
  masteryBand,
  PREFERENCE_SCALE,
  pct,
  pctOrDash,
  PREVIEW_PROFILE_NOTE,
  scaleLabel,
  STYLE_SCALE,
  type ProfileKpStat,
  type ProfileTraitRow,
} from "../lib/profile";
import TechNote from "../components/TechNote";
import "./Profile.css";

/** 掌握度 tooltip：只说人话（答对几次、共作答几次、最近什么时候），公式不作为悬停文案 */
function masteryTip(r: ProfileKpStat): string {
  return [
    r.kp_name,
    `答对 ${r.correct} 次 / 共作答 ${r.attempts} 次`,
    `掌握度 ${pct(r.mastery)}${r.accuracy == null ? "" : `（原始正确率 ${pctOrDash(r.accuracy)}）`}`,
    `最近作答：${r.last_at ?? "—"}`,
    LOCAL_ONLY_NOTE,
  ].join("\n");
}

/** 灰态 tooltip：只说明"为什么暂时没有数字"，绝不给数字 */
function notEnoughTip(r: ProfileKpStat, minEvidence: number): string {
  return [
    r.kp_name,
    `只作答了 ${r.attempts} 次，少于 ${minEvidence} 次`,
    "作答太少就不显示掌握度、也不列入弱项 —— 免得凭一两次作答下结论。",
    LOCAL_ONLY_NOTE,
  ].join("\n");
}

/** 条状图一行：名称 + 掌握度条 + 百分比 + 样本数（缺样本数即违反红线，故写死在同一行） */
function MasteryBar({ row, onJump }: { row: ProfileKpStat; onJump: (kpId: number) => void }) {
  const band = masteryBand(row.mastery);
  const width = row.mastery == null ? 0 : Math.max(2, Math.round(row.mastery * 100));
  return (
    <div className="pf-bar-row">
      <button
        type="button"
        className="pf-bar-name"
        onClick={() => row.kp_id != null && onJump(row.kp_id)}
        disabled={row.kp_id == null}
        title={row.kp_id == null ? undefined : "查看该知识点的题目"}
      >
        {row.kp_name}
      </button>
      <div className="pf-bar-track pf-tip" data-tip={masteryTip(row)} tabIndex={0}>
        <div className={`pf-bar-fill lvl-${band}`} style={{ width: `${width}%` }} />
      </div>
      <div className="pf-bar-nums">
        <span className={`pf-mastery lvl-text-${band}`}>{pct(row.mastery)}</span>
        {/* 红线：掌握度与样本数必须同时出现 */}
        <span className="pf-evidence" title="这个知识点你在这台电脑上作答过多少次">
          样本 {row.evidence} 次
        </span>
        <span className="pf-accuracy" title="原始正确率：答对次数 ÷ 作答次数（与上面的掌握度并列展示）">
          原始正确率 {pctOrDash(row.accuracy)}
        </span>
        <span className={`pf-band lvl-${band}`}>{BAND_LABEL[band]}</span>
      </div>
    </div>
  );
}

/** 热力图一格：有结论显示百分比，样本不足显示灰态文字（无数字） */
function HeatCell({
  row,
  minEvidence,
  onJump,
}: {
  row: ProfileKpStat;
  minEvidence: number;
  onJump: (kpId: number) => void;
}) {
  const gray = row.evidence < minEvidence;
  if (gray) {
    return (
      <div className="pf-heat-cell lvl-none pf-tip" data-tip={notEnoughTip(row, minEvidence)} tabIndex={0}>
        <span className="pf-heat-pct">样本不足</span>
        <span className="pf-heat-n">作答 {row.attempts} 次</span>
        <span className="pf-heat-name">{row.kp_name}</span>
      </div>
    );
  }
  const band = masteryBand(row.mastery);
  return (
    <button
      type="button"
      className={`pf-heat-cell lvl-${band} pf-tip`}
      data-tip={masteryTip(row)}
      onClick={() => row.kp_id != null && onJump(row.kp_id)}
      disabled={row.kp_id == null}
    >
      <span className="pf-heat-pct">{pct(row.mastery)}</span>
      <span className="pf-heat-n">作答 {row.evidence} 次</span>
      <span className="pf-heat-name">{row.kp_name}</span>
    </button>
  );
}

/** 弱项一行：掌握度 + 原始正确率 + **样本数**（缺样本数即违反红线） */
function WeakRow({
  row,
  onJump,
}: {
  row: ProfileKpStat;
  onJump: (kpId: number) => void;
}) {
  const band = masteryBand(row.mastery);
  return (
    <li className="pf-weak-row">
      <div className="pf-weak-main">
        <button
          type="button"
          className="pf-weak-name"
          onClick={() => row.kp_id != null && onJump(row.kp_id)}
          disabled={row.kp_id == null}
          title={row.kp_id == null ? undefined : "去题库看这个知识点的题"}
        >
          {row.kp_name}
        </button>
        <span className="pf-weak-tags">
          <span className={`pf-mastery lvl-text-${band}`}>{pct(row.mastery)}</span>
          <span className={`pf-band lvl-${band}`}>{BAND_LABEL[band]}</span>
          <span className="pf-evidence">样本 {row.evidence} 次</span>
          <span className="pf-accuracy">原始正确率 {pctOrDash(row.accuracy)}</span>
        </span>
      </div>
      <div className="pf-weak-tip pf-tip" data-tip={masteryTip(row)} tabIndex={0}>
        说明
      </div>
    </li>
  );
}

/** 自述缺漏一条（"你说的"，不是统计结论） */
function DeclaredRow({ row, kpName }: { row: ProfileTraitRow; kpName: (id: number | null) => string }) {
  const cancelled = (row.value ?? 1) <= 0;
  return (
    <li className={`pf-declared-row${cancelled ? " cancelled" : ""}`}>
      <span className="pf-declared-name">{kpName(row.kp_id)}</span>
      <span className="pf-declared-meta">
        {cancelled ? "已取消标记" : "我自述薄弱"}
        <span className="pf-declared-src"> · 你自述的（不产生统计样本）</span>
        {row.updated_at ? <span className="pf-declared-time"> · {row.updated_at}</span> : null}
      </span>
    </li>
  );
}

export default function Profile() {
  // R9：URL 的 `?course=N` 就是本页的统计范围（侧栏/顶栏切课程立刻跟着切）
  const { search } = useLocation();
  const lockedCourseId = parseCourseParam(search);
  const {
    courses,
    coursesLoading,
    courseId,
    setCourseId,
    overview,
    loading,
    loadFailed,
    isEmpty,
    minEvidence,
    conclusions,
    weakPoints,
    insufficient,
    declaredGaps,
    preferences,
    knowledgePoints,
    error,
    setError,
    saving,
    refresh,
    saveTrait,
    markDeclared,
    addDeclaredGap,
  } = useProfile(lockedCourseId);

  const navigate = useNavigate();
  const preview = !isTauri();

  const [newKpName, setNewKpName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const courseName = courses.find((c) => c.id === courseId)?.name ?? "";

  const kpNames = useMemo(() => {
    const m = new Map<number, string>();
    for (const k of knowledgePoints) m.set(k.id, k.name);
    return m;
  }, [knowledgePoints]);

  const nameOfKp = (id: number | null): string =>
    id == null ? "（未挂到具体知识点）" : kpNames.get(id) ?? `知识点 #${id}`;

  /** 已勾选的「我薄弱」（自述；value > 0 视为生效） */
  const markedIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of declaredGaps) {
      if (r.trait !== "weakness_self") continue;
      if (r.kp_id == null) continue;
      if ((r.value ?? 1) > 0) s.add(r.kp_id);
    }
    return s;
  }, [declaredGaps]);

  const currentPreference = preferences.find((r) => r.trait === "preference")?.value ?? null;
  const currentStyle = preferences.find((r) => r.trait === "style")?.value ?? null;

  /** 点击知识点 → 去题库看它的题（`kpId` 为页内查询参数约定，契约未冻结，见交付报告） */
  const jumpToQuestions = (kpId: number) => {
    navigate(`/questions?kpId=${kpId}`);
  };

  const onToggleDeclared = async (kpId: number, checked: boolean) => {
    setNotice(null);
    const ok = await markDeclared(kpId, checked);
    if (ok) {
      setNotice(
        checked
          ? `已在本机记为「我薄弱」：${nameOfKp(kpId)}（这是你的自述，不是统计结论）`
          : `已取消自述标记：${nameOfKp(kpId)}`,
      );
    }
  };

  const onAddGap = async () => {
    setNotice(null);
    const name = newKpName.trim();
    const ok = await addDeclaredGap(name);
    if (ok) {
      setNotice(`已录入并标记为「我薄弱」：${name}（本机知识点 + 自述标记，均不出本机）`);
      setNewKpName("");
    }
  };

  const onScale = async (trait: "preference" | "style", value: number) => {
    setNotice(null);
    const ok = await saveTrait({ kpId: null, trait, value, evidence: null });
    if (ok) {
      setNotice(`已保存${trait === "preference" ? "偏好" : "风格"}：${scaleLabel(trait, value)}`);
    }
  };

  // ---------------------------------------------------------------------------

  return (
    <div className="page-stack profile-page">
      {/* ------------------------------------------------------------------
          本机说明（R3）：**主界面只讲大白话**，公式与实现细节收进下面的「说明」折叠区。
          ⚠ 诚实边界没有被删掉：契约 §一 的原文（含「不是强化学习」）**逐字保留**在折叠区里，
            质量闸门第 7 步会先展开折叠区、再逐字校验（见 scripts/smoke-ui.mjs）。
          ------------------------------------------------------------------ */}
      <section className="pf-honest" aria-label="数据与本机说明">
        <span className="pf-honest-tag">关于这些数字</span>
        <p className="pf-honest-main">
          <strong>下面的掌握度与弱项，只来自你在这台电脑上的作答记录。</strong>
        </p>
        <p className="pf-honest-sub">
          它们用来调整复习顺序与讲解详略。{LOCAL_ONLY_NOTE}
        </p>
        <TechNote title="掌握度是怎么算出来的？">
          <ul>
            <li>
              {MASTERY_FORMULA_NOTE}作答少于 {minEvidence} 次的知识点只显示灰态，
              不给数字、也不进弱项榜 —— 免得凭一两次作答下结论。
            </li>
            <li>
              这里只做统计加权与提示词调整，<b>不是强化学习 —— 模型权重不会因此改变</b>。
              春晓在客户端无法训练模型，能变的只有本机的复习优先级与发给模型的提示词。
            </li>
          </ul>
        </TechNote>
      </section>

      {preview ? <div className="demo-banner">{PREVIEW_PROFILE_NOTE}</div> : null}

      {/* ------------------------------------------------------------------
          课程选择：画像按课程统计
          ------------------------------------------------------------------ */}
      <section className="card pf-toolbar">
        <div className="pf-toolbar-left">
          {/* R9：有课程上下文时不显示选择器（范围由侧栏 + 顶栏负责，避免三处重复、也避免"写着 A 课查 B 课"） */}
          {lockedCourseId == null ? (
            <label className="pf-field">
              <span className="pf-field-label">统计范围</span>
              <select
                value={courseId ?? ""}
                disabled={coursesLoading || courses.length === 0}
                onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : null)}
              >
                {courses.length === 0 ? <option value="">（本机还没有课程）</option> : null}
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.archived === 1 ? "（已归档）" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {courseName ? <span className="pf-toolbar-note">当前课程：{courseName}</span> : null}
        </div>
        <button type="button" className="ghost-btn" onClick={() => void refresh()} disabled={loading || courseId == null}>
          {loading ? "读取中…" : "刷新本机统计"}
        </button>
      </section>

      {notice ? (
        <div className="settings-msg ok" onClick={() => setNotice(null)} role="status">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="settings-msg err" onClick={() => setError(null)} role="alert">
          {error}
          {preview ? "（浏览器预览模式不能保存，改动请到桌面版操作）" : ""}
          <span className="pf-msg-hint">（点击这行可关闭）</span>
        </div>
      ) : null}

      {loadFailed ? (
        <section className="card">
          <h3>暂时读不到画像数据</h3>
          <p className="muted">
            这是一次<strong>读取失败</strong>，不是「你还没有作答记录」——多半是本机数据文件被占用，
            或桌面端功能未就绪。这里<b>不会</b>拿示例数据顶上。
          </p>
          <button type="button" className="ghost-btn" onClick={() => void refresh()}>
            重试
          </button>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------
          1) 掌握度视图（统计的）
          ------------------------------------------------------------------ */}
      <section className="card pf-block">
        <div className="section-head">
          <h2>掌握度 · 本机统计</h2>
        </div>

        {courseId == null ? (
          <p className="empty">暂无课程。</p>
        ) : loading && !overview ? (
          <p className="loading-line">读取中…</p>
        ) : isEmpty ? (
          <p className="empty">暂无记录。</p>
        ) : (
          <>
            {conclusions.length + insufficient.length > 0 ? (
              <div className="pf-heat">
                {[...conclusions].sort((a, b) => (b.mastery ?? 0) - (a.mastery ?? 0)).map((r) => (
                  <HeatCell
                    key={r.kp_id != null ? `kp-${r.kp_id}` : `n-${r.kp_name}`}
                    row={r}
                    minEvidence={minEvidence}
                    onJump={jumpToQuestions}
                  />
                ))}
                {insufficient.map((r) => (
                  <HeatCell
                    key={r.kp_id != null ? `kp-${r.kp_id}` : `n-${r.kp_name}`}
                    row={r}
                    minEvidence={minEvidence}
                    onJump={jumpToQuestions}
                  />
                ))}
              </div>
            ) : null}

            {conclusions.length > 0 ? (
              <div className="pf-bars">
                {[...conclusions].sort((a, b) => (b.mastery ?? 0) - (a.mastery ?? 0)).map((r) => (
                  <MasteryBar key={r.kp_id != null ? `kp-${r.kp_id}` : `n-${r.kp_name}`} row={r} onJump={jumpToQuestions} />
                ))}
              </div>
            ) : null}

            {insufficient.length > 0 ? (
              <div className="pf-gray">
                <h4 className="pf-sub-title">样本不足 · 不给结论（{insufficient.length} 条）</h4>
                <ul className="pf-gray-list">
                  {insufficient.map((r) => (
                    <li
                      key={r.kp_id != null ? `kp-${r.kp_id}` : `n-${r.kp_name}`}
                      className="pf-gray-row pf-tip"
                      data-tip={notEnoughTip(r, minEvidence)}
                      tabIndex={0}
                    >
                      <span className="pf-gray-name">{r.kp_name}</span>
                      <span className="pf-gray-label">
                        {r.attempts === 0
                          ? "样本不足（0 次，还没有作答记录）"
                          : `样本不足（${r.attempts} 次）`}
                      </span>
                      <span className="pf-gray-note">作答太少，暂不显示掌握度</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {conclusions.length === 0 && insufficient.length === 0 ? (
              <p className="empty">暂无记录。</p>
            ) : null}
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------
          2) 弱项榜（统计的；每条必带样本数）
          ------------------------------------------------------------------ */}
      <section className="card pf-block">
        <div className="section-head">
          <h2>弱项 · 本机统计</h2>
        </div>
        {weakPoints.length === 0 ? (
          <p className="empty">暂无弱项。</p>
        ) : (
          <ul className="pf-weak-list">
            {weakPoints.map((r) => (
              <WeakRow key={r.kp_id != null ? `kp-${r.kp_id}` : `n-${r.kp_name}`} row={r} onJump={jumpToQuestions} />
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------------
          3) 你说的：自述缺漏（与统计结论分区，不混淆）
          ------------------------------------------------------------------ */}
      <section className="card pf-block pf-declared-block">
        <div className="section-head">
          <h2>你说的 · 自述缺漏</h2>
        </div>

        {declaredGaps.length > 0 ? (
          <ul className="pf-declared-list">
            {declaredGaps.map((r, i) => (
              <DeclaredRow key={r.id ?? `t-${i}`} row={r} kpName={nameOfKp} />
            ))}
          </ul>
        ) : (
          <p className="muted">还没有自述缺漏：下面勾选或录入，就会出现在这里。</p>
        )}

        <h4 className="pf-sub-title">勾选「我哪里薄弱」</h4>
        {knowledgePoints.length === 0 ? (
          <p className="muted">这门课还没有知识点：可以在下面直接录入一个。</p>
        ) : (
          <div className="pf-check-grid">
            {knowledgePoints.map((k) => (
              <label key={k.id} className={`pf-check${markedIds.has(k.id) ? " checked" : ""}`}>
                <input
                  type="checkbox"
                  checked={markedIds.has(k.id)}
                  disabled={saving}
                  onChange={(e) => void onToggleDeclared(k.id, e.target.checked)}
                />
                <span className="pf-check-name">{k.name}</span>
                <span className="pf-check-meta">作答 {k.attempts} 次</span>
              </label>
            ))}
          </div>
        )}

        <div className="pf-add-row">
          <input
            type="text"
            value={newKpName}
            placeholder="列表里没有？直接录入一个薄弱知识点名称"
            onChange={(e) => setNewKpName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAddGap();
            }}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void onAddGap()}
            disabled={saving || !newKpName.trim()}
          >
            录入并标记
          </button>
        </div>
        <p className="pf-foot-note">
          取消勾选只是把这条自述标为「已取消」：记录仍留在本机，不再计入弱项，也不会外传。
        </p>
      </section>

      {/* ------------------------------------------------------------------
          4) 偏好与风格（本机录入）
          ------------------------------------------------------------------ */}
      <section className="card pf-block">
        <div className="section-head">
          <h2>偏好与风格 · 本机录入</h2>
        </div>

        <div className="pf-pref-grid">
          <label className="pf-field">
            <span className="pf-field-label">解释粒度（偏好）</span>
            <select
              value={currentPreference == null ? "" : String(currentPreference)}
              disabled={saving || courseId == null}
              onChange={(e) => e.target.value && void onScale("preference", Number(e.target.value))}
            >
              <option value="">未设置</option>
              {PREFERENCE_SCALE.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="pf-field">
            <span className="pf-field-label">讲解顺序（风格）</span>
            <select
              value={currentStyle == null ? "" : String(currentStyle)}
              disabled={saving || courseId == null}
              onChange={(e) => e.target.value && void onScale("style", Number(e.target.value))}
            >
              <option value="">未设置</option>
              {STYLE_SCALE.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {preferences.length > 0 ? (
          <ul className="pf-pref-list">
            {preferences.map((r, i) => (
              <li key={r.id ?? `p-${i}`}>
                <span className="pf-pref-trait">{r.trait === "style" ? "风格" : r.trait === "preference" ? "偏好" : r.trait}</span>
                <span className="pf-pref-value">{scaleLabel(r.trait, r.value)}</span>
                {r.kp_id != null ? <span className="pf-pref-kp">{nameOfKp(r.kp_id)}</span> : null}
                {r.updated_at ? <span className="pf-pref-time">{r.updated_at}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">还没有偏好 / 风格记录；本机存了几条就列几条。</p>
        )}
      </section>
    </div>
  );
}
