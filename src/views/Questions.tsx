// M4 · 题库页（契约 `docs/10-M4契约.md` §3.1 / §一 口径红线）。
//
// 五件事（契约 §3.1 逐条落地）：
//   ① 知识点同步：`knowledge_points_sync_from_prior` → `{created,total}` **如实提示**（幂等）；
//   ② 生成题目：选课程 + 知识点（多选）+ 数量 → 收集该知识点的**先验知识摘要**（`loadPriorList`）
//      与**材料段落**（`materialSearch`）→ 调模型（提示词见 `lib/questions.ts`，要求严格 JSON 数组）
//      → **解析容错** → **可勾选可编辑预览** → 点「确认保存」才 `questions_save_batch(source='ai')`。
//      ⚠ 未配 Key 时按钮禁用并引导去「数据设置」；**绝不用模板假造题目冒充 AI 生成**；
//      解析失败给可读中文错误并保留原始输出。
//   ③ 列表与筛选：按知识点 / 题型 / 是否标记有问题筛选；每题可编辑题干·选项·答案·解析·难度
//      （`question_update`）、标记「题目有问题」（`flawed`）、删除（`question_delete`）。
//   ④ 练习模式：`practice_pick` 取题 → 逐题作答 → 客观题（choice/blank）**本地判分，不调模型**
//      → `attempt_record`；主观题（short/essay）先看参考答案再**自评** → `attempt_record`；
//      记录 `durationMs` 与 `confidence`。
//   ⑤ 错题本：`attempts_list(onlyWrong: true)`；可「重练错题」（喂回练习模式）。
//
// 口径红线（契约 §一，验收项，逐条落实在渲染结果里）：
//   · 掌握度是**统计量**：只显示由作答算出的加权准确率，且**每条同时显示样本数（evidence）**；
//   · 样本不足（attempts < 3）只显示灰态「样本不足（n 次）」，**不给数字、不进任何榜单**；
//   · AI 生成的题**不自动保存**：预览 → 可编辑 → 确认才保存，`source='ai'`；题目/答案**可人工校正**；
//   · 无数据时如实显示「暂无记录 / 样本不足」，不造数据、不画假曲线；
//   · 文案一律用「本机统计」；禁止「智能体自我进化 / 越用越聪明 / 模型在学习」这类表述；
//   · 诚实边界写清：客户端**无法训练模型**，作答只影响本机选题顺序与解释粒度。
//
// 依赖边界：本页**只**通过 `lib/questions.ts` 与 `hooks/useQuestions.ts` 暴露的能力访问数据，
// 不在页面里直接 `invokeStrict`（否则"读失败"会被界面谎报成"暂无记录"）。
// 只新建本文件与 `Questions.css`，不改任何既有文件；图表/进度全部纯 CSS/DOM 手写，无图表库。

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useCourses } from "../hooks/useCourses";
import { useSettings } from "../hooks/useSettings";
import {
  QUESTIONS_LIST_LIMIT,
  loadPriorList,
  loadQuestionFull,
  loadQuestionsByIds,
  pickPracticeQuestions,
  recordAttempt,
  useAttemptList,
  useKnowledgePoints,
  useQuestionList,
} from "../hooks/useQuestions";
import { materialSearch } from "../lib/materials";
// R9：课程上下文口径与笔记页/对话页**同源**（`?course=N` 优先，见 lib/courseScope.ts）
import { parseCourseParam } from "../lib/courseScope";
import { isTauri } from "../lib/tauri";
import {
  QUESTIONS_MAX_COUNT,
  QUESTIONS_MAX_SNIPPETS,
  QUESTION_SOURCE_AI,
  QUESTION_SOURCE_REF_AI,
  QTYPES,
  answerDisplay,
  bit,
  fmtDuration,
  generateQuestions,
  isObjective,
  judgeObjective,
  masteryOf,
  optionsFromText,
  parseOptions,
  qtypeLabel,
  serializeOptions,
  type AttemptRecordInput,
  type QType,
  type QuestionDraft,
  type QuestionMaterialHint,
  type QuestionSaveInput,
} from "../lib/questions";
import type { KnowledgePointItem, QuestionItem } from "../data/sample";
import Icon from "../components/Icon";
import TechNote from "../components/TechNote";
import "./Questions.css";

// ---------------------------------------------------------------------------
// 口径常量（契约 §2.4 / §一）
// ---------------------------------------------------------------------------

/** `min_evidence = 3`：attempts < 3 的条目只显示灰态「样本不足」，不给掌握度数字 */
const MIN_EVIDENCE = 3;

/** 掌握度公式说明（与契约 §2.4 逐字一致；写进界面与 tooltip，避免两处措辞不一致） */
const MASTERY_FORMULA_NOTE =
  "mastery = (correct + 1) / (attempts + 2)：拉普拉斯平滑，避免 0/0 与 1/1 的极端；evidence = attempts（支撑样本数）。";

const LOCAL_ONLY_NOTE = "数据只在本机；不参与任何模型训练。";

type Tab = "kp" | "gen" | "list" | "practice" | "wrong";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 长文本单行摘要（列表里用，不改变原文） */
function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------------------
// 出题草稿行（在 `QuestionDraft` 上加勾选状态与所属知识点）
// ---------------------------------------------------------------------------

interface DraftRow extends QuestionDraft {
  key: string;
  checked: boolean;
  /** 人工校正用：模型给的 `kp_name` 匹配不上时可以让用户指定 */
  kpId: number | null;
}

// ---------------------------------------------------------------------------
// 练习状态机
// ---------------------------------------------------------------------------

interface PracticeState {
  items: QuestionItem[];
  index: number;
  answer: string;
  confidence: number | null;
  startedAt: number;
  /** 已提交（客观题已本机判分；主观题已展示参考答案、等待自评） */
  submitted: boolean;
  /** 提交那一刻冻结的用时（毫秒），保证写库的值与界面显示一致 */
  frozenMs: number | null;
  /** 客观题本机判分结果；主观题为 null */
  correct: boolean | null;
  /** 主观题自评：1 = 答上来了，0 = 没答上来；未自评为 null */
  selfEval: number | null;
  recorded: boolean;
  recordErr: string | null;
  results: Array<{ questionId: number; correct: boolean | null }>;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// 知识点一行：名称 + **本机统计**（掌握度与样本数必须同时出现）
// ---------------------------------------------------------------------------

function KpRow({
  kp,
  checked,
  active,
  onToggle,
  onFilter,
}: {
  kp: KnowledgePointItem;
  checked: boolean;
  active: boolean;
  onToggle: (id: number, checked: boolean) => void;
  onFilter: (id: number) => void;
}) {
  const attempts = kp.attempts ?? 0;
  const correct = kp.correct ?? 0;
  const enough = attempts >= MIN_EVIDENCE;
  // 只有样本足够才给数字；样本不足时 mastery 根本不算，避免"顺手显示一下"
  const mastery = enough ? masteryOf(attempts, correct) : null;
  const tip = enough
    ? [
        kp.name,
        `答对 ${correct} 次 / 共作答 ${attempts} 次`,
        `掌握度 ${Math.round((mastery ?? 0) * 100)}%（按作答记录算出的统计值）`,
        LOCAL_ONLY_NOTE,
      ].join("\n")
    : [
        kp.name,
        `只作答 ${attempts} 次（少于 ${MIN_EVIDENCE} 次）：作答太少就不给掌握度数字、也不进任何榜单。`,
        LOCAL_ONLY_NOTE,
      ].join("\n");

  return (
    <li className={`qs-kp${active ? " active" : ""}${enough ? "" : " thin"}`}>
      <label className="qs-kp-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(kp.id, e.target.checked)}
          title="勾选后参与「生成题目」"
        />
        <span className="qs-kp-name">{kp.name}</span>
      </label>

      <div className="qs-kp-stats">
        <span className="tag">题 {kp.question_count ?? 0} 道</span>
        <span className="tag" title="本机作答记录统计（不是模型结论）">
          本机统计：作答 {attempts} 次 / 答对 {correct} 次
        </span>
        {enough ? (
          <span className="qs-mastery qs-tip" data-tip={tip} tabIndex={0}>
            掌握度 {Math.round((mastery ?? 0) * 100)}%
            <span className="qs-evidence">样本 {attempts} 次</span>
          </span>
        ) : (
          /* 灰态：样本不足 → 不给数字，只说明原因 */
          <span className="qs-notenough qs-tip" data-tip={tip} tabIndex={0}>
            样本不足（{attempts} 次）· 作答太少，暂不给掌握度数字
          </span>
        )}
      </div>

      <div className="qs-kp-actions">
        <button type="button" className="ghost-btn" onClick={() => onFilter(kp.id)}>
          看这些题
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function Questions() {
  const { courses, loading: coursesLoading } = useCourses();
  const { s, hasKey } = useSettings();
  const [sp] = useSearchParams();
  const { search } = useLocation();

  // —— 课程（页面级唯一选择：知识点 / 题目 / 练习 / 错题本都按它取数）——
  // R9：**`?course=N` 优先**（与笔记页同一套）：侧栏/顶栏切课程时它们只改 URL，
  //   本页若只认自己的 state，就会出现"顶栏写着 B 课、题目还是 A 课的"（用户实测反馈）。
  const urlCourseId = parseCourseParam(search);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("kp");
  const [notice, setNotice] = useState<string | null>(null);

  const preview = !isTauri();

  useEffect(() => {
    // URL 带了课程上下文 → 本页课程跟随它（这就是"在顶部切课程，下面的功能也跟着切"）
    if (urlCourseId != null) {
      setCourseId(urlCourseId);
      return;
    }
    // 没有 URL 上下文：保持页面自己的选择；一次都没选过才兜底到第一门未归档课程
    if (courseId != null || courses.length === 0) return;
    const active = courses.find((c) => !c.archived) ?? courses[0];
    setCourseId(active.id);
  }, [courses, courseId, urlCourseId]);

  // —— 知识点 ——
  const kp = useKnowledgePoints(courseId);
  const [genKpIds, setGenKpIds] = useState<number[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);

  // —— 题目列表筛选 ——
  /** 画像页跳过来时带的 `?kpId=`（页内查询参数，契约未冻结；读不到就忽略） */
  const [kpHint] = useState<number | null>(() => {
    const n = Number(sp.get("kpId"));
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  const hintApplied = useRef(false);
  const [filterKpId, setFilterKpId] = useState<number | null>(null);
  const [filterUnassigned, setFilterUnassigned] = useState(false);
  const [filterQtype, setFilterQtype] = useState<QType | null>(null);
  const [flawedOnly, setFlawedOnly] = useState(false);

  const list = useQuestionList({
    courseId,
    kpId: filterKpId,
    unassigned: filterUnassigned,
    qtype: filterQtype,
    flawedOnly,
  });

  // —— 错题本 ——
  const wrong = useAttemptList({ courseId, kpId: null, onlyWrong: true });

  // —— 生成题目 ——
  const [genCount, setGenCount] = useState(5);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [genRaw, setGenRaw] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [savingDrafts, setSavingDrafts] = useState(false);

  // —— 人工校正 ——
  const [editId, setEditId] = useState<number | null>(null);
  const [editQ, setEditQ] = useState<QuestionItem | null>(null);
  const [editForm, setEditForm] = useState<{
    stem: string;
    answer: string;
    explain: string;
    optionsText: string;
    difficulty: number | null;
  } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  // —— 练习 ——
  const [practiceKpId, setPracticeKpId] = useState<number | null>(null);
  const [practiceCount, setPracticeCount] = useState(5);
  const [pickBusy, setPickBusy] = useState(false);
  const [practiceErr, setPracticeErr] = useState<string | null>(null);
  const [practice, setPractice] = useState<PracticeState | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const startedAt = practice?.startedAt ?? null;
  const pSubmitted = practice?.submitted ?? false;
  const pFinished = practice?.finished ?? false;

  // 作答计时（纯展示；写库用的是提交那一刻的真实毫秒差）
  useEffect(() => {
    if (startedAt == null || pSubmitted || pFinished) return;
    setElapsedSec(0);
    const t = window.setInterval(() => setElapsedSec((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [startedAt, pSubmitted, pFinished]);

  // 换课程时清掉与课程绑定的临时状态（不给用户看上一门课的残留）
  useEffect(() => {
    setGenKpIds([]);
    setDrafts(null);
    setGenErr(null);
    setGenMsg(null);
    setGenRaw(null);
    setEditId(null);
    setEditQ(null);
    setEditForm(null);
    setPractice(null);
    setPracticeErr(null);
    setFilterKpId(null);
    setFilterUnassigned(false);
  }, [courseId]);

  // 画像页 `?kpId=` → 自动筛到该知识点（等知识点列表读到了再套用，只套用一次）
  useEffect(() => {
    if (hintApplied.current || kpHint == null || courseId == null) return;
    if (kp.list.some((k) => k.id === kpHint)) {
      setFilterKpId(kpHint);
      setFilterUnassigned(false);
      hintApplied.current = true;
    }
  }, [kpHint, kp.list, courseId]);

  const kpNameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const k of kp.list) m.set(k.id, k.name);
    return (id: number | null | undefined, fallback?: string | null): string => {
      if (id != null) return m.get(id) ?? fallback?.trim() ?? `知识点 #${id}`;
      return fallback?.trim() ? fallback : "未归类到知识点";
    };
  }, [kp.list]);

  const mergedError = kp.error ?? list.error ?? wrong.error;
  function clearError() {
    kp.setError(null);
    list.setError(null);
    wrong.setError(null);
  }

  const selectedKps = useMemo(
    () => kp.list.filter((k) => genKpIds.includes(k.id)),
    [kp.list, genKpIds],
  );

  // -------------------------------------------------------------------------
  // ① 从先验知识同步知识点（如实提示 created / total，幂等）
  // -------------------------------------------------------------------------

  async function handleSync() {
    if (courseId == null) {
      setNotice("请先选择课程。");
      return;
    }
    setNotice(null);
    setSyncBusy(true);
    const r = await kp.syncFromPrior();
    setSyncBusy(false);
    if (!r) return; // 失败原因已经在 kp.error 里如实展示
    setNotice(
      r.created > 0
        ? `已生成知识点清单：新增 ${r.created} 个，现在共 ${r.total} 个。`
        : `这次没有新增，现在共 ${r.total} 个知识点。`,
    );
  }

  // -------------------------------------------------------------------------
  // ② 生成题目（不写库：预览 → 可编辑 → 确认保存）
  // -------------------------------------------------------------------------

  function toggleGenKp(id: number, checked: boolean) {
    setGenKpIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  function patchDraft(key: string, patch: Partial<DraftRow>) {
    setDrafts((cur) => (cur ? cur.map((d) => (d.key === key ? { ...d, ...patch } : d)) : cur));
  }

  async function handleGenerate() {
    setNotice(null);
    setGenErr(null);
    setGenRaw(null);
    setGenMsg(null);
    setDrafts(null);

    if (courseId == null) {
      setGenErr("请先选择课程。");
      return;
    }
    if (!hasKey) {
      setGenErr(
        "尚未配置模型 API Key：请先到「数据设置」配置接口地址与 Key 再生成（本页不会用模板假造题目冒充 AI 生成）。",
      );
      return;
    }
    if (selectedKps.length === 0) {
      setGenErr("请先勾选至少一个知识点 —— 出题时知识点名称要完全对得上，得先告诉春晓给哪些知识点出题。");
      return;
    }

    const courseName = courses.find((c) => c.id === courseId)?.name ?? `课程 #${courseId}`;
    setGenBusy(true);
    const warns: string[] = [];
    try {
      // 先验知识摘要：知识点用 prior_id 关联先验知识树（未同步到先验的留空）
      const priors = await loadPriorList(courseId);
      const priorById = new Map(priors.map((p) => [p.id, p]));
      const hints = selectedKps.map((k) => {
        const p = k.prior_id != null ? priorById.get(k.prior_id) : undefined;
        return { name: k.name, summary: p?.summary ?? null, detail: p?.detail ?? null };
      });

      // 材料段落：用知识点名称检索本机已导入材料的切块（检索失败要如实说明，不静默）
      setGenMsg("正在本机检索这门课的材料段落…");
      const mats: QuestionMaterialHint[] = [];
      const seenChunks = new Set<number>();
      for (const k of selectedKps) {
        const r = await materialSearch(courseId, k.name, 3);
        if (!r.ok) {
          warns.push(`材料检索失败（${r.error}）`);
          continue;
        }
        for (const h of r.hits) {
          if (seenChunks.has(h.chunk_id)) continue;
          seenChunks.add(h.chunk_id);
          mats.push({ material: h.material, heading: h.heading ?? null, snippet: h.snippet });
          if (mats.length >= QUESTIONS_MAX_SNIPPETS) break;
        }
        if (mats.length >= QUESTIONS_MAX_SNIPPETS) break;
      }

      setGenMsg(
        `正在请模型出题…（本次输入：${hints.length} 个知识点、${mats.length} 条材料段落，共 ${genCount} 道）`,
      );
      const r = await generateQuestions(s.ai, {
        courseName,
        kps: hints,
        materials: mats,
        count: genCount,
        onProgress: (n) => setGenMsg(`正在生成…已收到 ${n} 字（超过 30 秒属正常，可稍候）`),
      });
      setGenRaw(r.raw.trim() ? r.raw : null);

      if (!r.ok) {
        setGenMsg(null);
        setGenErr(`生成失败：${r.error}`);
        return;
      }

      // 模型给的 kp_name 尽量映射回本机知识点；只有一个知识点时兜底到它
      const fallbackKp = selectedKps.length === 1 ? selectedKps[0].id : null;
      const rows: DraftRow[] = r.items.map((d, i) => ({
        ...d,
        key: `d-${i}-${d.stem.slice(0, 12)}`,
        checked: true,
        kpId: selectedKps.find((k) => k.name.trim() === d.kp_name.trim())?.id ?? fallbackKp,
      }));
      setDrafts(rows);
      setGenMsg(
        `已生成 ${rows.length} 道草稿（尚未保存）：请逐条核对/改完再点「确认保存」。` +
          (r.dropped > 0
            ? `另有 ${r.dropped} 条模型的输出因格式不合法被丢弃（缺题干/答案，或选择题选项少于 2 个）。`
            : "") +
          (warns.length > 0 ? ` ${Array.from(new Set(warns)).join("；")}。` : ""),
      );
    } catch (e) {
      setGenMsg(null);
      setGenErr(`生成失败：${errText(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  const draftChecked = drafts ? drafts.filter((d) => d.checked) : [];
  // 可保存 = 勾选 + 题干/答案非空 + 选择题至少 2 个选项（与列表上的「格式不完整」标记同一口径）
  const draftSavable = draftChecked.filter(
    (d) => d.stem.trim() && d.answer.trim() && !(d.qtype === "choice" && d.options.length < 2),
  );

  async function handleSaveDrafts() {
    if (!drafts) return;
    if (courseId == null) return;
    if (draftSavable.length === 0) {
      setGenErr("没有可保存的题：至少勾选一道「题干与参考答案都不为空」的题（选择题还要有 2 个以上选项）。");
      return;
    }
    setSavingDrafts(true);
    setGenErr(null);
    try {
      const items: QuestionSaveInput[] = draftSavable.map((d) => ({
        kpId: d.kpId,
        qtype: d.qtype,
        stem: d.stem.trim(),
        options: d.qtype === "choice" ? serializeOptions(d.options) : null,
        answer: d.answer.trim(),
        explain: d.explain.trim() ? d.explain.trim() : null,
        difficulty: d.difficulty,
        // 契约 §一.5：AI 生成的题保存必须带 source='ai'，且来源标注为「待核对」
        source: QUESTION_SOURCE_AI,
        sourceRef: QUESTION_SOURCE_REF_AI,
      }));
      const n = await list.saveBatch(items);
      setDrafts(null);
      setGenRaw(null);
      setGenMsg(null);
      setNotice(
        `已保存 ${n} 道题（来源标为「AI 生成 · 待核对」）。请在「题目列表」里逐条核对：题干/答案不对可以直接编辑，确实有问题的点「标记题目有问题」。`,
      );
      setTab("list");
    } catch (e) {
      setGenErr(`保存失败：${errText(e)}（草稿仍保留在上面，可以改完重试）`);
    } finally {
      setSavingDrafts(false);
    }
  }

  // -------------------------------------------------------------------------
  // ③ 列表：人工校正 / 标记有问题 / 删除
  // -------------------------------------------------------------------------

  async function startEdit(q: QuestionItem) {
    setEditErr(null);
    setEditBusy(true);
    try {
      // 列表接口不一定带全字段（如 options / flawed），校正前取一次全字段
      const full = await loadQuestionFull(q.id);
      setEditId(q.id);
      setEditQ(full);
      setEditForm({
        stem: full.stem ?? "",
        answer: full.answer ?? "",
        explain: full.explain ?? "",
        optionsText: parseOptions(full.options).join("\n"),
        difficulty: full.difficulty ?? null,
      });
    } catch (e) {
      setEditErr(`读取题目详情失败：${errText(e)}`);
    } finally {
      setEditBusy(false);
    }
  }

  async function saveEdit() {
    if (editId == null || !editForm || !editQ) return;
    const stem = editForm.stem.trim();
    const answer = editForm.answer.trim();
    if (!stem || !answer) {
      setEditErr("题干与参考答案都不能为空。");
      return;
    }
    const opts = optionsFromText(editForm.optionsText);
    if (editQ.qtype === "choice" && opts.length < 2) {
      setEditErr("选择题至少要 2 个选项（一行一个选项）。");
      return;
    }
    setEditBusy(true);
    setEditErr(null);
    const ok = await list.updateQuestion(editId, {
      stem,
      answer,
      explain: editForm.explain.trim() ? editForm.explain.trim() : null,
      options: editQ.qtype === "choice" ? serializeOptions(opts) : null,
      difficulty: editForm.difficulty,
    });
    setEditBusy(false);
    if (ok) {
      setEditId(null);
      setEditQ(null);
      setEditForm(null);
      setNotice("已保存人工校正（本机题库）。改的是题目本身，已有的作答记录不会因此被改写。");
    }
  }

  async function toggleFlawed(q: QuestionItem) {
    const marked = bit(q.flawed) === 1;
    const ok = await list.updateQuestion(q.id, { flawed: !marked });
    if (ok) {
      setNotice(
        marked
          ? "已取消「题目有问题」标记。"
          : "已标记「题目有问题」：这条标记只在本机记录，方便你之后用筛选找出来人工校正；题目不会被自动删除或自动重写。",
      );
    }
  }

  async function handleDelete(q: QuestionItem) {
    if (
      !window.confirm(
        `确定删除这道题吗？\n\n${clip(q.stem, 60)}\n\n它在本机的作答记录（attempts）会一起删除，删了不能撤销。`,
      )
    ) {
      return;
    }
    const ok = await list.removeQuestion(q.id);
    if (ok) setNotice("已删除这道题（含它在本题库里的作答记录）。");
  }

  // -------------------------------------------------------------------------
  // ④ 练习（客观题本机判分；主观题自评）
  // -------------------------------------------------------------------------

  async function startPractice(items?: QuestionItem[]) {
    setNotice(null);
    setPracticeErr(null);
    if (courseId == null) {
      setPracticeErr("请先选择课程。");
      return;
    }
    try {
      let rows = items;
      if (!rows) {
        setPickBusy(true);
        rows = await pickPracticeQuestions({ courseId, kpId: practiceKpId, count: practiceCount });
        setPickBusy(false);
      }
      if (rows.length === 0) {
        setPracticeErr(
          "按当前条件没有可练习的题目：先在「生成题目」里生成并确认保存，或换一个知识点 / 换个课程。",
        );
        return;
      }
      setPractice({
        items: rows,
        index: 0,
        answer: "",
        confidence: null,
        startedAt: Date.now(),
        submitted: false,
        frozenMs: null,
        correct: null,
        selfEval: null,
        recorded: false,
        recordErr: null,
        results: [],
        finished: false,
      });
      setTab("practice");
    } catch (e) {
      setPickBusy(false);
      setPracticeErr(`取题失败：${errText(e)}`);
    }
  }

  /** 写一次作答记录（失败**不静默**：留在界面上，可点「重试记录」） */
  async function persistAttempt(
    snapshot: PracticeState,
    q: QuestionItem,
    patch: { correct?: boolean | null; selfEval?: number | null },
    stamp: number,
  ) {
    const durationMs = snapshot.frozenMs ?? Math.max(0, Date.now() - snapshot.startedAt);
    const input: AttemptRecordInput = {
      questionId: q.id,
      userAnswer: snapshot.answer.trim() ? snapshot.answer.trim() : null,
      correct: patch.correct ?? null,
      selfEval: patch.selfEval ?? null,
      // Rust 侧校验：durationMs 不许为负
      durationMs: Math.max(0, Math.round(durationMs)),
      confidence: snapshot.confidence,
    };
    try {
      await recordAttempt(input);
      setPractice((cur) =>
        cur && cur.startedAt === stamp ? { ...cur, recorded: true, recordErr: null } : cur,
      );
      void wrong.reload();
    } catch (e) {
      setPractice((cur) =>
        cur && cur.startedAt === stamp ? { ...cur, recorded: false, recordErr: errText(e) } : cur,
      );
    }
  }

  function submitAnswer() {
    const p = practice;
    if (!p || p.submitted || p.finished) return;
    const q = p.items[p.index];
    if (!q) return;
    const frozenMs = Math.max(0, Date.now() - p.startedAt);
    if (isObjective(q.qtype)) {
      // 客观题：**本机判分**，不调模型、不联网
      const correct = judgeObjective({
        qtype: q.qtype,
        answer: q.answer,
        userAnswer: p.answer,
        options: parseOptions(q.options),
      });
      const next: PracticeState = { ...p, submitted: true, frozenMs, correct, selfEval: null };
      setPractice(next);
      void persistAttempt(next, q, { correct }, p.startedAt);
    } else {
      // 主观题：先展示参考答案，由用户自评后才写库
      setPractice({ ...p, submitted: true, frozenMs, correct: null, selfEval: null });
    }
  }

  function selfEvalOf(v: 0 | 1) {
    const p = practice;
    if (!p || !p.submitted || p.selfEval != null) return;
    const q = p.items[p.index];
    if (!q) return;
    const next: PracticeState = { ...p, selfEval: v };
    setPractice(next);
    void persistAttempt(next, q, { selfEval: v }, p.startedAt);
  }

  /** 只重试"写库"这一步（作答与判分结果都还在界面上，不会重判） */
  function retryRecord() {
    const p = practice;
    if (!p) return;
    const q = p.items[p.index];
    if (!q) return;
    void persistAttempt(
      p,
      q,
      isObjective(q.qtype) ? { correct: p.correct } : { selfEval: p.selfEval },
      p.startedAt,
    );
  }

  function nextQuestion() {
    const p = practice;
    if (!p) return;
    const q = p.items[p.index];
    const flag = q
      ? isObjective(q.qtype)
        ? p.correct
        : p.selfEval == null
          ? null
          : p.selfEval === 1
      : null;
    const results = q ? [...p.results, { questionId: q.id, correct: flag }] : p.results;
    if (p.index + 1 >= p.items.length) {
      setPractice({ ...p, results, finished: true });
      void wrong.reload();
      return;
    }
    setPractice({
      ...p,
      results,
      index: p.index + 1,
      answer: "",
      confidence: null,
      startedAt: Date.now(),
      submitted: false,
      frozenMs: null,
      correct: null,
      selfEval: null,
      recorded: false,
      recordErr: null,
    });
  }

  // -------------------------------------------------------------------------
  // ⑤ 错题本 → 重练
  // -------------------------------------------------------------------------

  async function repracticeWrong() {
    setNotice(null);
    const ids = Array.from(new Set(wrong.rows.map((a) => a.question_id)));
    if (ids.length === 0) {
      setNotice("错题本里还没有答错的记录，没有可重练的题。");
      return;
    }
    try {
      const { rows, missing } = await loadQuestionsByIds(courseId, ids);
      if (rows.length === 0) {
        setNotice(
          `这 ${ids.length} 道错题在本机题库里已经找不到了（可能被删除）。错题本里的历史作答记录仍在，但题目原文没了就无法重练。`,
        );
        return;
      }
      const msg =
        `已把 ${rows.length} 道错题喂给练习模式` +
        (missing > 0 ? `（另有 ${missing} 道在本机题库里已经找不到）` : "") +
        "；练习取题按「未作答优先 → 知识点掌握度升序 → id」排序。";
      // 先起练习（startPractice 会清掉旧提示），再把这条如实说明放上去
      await startPractice(rows);
      setNotice(msg);
    } catch (e) {
      setNotice(`按错题取题失败：${errText(e)}（错题本本身没受影响）`);
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const courseName = courses.find((c) => c.id === courseId)?.name ?? "";
  const currentQ = practice && !practice.finished ? practice.items[practice.index] : null;

  return (
    <div className="page-stack qs-page">
      <div className="section-head">
        <div>
          <h2 style={{ marginBottom: 4 }}>题库 · 本机统计</h2>
          <span className="muted">
            按知识点出题、练习、记录与人工校正；掌握度只由本机作答记录统计，每条都带样本数。
            面向课后理解与复习，不面向考试押题。
          </span>
        </div>
        <span className="tag">本地单机 · 数据在本机</span>
      </div>

      {preview ? (
        <div className="demo-banner">
          <span>
            现在是网页预览模式：下面显示的是<b>自带的示例数据</b>（<b>不是你的真实作答记录</b>），
            只用来试界面；这里的新增只会存到浏览器里，不会碰你这台电脑上的数据。
            桌面版读写的才是你本机的真实题目与作答。
          </span>
        </div>
      ) : null}

      {/* ---------------- 本机说明（R3：主界面只讲大白话，细节收进折叠区） ----------------
           ⚠ 诚实边界没有被删：契约 §一 的原文（含「不是强化学习」「模型权重不会因此改变」）
             逐字保留在下面的折叠区里，冒烟脚本会先展开折叠区再逐字校验。 */}
      <section className="qs-honest" aria-label="数据与本机说明">
        <span className="qs-honest-tag">关于这些数字</span>
        <p className="qs-honest-main">
          <strong>下面的掌握度与练习统计，只来自你在这台电脑上的作答记录。</strong>
        </p>
        <p className="qs-honest-sub">
          AI 生成的题目<b>不会自动保存</b>：要你先预览、改完、点「确认保存」才会存进本机题库
          （来源固定标为「AI 生成 · 待核对」）。{LOCAL_ONLY_NOTE}
        </p>
        <TechNote title="掌握度怎么算？「让春晓出题」做了什么？">
          <ul>
            <li>
              {MASTERY_FORMULA_NOTE}作答少于 {MIN_EVIDENCE} 次的知识点只显示「样本不足」，
              <b>不给数字、不进任何榜单</b>。
            </li>
            <li>
              这里只做本机统计与提示词调整，<b>不是强化学习 —— 模型权重不会因此改变</b>。
              客户端<b>无法训练模型</b>：你的作答记录只影响本机的选题顺序与解释粒度。
            </li>
            <li>题干 / 选项 / 答案 / 解析随时可以人工校正，也可以标记「题目有问题」。</li>
          </ul>
        </TechNote>
      </section>

      {notice ? (
        <div className="settings-msg ok" role="status" onClick={() => setNotice(null)}>
          {notice}
          <span className="qs-msg-hint">（点击这行可关闭）</span>
        </div>
      ) : null}

      {mergedError ? (
        <div className="settings-msg err" role="alert" onClick={clearError}>
          {mergedError}
          <span className="qs-msg-hint">（点击这行可关闭）</span>
        </div>
      ) : null}

      {/* ---------------- 工具条：课程 + 从先验知识同步知识点 ---------------- */}
      <section className="card qs-toolbar">
        <div className="qs-toolbar-left">
          {/* R9：有课程上下文时**不显示课程选择器**（与笔记页同口径）——
              当前范围由侧栏选择器 + 顶栏课程胶囊负责，页内再放一个就是三处重复。 */}
          {urlCourseId == null ? (
            <label className="qs-field">
              <span className="qs-field-label">课程</span>
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
          {courseName ? <span className="qs-toolbar-note">当前课程：{courseName}</span> : null}
        </div>
        <div className="qs-toolbar-right">
          <button
            type="button"
            className="primary small"
            disabled={courseId == null || syncBusy}
            onClick={() => void handleSync()}
          >
            {syncBusy ? "生成中…" : "生成知识点清单"}
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled={list.loading || courseId == null}
            onClick={() => {
              void kp.reload();
              void list.reload();
              void wrong.reload();
            }}
          >
            {list.loading ? "读取中…" : "刷新本机数据"}
          </button>
        </div>
      </section>

      {/* ---------------- 标签页 ---------------- */}
      <div className="tab-bar">
        <button className={"tab" + (tab === "kp" ? " active" : "")} onClick={() => setTab("kp")}>
          知识点与统计（{kp.list.length}）
        </button>
        <button className={"tab" + (tab === "gen" ? " active" : "")} onClick={() => setTab("gen")}>
          生成题目
        </button>
        <button className={"tab" + (tab === "list" ? " active" : "")} onClick={() => setTab("list")}>
          题目列表（{list.rows.length}）
        </button>
        <button className={"tab" + (tab === "practice" ? " active" : "")} onClick={() => setTab("practice")}>
          练习
        </button>
        <button className={"tab" + (tab === "wrong" ? " active" : "")} onClick={() => setTab("wrong")}>
          错题本（{wrong.rows.length}）
        </button>
      </div>

      {/* =====================================================================
          ① 知识点与本机统计
          ===================================================================== */}
      {tab === "kp" ? (
        <section className="card qs-block">
          <div className="section-head">
            <h3>知识点 · 本机统计</h3>
          </div>

          {courseId == null ? (
            <p className="empty">暂无课程。</p>
          ) : kp.loading ? (
            <p className="loading-line">正在读取本机知识点…</p>
          ) : kp.list.length === 0 ? (
            <p className="empty">这门课还没有知识点。</p>
          ) : (
            <>
              <div className="qs-kp-bar">
                <span className="muted">
                  已勾选 <b>{genKpIds.length}</b> 个知识点参与出题
                </span>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setGenKpIds(kp.list.map((k) => k.id))}
                >
                  全选
                </button>
                <button type="button" className="ghost-btn" onClick={() => setGenKpIds([])}>
                  清空勾选
                </button>
                <button type="button" className="primary small" onClick={() => setTab("gen")}>
                  去生成题目 →
                </button>
              </div>

              <ul className="qs-kp-list">
                {kp.list.map((k) => (
                  <KpRow
                    key={k.id}
                    kp={k}
                    checked={genKpIds.includes(k.id)}
                    active={!filterUnassigned && filterKpId === k.id}
                    onToggle={toggleGenKp}
                    onFilter={(id) => {
                      setFilterKpId(id);
                      setFilterUnassigned(false);
                      setTab("list");
                    }}
                  />
                ))}
              </ul>
              <p className="qs-foot-note">
                表里的「题 N 道 / 作答 N 次 / 答对 N 次」全部来自本机数据统计；
                掌握度只在样本足够（≥ {MIN_EVIDENCE} 次）时给出数字，且与本机样本数并存展示。
              </p>
            </>
          )}
        </section>
      ) : null}

      {/* =====================================================================
          ② 生成题目（预览 → 可编辑 → 确认保存）
          ===================================================================== */}
      {tab === "gen" ? (
        <section className="card qs-block">
          <div className="section-head">
            <h3>生成题目（AI 生成 · 必须先预览再保存）</h3>
            <span className="src-badge src-ai">AI 生成 · 待核对</span>
          </div>
          <div className="qs-gen-bar">
            <span className="qs-gen-label">已选知识点（{selectedKps.length}）</span>
            <div className="qs-gen-kps">
              {kp.list.length === 0 ? (
                <span className="muted">这门课还没有知识点。</span>
              ) : (
                kp.list.map((k) => {
                  const checked = genKpIds.includes(k.id);
                  return (
                    <label key={k.id} className={`qs-check${checked ? " checked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleGenKp(k.id, e.target.checked)}
                      />
                      <span>{k.name}</span>
                    </label>
                  );
                })
              )}
            </div>

            <label className="qs-field">
              <span className="qs-field-label">数量</span>
              <input
                type="number"
                min={1}
                max={QUESTIONS_MAX_COUNT}
                value={genCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setGenCount(Number.isFinite(n) ? Math.max(1, Math.min(QUESTIONS_MAX_COUNT, Math.round(n))) : 1);
                }}
              />
              <span className="qs-field-label">道（单次上限 {QUESTIONS_MAX_COUNT}）</span>
            </label>

            <button
              type="button"
              className="primary small"
              disabled={!hasKey || genBusy || savingDrafts || courseId == null || genKpIds.length === 0}
              title={
                hasKey
                  ? "按选中的知识点生成题目草稿；生成结果不会自动保存"
                  : "未配置模型 API Key，无法调用模型出题"
              }
              onClick={() => void handleGenerate()}
            >
              {genBusy ? (
                "生成中…"
              ) : (
                <>
                  <Icon name="sparkles" />
                  生成题目（AI）
                </>
              )}
            </button>

            {!hasKey ? (
              <Link to="/settings" className="ghost-btn" style={{ textDecoration: "none" }}>
                去「数据设置」配置 →
              </Link>
            ) : null}
          </div>

          {genMsg ? <div className="qs-gen-msg">{genMsg}</div> : null}
          {genErr ? (
            <div className="settings-msg err" role="alert" onClick={() => setGenErr(null)}>
              {genErr}
              <span className="qs-msg-hint">（点击这行可关闭）</span>
            </div>
          ) : null}

          {genRaw ? (
            <details className="qs-raw">
              <summary>查看模型的原始输出（还没核对；出问题的时候用来看）</summary>
              <pre>{genRaw}</pre>
            </details>
          ) : null}

          {drafts ? (
            <div className="qs-drafts">
              <div className="qs-drafts-head">
                <b>生成结果预览（尚未保存）</b>
                <span className="src-badge src-ai">AI 生成 · 待核对</span>
                <span className="muted">
                  共 {drafts.length} 道 · 已勾选 {draftChecked.length} 道 · 可保存 {draftSavable.length} 道
                </span>
                <button type="button" className="ghost-btn" onClick={() => setDrafts(drafts.map((d) => ({ ...d, checked: true })))}>
                  全选
                </button>
                <button type="button" className="ghost-btn" onClick={() => setDrafts(drafts.map((d) => ({ ...d, checked: false })))}>
                  全不选
                </button>
              </div>
              <p className="muted qs-drafts-tip">
                先核对再保存：题干 / 选项 / 答案 / 解析 / 难度 / 所属知识点都能直接改。
                标「待核对」的意思是模型自己也可能出错 —— 校验不过关的（题干或答案为空、选择题少于 2 个选项）
                不会被保存。
              </p>

              <ul className="qs-draft-list">
                {drafts.map((d) => {
                  const bad = !d.stem.trim() || !d.answer.trim() || (d.qtype === "choice" && d.options.length < 2);
                  return (
                    <li key={d.key} className={`qs-draft-item${d.checked ? "" : " off"}${bad ? " bad" : ""}`}>
                      <label className="qs-draft-check">
                        <input
                          type="checkbox"
                          checked={d.checked}
                          onChange={(e) => patchDraft(d.key, { checked: e.target.checked })}
                        />
                      </label>
                      <div className="qs-draft-body">
                        <div className="qs-draft-meta">
                          <span className="tag">{qtypeLabel(d.qtype)}</span>
                          <span className="tag">难度 {d.difficulty}</span>
                          {d.kp_name ? <span className="tag">模型给的：{d.kp_name}</span> : <span className="tag tag-warn">模型没给知识点名</span>}
                          {bad ? <span className="tag tag-danger">格式不完整，不会保存</span> : null}
                        </div>

                        <label className="qs-field">
                          <span className="qs-field-label">所属知识点</span>
                          <select
                            value={d.kpId ?? ""}
                            onChange={(e) => patchDraft(d.key, { kpId: e.target.value ? Number(e.target.value) : null })}
                          >
                            <option value="">（不归类）</option>
                            {kp.list.map((k) => (
                              <option key={k.id} value={k.id}>
                                {k.name}
                              </option>
                            ))}
                          </select>
                        </label>

                        <textarea
                          className="qs-input"
                          rows={2}
                          value={d.stem}
                          placeholder="题干（必填）"
                          onChange={(e) => patchDraft(d.key, { stem: e.target.value })}
                        />

                        {d.qtype === "choice" ? (
                          <textarea
                            className="qs-input"
                            rows={Math.max(3, d.options.length)}
                            value={d.options.join("\n")}
                            placeholder="选项：一行一个（至少 2 个）"
                            onChange={(e) => patchDraft(d.key, { options: optionsFromText(e.target.value) })}
                          />
                        ) : null}

                        <textarea
                          className="qs-input"
                          rows={2}
                          value={d.answer}
                          placeholder="参考答案（必填）"
                          onChange={(e) => patchDraft(d.key, { answer: e.target.value })}
                        />
                        <textarea
                          className="qs-input"
                          rows={2}
                          value={d.explain}
                          placeholder="解析（选填）"
                          onChange={(e) => patchDraft(d.key, { explain: e.target.value })}
                        />

                        <label className="qs-field">
                          <span className="qs-field-label">难度</span>
                          <select
                            value={String(d.difficulty)}
                            onChange={(e) => patchDraft(d.key, { difficulty: Number(e.target.value) })}
                          >
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="qs-draft-actions">
                <button
                  type="button"
                  className="primary small"
                  disabled={savingDrafts || draftSavable.length === 0}
                  onClick={() => void handleSaveDrafts()}
                >
                  {savingDrafts ? "保存中…" : `确认保存（${draftSavable.length} 道）`}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={savingDrafts}
                  onClick={() => {
                    setDrafts(null);
                    setGenRaw(null);
                    setGenMsg(null);
                  }}
                >
                  放弃这批草稿
                </button>
                <span className="muted">保存后仍可编辑；本页不会替你判断题目对不对。</span>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* =====================================================================
          ③ 题目列表与筛选 / 人工校正
          ===================================================================== */}
      {tab === "list" ? (
        <section className="card qs-block">
          <div className="section-head">
            <h3>题目列表 · 本机题库</h3>
          </div>

          <div className="qs-filter-bar">
            <label className="qs-field">
              <span className="qs-field-label">知识点</span>
              <select
                value={filterUnassigned ? "__none__" : filterKpId == null ? "" : String(filterKpId)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__none__") {
                    setFilterUnassigned(true);
                    setFilterKpId(null);
                  } else {
                    setFilterUnassigned(false);
                    setFilterKpId(v ? Number(v) : null);
                  }
                }}
              >
                <option value="">全部知识点</option>
                <option value="__none__">未归类到知识点的题</option>
                {kp.list.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="qs-field">
              <span className="qs-field-label">题型</span>
              <select
                value={filterQtype ?? ""}
                onChange={(e) => setFilterQtype(e.target.value ? (e.target.value as QType) : null)}
              >
                <option value="">全部题型</option>
                {QTYPES.map((t) => (
                  <option key={t} value={t}>
                    {qtypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>

            <label className={`qs-check${flawedOnly ? " checked" : ""}`}>
              <input type="checkbox" checked={flawedOnly} onChange={(e) => setFlawedOnly(e.target.checked)} />
              <span>只看标记「题目有问题」</span>
            </label>

            <span className="muted qs-filter-count">
              本机读到 {list.loaded} 道，当前条件下显示 {list.rows.length} 道
            </span>
            <button type="button" className="ghost-btn" onClick={() => void list.reload()}>
              刷新
            </button>
          </div>

          {list.limitHit ? (
            <p className="qs-note">
              已达单次读取上限（{QUESTIONS_LIST_LIMIT} 道）：列表只覆盖最近读到的这些题，筛选结果也仅在这批里。
            </p>
          ) : null}
          {list.flawedFieldMissing ? (
            <p className="qs-note">
              读取到的题目里缺少「是否有问题」这个标记，所以「只看标记有问题」这条筛选在这次读取中不可用（不猜、也不补默认值）。
            </p>
          ) : null}

          {editErr ? (
            <div className="settings-msg err" role="alert" onClick={() => setEditErr(null)}>
              {editErr}
              <span className="qs-msg-hint">（点击这行可关闭）</span>
            </div>
          ) : null}

          {courseId == null ? (
            <p className="empty">暂无课程。</p>
          ) : list.loading ? (
            <p className="loading-line">正在读取本机题库…</p>
          ) : list.rows.length === 0 ? (
            <p className="empty">暂无记录：当前条件下没有题目。</p>
          ) : (
            <ul className="qs-q-list">
              {list.rows.map((q) => {
                const options = parseOptions(q.options);
                const attempts = q.attempts ?? 0;
                const last = bit(q.last_correct);
                const flawed = bit(q.flawed) === 1;
                return (
                  <li key={q.id} className={`qs-q-item${flawed ? " flawed" : ""}`}>
                    <div className="qs-q-head">
                      <span className="tag">{qtypeLabel(q.qtype)}</span>
                      <span className="tag" title="本机题库里这条题所属的知识点">
                        {kpNameOf(q.kp_id, q.kp_name)}
                      </span>
                      <span className="tag" title="本机统计：该题被作答的次数与最近一次是否答对">
                        本机统计：作答 {attempts} 次 · 最近 {last == null ? "—" : last === 1 ? "答对" : "答错"}
                      </span>
                      {q.difficulty != null ? <span className="tag">难度 {q.difficulty}</span> : null}
                      <span className={q.source === "ai" ? "src-badge src-ai" : "src-badge src-user"}>
                        {q.source === "ai" ? "AI 生成 · 待核对" : q.source || "自建"}
                      </span>
                      {flawed ? <span className="tag tag-danger">已标记：题目有问题</span> : null}
                    </div>

                    <div className="qs-q-stem">{q.stem}</div>

                    {options.length > 0 ? (
                      <ol className="qs-q-options">
                        {options.map((o, i) => (
                          <li key={`${q.id}-o-${i}`}>{o}</li>
                        ))}
                      </ol>
                    ) : null}

                    <details className="qs-q-detail">
                      <summary>参考答案与解析</summary>
                      <p className="qs-q-answer">
                        <b>参考答案：</b>
                        {answerDisplay(q.qtype, q.answer, options)}
                      </p>
                      {q.explain ? <p className="qs-q-explain">{q.explain}</p> : <p className="muted">（这道题没有解析）</p>}
                    </details>

                    {editId === q.id && editForm && editQ ? (
                      <div className="qs-edit">
                        <p className="muted qs-edit-tip">
                          题型不可改（本机命令只支持改题干 / 选项 / 答案 / 解析 / 难度 / 有问题标记）：
                          当前是「{qtypeLabel(editQ.qtype)}」。改动只影响本机题库，不会改动已有作答记录。
                        </p>
                        <textarea
                          className="qs-input"
                          rows={2}
                          value={editForm.stem}
                          placeholder="题干（必填）"
                          onChange={(e) => setEditForm({ ...editForm, stem: e.target.value })}
                        />
                        {editQ.qtype === "choice" ? (
                          <textarea
                            className="qs-input"
                            rows={Math.max(3, editForm.optionsText.split("\n").length)}
                            value={editForm.optionsText}
                            placeholder="选项：一行一个（至少 2 个）"
                            onChange={(e) => setEditForm({ ...editForm, optionsText: e.target.value })}
                          />
                        ) : null}
                        <textarea
                          className="qs-input"
                          rows={2}
                          value={editForm.answer}
                          placeholder="参考答案（必填）"
                          onChange={(e) => setEditForm({ ...editForm, answer: e.target.value })}
                        />
                        <textarea
                          className="qs-input"
                          rows={2}
                          value={editForm.explain}
                          placeholder="解析（选填）"
                          onChange={(e) => setEditForm({ ...editForm, explain: e.target.value })}
                        />
                        <label className="qs-field">
                          <span className="qs-field-label">难度</span>
                          <select
                            value={editForm.difficulty == null ? "" : String(editForm.difficulty)}
                            onChange={(e) =>
                              setEditForm({ ...editForm, difficulty: e.target.value ? Number(e.target.value) : null })
                            }
                          >
                            <option value="">未设置</option>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="qs-edit-actions">
                          <button type="button" className="primary small" disabled={editBusy} onClick={() => void saveEdit()}>
                            {editBusy ? "保存中…" : "保存修改"}
                          </button>
                          <button
                            type="button"
                            className="ghost-btn"
                            disabled={editBusy}
                            onClick={() => {
                              setEditId(null);
                              setEditQ(null);
                              setEditForm(null);
                              setEditErr(null);
                            }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="qs-q-actions">
                        <button type="button" className="ghost-btn" disabled={editBusy} onClick={() => void startEdit(q)}>
                          {editBusy && editId === q.id ? "读取中…" : "编辑题干 / 答案 / 解析"}
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => void toggleFlawed(q)}>
                          {flawed ? "取消「题目有问题」" : "标记题目有问题"}
                        </button>
                        <button type="button" className="danger-btn" onClick={() => void handleDelete(q)}>
                          删除
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {/* =====================================================================
          ④ 练习模式
          ===================================================================== */}
      {tab === "practice" ? (
        <section className="card qs-block">
          <div className="section-head">
            <h3>练习 · 逐题作答</h3>
          </div>

          {practiceErr ? (
            <div className="settings-msg err" role="alert" onClick={() => setPracticeErr(null)}>
              {practiceErr}
              <span className="qs-msg-hint">（点击这行可关闭）</span>
            </div>
          ) : null}

          <div className="qs-practice-bar">
            <label className="qs-field">
              <span className="qs-field-label">知识点</span>
              <select
                value={practiceKpId ?? ""}
                onChange={(e) => setPracticeKpId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">全部知识点</option>
                {kp.list.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="qs-field">
              <span className="qs-field-label">题量</span>
              <select value={String(practiceCount)} onChange={(e) => setPracticeCount(Number(e.target.value))}>
                {[3, 5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n} 道
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary small"
              disabled={pickBusy || courseId == null}
              onClick={() => void startPractice()}
            >
              {pickBusy ? "取题中…" : "开始练习"}
            </button>
            {practice ? (
              <button type="button" className="ghost-btn" onClick={() => setPractice(null)}>
                结束本轮
              </button>
            ) : null}
          </div>

          {!practice ? (
            <p className="empty">还没有开始练习。</p>
          ) : practice.finished ? (
            <div className="qs-practice-done">
              <b>本轮练习结束</b>
              <span className="muted">
                共 {practice.results.length} 题；其中判为「答对 / 自评答上了」{" "}
                {practice.results.filter((r) => r.correct === true).length} 题，
                判为「答错 / 自评没答上」{practice.results.filter((r) => r.correct === false).length} 题，
                未判定 {practice.results.filter((r) => r.correct == null).length} 题。
                作答会写进本机作答统计（样本数随之增加）；某一题若写入失败，当题会就地提示并可点「重试记录」。
              </span>
              <button type="button" className="primary small" onClick={() => void startPractice()}>
                再来一轮
              </button>
              <button type="button" className="ghost-btn" onClick={() => setTab("wrong")}>
                去错题本 →
              </button>
            </div>
          ) : currentQ ? (
            <div className="qs-question">
              <div className="qs-question-head">
                <span className="tag">
                  第 {practice.index + 1} / {practice.items.length} 题
                </span>
                <span className="tag">{qtypeLabel(currentQ.qtype)}</span>
                <span className="tag" title="本机题库里这条题所属的知识点">
                  {kpNameOf(currentQ.kp_id, currentQ.kp_name)}
                </span>
                <span className="tag qs-clock" title="这道题你花了多久（会随作答一起记录）">
                  本题 {fmtDuration(elapsedSec * 1000)}
                </span>
                {currentQ.attempts != null ? (
                  <span className="tag">本机统计：这道题作答过 {currentQ.attempts} 次</span>
                ) : null}
              </div>

              <div className="qs-question-stem">{currentQ.stem}</div>

              {isObjective(currentQ.qtype) ? (
                parseOptions(currentQ.options).length > 0 ? (
                  <div className="qs-choice-list">
                    {parseOptions(currentQ.options).map((o, i) => (
                      <label key={`${currentQ.id}-c-${i}`} className={`qs-choice${practice.answer === o ? " picked" : ""}`}>
                        <input
                          type="radio"
                          name={`q-${currentQ.id}`}
                          checked={practice.answer === o}
                          disabled={practice.submitted}
                          onChange={() => setPractice({ ...practice, answer: o })}
                        />
                        <span>{o}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <input
                    className="qs-input qs-blank"
                    value={practice.answer}
                    disabled={practice.submitted}
                    placeholder="填写答案（本机按去空白 / 去标点 / 大写小写不敏感比对）"
                    onChange={(e) => setPractice({ ...practice, answer: e.target.value })}
                  />
                )
              ) : (
                <textarea
                  className="qs-input"
                  rows={5}
                  value={practice.answer}
                  disabled={practice.submitted}
                  placeholder="先自己写下要点，再看参考答案自评（这样才有练习价值）"
                  onChange={(e) => setPractice({ ...practice, answer: e.target.value })}
                />
              )}

              <div className="qs-question-foot">
                <label className="qs-field">
                  <span className="qs-field-label">把握程度（选填）</span>
                  <select
                    value={practice.confidence == null ? "" : String(practice.confidence)}
                    disabled={practice.submitted}
                    onChange={(e) =>
                      setPractice({ ...practice, confidence: e.target.value ? Number(e.target.value) : null })
                    }
                  >
                    <option value="">未填</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span className="qs-field-label">（1 = 完全没把握，5 = 很有把握）</span>
                </label>

                {!practice.submitted ? (
                  <button
                    type="button"
                    className="primary small"
                    disabled={!practice.answer.trim()}
                    onClick={submitAnswer}
                  >
                    提交作答
                  </button>
                ) : (
                  <button type="button" className="primary small" onClick={nextQuestion}>
                    {practice.index + 1 >= practice.items.length ? "完成本轮" : "下一题"}
                  </button>
                )}
              </div>

              {practice.submitted ? (
                <div className="qs-result">
                  {isObjective(currentQ.qtype) ? (
                    <p className={practice.correct ? "qs-result-ok" : "qs-result-bad"}>
                      {practice.correct ? (
                        <>
                          <Icon name="check" size={15} /> 本机判分：答对
                        </>
                      ) : (
                        <>
                          <Icon name="close" size={15} /> 本机判分：答错
                        </>
                      )}
                      <span className="qs-result-note">
                        （客观题在本机按字符串比对判分，不调模型；你的作答「
                        {practice.answer.trim() || "（空）"}」）
                      </span>
                    </p>
                  ) : (
                    <div className="qs-selfeval">
                      <p>
                        <b>参考答案：</b>
                        {answerDisplay(currentQ.qtype, currentQ.answer, parseOptions(currentQ.options))}
                      </p>
                      {currentQ.explain ? <p className="qs-q-explain">{currentQ.explain}</p> : null}
                      <p className="muted">
                        主观题不做自动判分（避免用一个模型给你的答案打分造成误导）：请对照参考答案自评。
                        自评只影响本机统计与之后的选题顺序。
                      </p>
                      {practice.selfEval == null ? (
                        <div className="qs-selfeval-actions">
                          <button type="button" className="primary small" onClick={() => selfEvalOf(1)}>
                            答上了
                          </button>
                          <button type="button" className="ghost-btn" onClick={() => selfEvalOf(0)}>
                            没答上
                          </button>
                        </div>
                      ) : (
                        <p className={practice.selfEval === 1 ? "qs-result-ok" : "qs-result-bad"}>
                          你的自评：{practice.selfEval === 1 ? "答上了" : "没答上"}
                        </p>
                      )}
                    </div>
                  )}

                  {isObjective(currentQ.qtype) ? (
                    <p className="qs-answer-line">
                      <b>参考答案：</b>
                      {answerDisplay(currentQ.qtype, currentQ.answer, parseOptions(currentQ.options))}
                      {currentQ.explain ? <span className="qs-q-explain"> {currentQ.explain}</span> : null}
                    </p>
                  ) : null}

                  <p className={practice.recorded ? "qs-record-ok" : "qs-record-pending"}>
                    {practice.recorded
                      ? `已记录到本机作答统计（用时 ${fmtDuration(practice.frozenMs)}）——不参与任何模型训练。`
                      : practice.recordErr
                        ? `这条作答没能写进本机统计：${practice.recordErr}`
                        : isObjective(currentQ.qtype)
                          ? "正在写本机作答记录…"
                          : "自评之后才会写本机作答记录（现在还没写）。"}
                    {practice.recordErr && !practice.recorded ? (
                      <button type="button" className="ghost-btn" onClick={retryRecord}>
                        重试记录
                      </button>
                    ) : null}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="qs-foot-note">
            诚实边界：客户端<strong>无法训练模型</strong>；这里的作答、用时与把握程度只写进本机数据，
            用于本机统计与之后的选题顺序 / 解释粒度，不会上传、也不会改变模型权重。
          </p>
        </section>
      ) : null}

      {/* =====================================================================
          ⑤ 错题本
          ===================================================================== */}
      {tab === "wrong" ? (
        <section className="card qs-block">
          <div className="section-head">
            <h3>错题本 · 本机作答记录</h3>
          </div>

          <div className="qs-wrong-bar">
            <button
              type="button"
              className="primary small"
              disabled={wrong.rows.length === 0}
              onClick={() => void repracticeWrong()}
            >
              重练错题
            </button>
            <button type="button" className="ghost-btn" onClick={() => void wrong.reload()}>
              刷新错题本
            </button>
            <span className="muted">
              共 {wrong.rows.length} 条作答记录被标为错题；重练会把这些题喂回练习模式。
            </span>
          </div>

          {courseId == null ? (
            <p className="empty">暂无课程。</p>
          ) : wrong.loading ? (
            <p className="loading-line">正在读取本机错题记录…</p>
          ) : wrong.rows.length === 0 ? (
            <p className="empty">暂无记录。</p>
          ) : (
            <ul className="qs-wrong-list">
              {wrong.rows.map((a) => (
                <li key={a.id} className="qs-wrong-item">
                  <div className="qs-wrong-head">
                    <span className="tag">{qtypeLabel(a.qtype)}</span>
                    <span className="tag">{kpNameOf(a.kp_id, a.kp_name)}</span>
                    <span className="tag">{a.created_at}</span>
                    <span className="tag">用时 {fmtDuration(a.duration_ms)}</span>
                    <span className="tag">
                      把握程度 {a.confidence == null ? "未填" : `${a.confidence}/5`}
                    </span>
                    {bit(a.correct) === 0 ? (
                      <span className="tag tag-danger">客观题：答错</span>
                    ) : bit(a.self_eval) === 0 ? (
                      <span className="tag tag-danger">主观题：自评没答上</span>
                    ) : (
                      <span className="tag tag-warn">未判定</span>
                    )}
                  </div>
                  <div className="qs-wrong-stem">{a.stem ?? `（题目 #${a.question_id} 的原文已不在本机题库里）`}</div>
                  <p className="qs-wrong-line">
                    <b>你的作答：</b>
                    {(a.user_answer ?? "").trim() || "（空）"}
                  </p>
                  <p className="qs-wrong-line">
                    <b>参考答案：</b>
                    {answerDisplay(a.qtype ?? "", a.answer ?? "", parseOptions(a.options))}
                  </p>
                  {a.explain ? <p className="qs-q-explain">{a.explain}</p> : null}
                </li>
              ))}
            </ul>
          )}

          <p className="qs-foot-note">
            错题本与掌握度都是<strong>本机统计</strong>：只读本机数据里的作答记录，
            不联网、不上传、不用来训练任何模型。
          </p>
        </section>
      ) : null}

      <p className="qs-closing">{LOCAL_ONLY_NOTE}</p>
    </div>
  );
}
