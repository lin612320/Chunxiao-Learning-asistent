// 学习画像（M4 契约 docs/10-M4契约.md §2.4 统计与画像命令 / §3.2 画像页）命令封装
// + **浏览器预览示例数据**。
//
// 互操作口径（docs/01-M0骨架契约.md §四.1，已冻结，逐字遵循）：
//   · 命令参数一律 **camelCase**：courseId / kpId / trait / value / evidence；
//   · 行返回字段一律 **snake_case**：kp_id / kp_name / attempts / correct / accuracy /
//     mastery / evidence / last_at / questions；
//   · 空列表一律返回 `[]`（不返回 null），前端按数组处理。
//
// ⚠️ 预览数据为什么放在本文件、而不是 src/data/sample.ts（契约 §3.4）：
//     M4 由多个代理并行开发，`src/data/sample.ts` 已归**题库代理**所有。为了**避开并发写同一文件**
//     造成冲突，画像页的预览示例数据放在这里（本文件归画像页所有）。
//     `!isTauri()` 时下面的 `preview*` 直接供页面渲染，保证浏览器预览（`npx vite`）下画像页也能看；
//     界面上会明确标注「这是内置示例数据，不是你的作答记录」，**不冒充真实统计**。
//     预览示例只覆盖示例课程 id=1（数据结构与算法）；选其他课程会如实显示「暂无记录」。
//
// 口径红线（契约 §一）在本文件的落地：
//   1. 掌握度是**统计量**：`mastery` 与 `evidence = attempts` **必须同时展示**（页面强制）；
//   2. `attempts < min_evidence`（默认 3）的条目只进 `not_enough`：页面以**灰态**显示
//      「样本不足（n 次）」，**不给掌握度数字、不进弱项榜**；
//   3. 公式 `mastery = (correct + 1) / (attempts + 2)`（拉普拉斯平滑）写进注释与界面 tooltip；
//   4. 全部为**本机查询**：无网络、无上传、不参与任何模型训练，界面一律用「本机统计」措辞。

import { callRust, invokeStrict, isTauri } from "./tauri";

// ---------------------------------------------------------------------------
// 常量与口径
// ---------------------------------------------------------------------------

/** `trait` 取值（契约 §2.4 冻结，非法值由 Rust 给可读中文错误） */
export const TRAIT_KINDS = ["mastery", "weakness_self", "preference", "style"] as const;
export type TraitKind = (typeof TRAIT_KINDS)[number];

export const TRAIT_LABEL: Record<TraitKind, string> = {
  mastery: "掌握度（系统统计，只读）",
  weakness_self: "自述缺漏（你说的）",
  preference: "偏好",
  style: "风格",
};

/** 掌握度公式（契约 §2.4 冻结，**逐字**）：拉普拉斯平滑，避免 0/0 与 1/1 的极端 */
export const MASTERY_FORMULA = "mastery = (correct + 1) / (attempts + 2)";

/** 公式说明（tooltip 与页面口径说明块共用，避免两处措辞不一致） */
export const MASTERY_FORMULA_NOTE =
  "mastery = (correct + 1) / (attempts + 2)：拉普拉斯平滑，避免 0/0 与 1/1 的极端；evidence = attempts（支撑样本数）。";

/** 样本不足阈值；后端会随 `profile_overview` 返回 `min_evidence`，这里是读不到时的兜底 */
export const MIN_EVIDENCE_FALLBACK = 3;

/** 本机与训练边界（契约 §一 第 6 条要求的注明，逐字使用） */
export const LOCAL_ONLY_NOTE = "数据只在本机；不参与任何模型训练。";

/** 预览模式说明（与 lib/focus.ts 的 PREVIEW_* 同一套口径：如实说明，不静默）
 *  ⚠ R3 修 bug：原文里用了 Markdown 的 `**` 强调，但它是**纯文本渲染**（`{PREVIEW_PROFILE_NOTE}`），
 *    用户会看到字面的星号。这里改成自然语句。 */
export const PREVIEW_PROFILE_NOTE =
  "网页预览模式：下面显示的是自带的示例数据（不是你的作答记录），只用来试界面；桌面版显示的才是你本机的真实统计。";
export const PREVIEW_WRITE_NOTE =
  "网页预览里存不了：自述缺漏、偏好、风格只能在桌面版保存（这里不会假装保存成功）。";

/**
 * 掌握度分档（只用于配色与文字标签，**不改变任何数值**）。
 * 数值一律来自后端/本文件的统计，前端绝不"四舍五入成好看的数字"。
 */
export type MasteryBand = "high" | "mid" | "low" | "weak" | "none";

export function masteryBand(mastery: number | null): MasteryBand {
  if (mastery == null || !Number.isFinite(mastery)) return "none";
  if (mastery >= 0.8) return "high";
  if (mastery >= 0.6) return "mid";
  if (mastery >= 0.4) return "low";
  return "weak";
}

export const BAND_LABEL: Record<MasteryBand, string> = {
  high: "熟练",
  mid: "基本掌握",
  low: "偏弱",
  weak: "薄弱",
  // "none" 表示**没有可展示的掌握度**（样本不足，或后端没给 mastery）：
  // 这时页面不显示数字；灰态区的文案另有「样本不足（n 次）」。
  none: "无掌握度数据",
};

/** 掌握度 → 百分比文本；null（样本不足）一律返回「—」，**不给数字** */
export function pct(mastery: number | null): string {
  if (mastery == null || !Number.isFinite(mastery)) return "—";
  return `${Math.round(mastery * 100)}%`;
}

/** 原始正确率 → 百分比文本；attempts = 0 时后端给 null，这里也显示「—」（不拿平滑值冒充原始正确率） */
export function pctOrDash(accuracy: number | null): string {
  if (accuracy == null || !Number.isFinite(accuracy)) return "—";
  return `${Math.round(accuracy * 100)}%`;
}

/**
 * 按契约 §2.4 的公式算掌握度（仅在**后端缺 `mastery` 字段**时兜底）。
 * 注意：这是纯函数而非"估算"——公式已被契约冻结；两个原始量（correct / attempts）也缺时返回 null，
 * 绝不凭空造数。
 */
export function computeMastery(correct: number, attempts: number): number | null {
  if (!Number.isFinite(correct) || !Number.isFinite(attempts) || attempts <= 0) return null;
  return (correct + 1) / (attempts + 2);
}

// ---------------------------------------------------------------------------
// 类型（行字段逐字按后端 snake_case）
// ---------------------------------------------------------------------------

/** `question_stats` / `profile_overview` 里按知识点聚合的一行 */
export interface ProfileKpStat {
  kp_id: number | null;
  kp_name: string;
  /** 该知识点下的题目数 */
  questions: number;
  /** 作答次数 = evidence（支撑样本数，红线要求必须显示） */
  attempts: number;
  correct: number;
  /** 原始正确率 correct / attempts；attempts = 0 时为 null（与 mastery 并存展示） */
  accuracy: number | null;
  /** 拉普拉斯平滑后的掌握度；样本不足或拿不到时为 null */
  mastery: number | null;
  /** 支撑样本数 = attempts */
  evidence: number;
  last_at: string | null;
}

/** `profile_traits_list` 一行（`profile_overview.declared_gaps` / `.preferences` 同形状） */
export interface ProfileTraitRow {
  id: number | null;
  kp_id: number | null;
  trait: string;
  /** 数值：自述薄弱用 1/0，偏好与风格用 1–5 档；可为 null */
  value: number | null;
  /** 支撑样本数；自述类为 null（自述不产生统计样本，不编一个数字出来） */
  evidence: number | null;
  updated_at: string | null;
}

/** `profile_overview` 返回体（契约 §2.4） */
export interface ProfileOverview {
  mastery: ProfileKpStat[];
  weak_points: ProfileKpStat[];
  not_enough: ProfileKpStat[];
  declared_gaps: ProfileTraitRow[];
  preferences: ProfileTraitRow[];
  min_evidence: number;
}

/** 知识点（`knowledge_points_list` 一行；自述缺漏的勾选/录入用） */
export interface KnowledgePoint {
  id: number;
  course_id: number;
  name: string;
  attempts: number;
  correct: number;
}

/** 写入画像特征的输入（`profile_trait_set`） */
export interface TraitInput {
  kpId: number | null;
  trait: TraitKind;
  value: number | null;
  /** 自述类固定传 null：自述本身没有统计样本，**不编造样本数** */
  evidence: number | null;
}

/** 偏好（preference）与风格（style）的 1–5 档取值说明（本机统计用，不影响模型） */
export const PREFERENCE_SCALE: { value: number; label: string }[] = [
  { value: 1, label: "1 · 只要结论与要点" },
  { value: 2, label: "2 · 简要说明" },
  { value: 3, label: "3 · 常规讲解" },
  { value: 4, label: "4 · 逐步推导" },
  { value: 5, label: "5 · 逐步推导 + 举例对比" },
];

export const STYLE_SCALE: { value: number; label: string }[] = [
  { value: 1, label: "1 · 先例子，后定义" },
  { value: 2, label: "2 · 偏例子" },
  { value: 3, label: "3 · 例子与定义并重" },
  { value: 4, label: "4 · 偏定义" },
  { value: 5, label: "5 · 先定义，后例子" },
];

export function scaleLabel(trait: string, value: number | null): string {
  const scale = trait === "preference" ? PREFERENCE_SCALE : trait === "style" ? STYLE_SCALE : null;
  if (value == null || !scale) return value == null ? "未设置" : String(value);
  return scale.find((s) => s.value === value)?.label ?? `未收录的档位（${value}）`;
}

// ---------------------------------------------------------------------------
// 规整（后端返回 Value，字段可能缺；缺什么就老实空着，不推算）
// ---------------------------------------------------------------------------

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asId(v: unknown): number | null {
  if (v == null) return null;
  const n = asNum(v, NaN);
  return Number.isFinite(n) ? n : null;
}

function normalizeKpStat(raw: unknown): ProfileKpStat | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // 原始量先判"后端到底给没给"：字段缺失时**不许当成 0**，
  // 否则会凭空算出「答对 0 次」的假掌握度（红线：不造数据）。
  const rawAttempts = o.attempts == null ? null : asNum(o.attempts, NaN);
  const attemptsKnown = rawAttempts != null && Number.isFinite(rawAttempts);
  const attempts = attemptsKnown ? Math.max(0, rawAttempts) : 0;
  const rawCorrect = o.correct == null ? null : asNum(o.correct, NaN);
  const correctKnown = rawCorrect != null && Number.isFinite(rawCorrect);
  const correct = correctKnown ? Math.max(0, rawCorrect) : 0;
  const kpId = asId(o.kp_id);
  // mastery：优先用后端给的值（它是权威口径）；后端缺字段时，按契约 §2.4 冻结的同一公式兜底补算，
  // 避免出现"有样本却一片空白"。两个原始量任一缺失 → null（不造数）。
  const rawMastery = o.mastery == null ? null : asNum(o.mastery, NaN);
  const mastery =
    rawMastery != null && Number.isFinite(rawMastery)
      ? rawMastery
      : correctKnown && attemptsKnown
        ? computeMastery(correct, attempts)
        : null;
  const rawAccuracy = o.accuracy == null ? null : asNum(o.accuracy, NaN);
  // 后端约定 attempts = 0 时 accuracy 为 null；这里只做"null 就保持 null"，不用 mastery 顶替
  const accuracy =
    rawAccuracy != null && Number.isFinite(rawAccuracy)
      ? rawAccuracy
      : attempts > 0 && correctKnown
        ? correct / attempts
        : null;
  return {
    kp_id: kpId,
    kp_name: asText(o.kp_name) || (kpId != null ? `知识点 #${kpId}` : "未命名知识点"),
    questions: Math.max(0, asNum(o.questions)),
    attempts,
    correct,
    accuracy,
    mastery,
    evidence: Math.max(0, asNum(o.evidence, attempts)),
    last_at: o.last_at == null ? null : asText(o.last_at),
  };
}

function normalizeKpList(raw: unknown): ProfileKpStat[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeKpStat).filter((r): r is ProfileKpStat => r !== null);
}

function normalizeTrait(raw: unknown): ProfileTraitRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const trait = asText(o.trait);
  if (!trait) return null; // 没有 trait 的行无法归类，直接丢弃（不假装有特征）
  return {
    id: asId(o.id),
    kp_id: asId(o.kp_id),
    trait,
    value: o.value == null ? null : asNum(o.value, NaN),
    evidence: o.evidence == null ? null : Math.max(0, asNum(o.evidence)),
    updated_at: o.updated_at == null ? null : asText(o.updated_at),
  };
}

function normalizeTraitList(raw: unknown): ProfileTraitRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeTrait).filter((r): r is ProfileTraitRow => r !== null);
}

/**
 * 规整 `profile_overview`。
 * 返回 null 表示「这不是一个可用的画像对象」→ 界面按**读取失败**处理（与"确实没有记录"区分开）。
 */
export function normalizeOverview(raw: unknown): ProfileOverview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    mastery: normalizeKpList(o.mastery),
    weak_points: normalizeKpList(o.weak_points),
    not_enough: normalizeKpList(o.not_enough),
    declared_gaps: normalizeTraitList(o.declared_gaps),
    preferences: normalizeTraitList(o.preferences),
    min_evidence: Math.max(0, asNum(o.min_evidence, MIN_EVIDENCE_FALLBACK)) || MIN_EVIDENCE_FALLBACK,
  };
}

function normalizeKnowledgePoint(raw: unknown): KnowledgePoint | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = asId(o.id);
  const courseId = asId(o.course_id);
  if (id == null || courseId == null) return null;
  return {
    id,
    course_id: courseId,
    name: asText(o.name) || `知识点 #${id}`,
    attempts: Math.max(0, asNum(o.attempts)),
    correct: Math.max(0, asNum(o.correct)),
  };
}

// ---------------------------------------------------------------------------
// 预览示例数据（!isTauri()；只覆盖示例课程 id=1）
// ---------------------------------------------------------------------------

const PREVIEW_COURSE_ID = 1;

function iso(daysAgo: number, hhmm = "21:04"): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm}`;
}

/** 预览知识点（与示例课程 id=1「数据结构与算法」对得上） */
const PREVIEW_KPS: KnowledgePoint[] = [
  { id: 11, course_id: PREVIEW_COURSE_ID, name: "数组与动态数组", attempts: 9, correct: 8 },
  { id: 12, course_id: PREVIEW_COURSE_ID, name: "链表操作", attempts: 6, correct: 3 },
  { id: 13, course_id: PREVIEW_COURSE_ID, name: "二叉树遍历", attempts: 7, correct: 2 },
  { id: 14, course_id: PREVIEW_COURSE_ID, name: "哈希冲突处理", attempts: 2, correct: 1 },
  { id: 15, course_id: PREVIEW_COURSE_ID, name: "图的最短路径", attempts: 0, correct: 0 },
  { id: 16, course_id: PREVIEW_COURSE_ID, name: "排序算法复杂度", attempts: 4, correct: 3 },
];

function previewStat(kp: KnowledgePoint, daysAgo: number): ProfileKpStat {
  return {
    kp_id: kp.id,
    kp_name: kp.name,
    questions: Math.max(kp.attempts, 3),
    attempts: kp.attempts,
    correct: kp.correct,
    accuracy: kp.attempts > 0 ? kp.correct / kp.attempts : null,
    mastery: computeMastery(kp.correct, kp.attempts),
    evidence: kp.attempts,
    last_at: kp.attempts > 0 ? iso(daysAgo) : null,
  };
}

/** 预览画像特征：2 条自述缺漏 + 1 条偏好 + 1 条风格 */
const PREVIEW_TRAITS: ProfileTraitRow[] = [
  { id: 101, kp_id: 13, trait: "weakness_self", value: 1, evidence: null, updated_at: iso(1) },
  { id: 102, kp_id: 12, trait: "weakness_self", value: 1, evidence: null, updated_at: iso(2) },
  { id: 103, kp_id: null, trait: "preference", value: 4, evidence: null, updated_at: iso(3) },
  { id: 104, kp_id: null, trait: "style", value: 2, evidence: null, updated_at: iso(3) },
];

function previewOverview(courseId: number): ProfileOverview {
  // 只覆盖示例课程 id=1；其他课程如实返回空画像（预览模式不编造数据）
  if (courseId !== PREVIEW_COURSE_ID) {
    return {
      mastery: [],
      weak_points: [],
      not_enough: [],
      declared_gaps: [],
      preferences: [],
      min_evidence: MIN_EVIDENCE_FALLBACK,
    };
  }
  const stats = PREVIEW_KPS.map((kp, i) => previewStat(kp, i + 1));
  const enough = stats.filter((s) => s.evidence >= MIN_EVIDENCE_FALLBACK);
  const notEnough = stats.filter((s) => s.evidence < MIN_EVIDENCE_FALLBACK);
  const sorted = [...enough].sort((a, b) => (a.mastery ?? 1) - (b.mastery ?? 1));
  return {
    mastery: enough,
    // 契约 §2.4：弱项 = mastery 升序取前 10（只做排序，不代表"这些都不及格"）
    weak_points: sorted.slice(0, 10),
    not_enough: notEnough,
    declared_gaps: PREVIEW_TRAITS.filter((t) => t.trait === "weakness_self"),
    preferences: PREVIEW_TRAITS.filter((t) => t.trait === "preference" || t.trait === "style"),
    min_evidence: MIN_EVIDENCE_FALLBACK,
  };
}

// ---------------------------------------------------------------------------
// 命令封装
// ---------------------------------------------------------------------------

/**
 * 读学习画像总览。
 * 返回 null = 读不到（桌面端命令失败，或后端没返回可用对象）→ 界面按"读取失败"如实说明并给重试，
 * 与"该课程确实还没有作答记录"（空数组）严格区分。
 */
export async function profileOverview(courseId: number): Promise<ProfileOverview | null> {
  if (!isTauri()) return previewOverview(courseId);
  const raw = await callRust<unknown>("profile_overview", { courseId });
  return normalizeOverview(raw);
}

/** 读画像特征列表（`courseId` 传 null 表示不限课程）；读不到返回 [] */
export async function profileTraitsList(courseId: number | null): Promise<ProfileTraitRow[]> {
  if (!isTauri()) {
    if (courseId == null) return PREVIEW_TRAITS;
    return courseId === PREVIEW_COURSE_ID ? PREVIEW_TRAITS : [];
  }
  const raw = await callRust<unknown>("profile_traits_list", { courseId });
  return normalizeTraitList(raw);
}

/**
 * 写一条画像特征（**写入类**，走 invokeStrict：失败抛可读中文错误由界面展示）。
 * - `mastery` 是系统按作答记录算出来的**只读**特征，这里直接拒绝手工写入；
 * - `weakness_self` 是用户自述，**没有统计样本**，evidence 传 null，不编造数字；
 * - 浏览器预览下 invokeStrict 会抛「仅桌面版可用」，界面据此如实提示（不静默失败）。
 */
export async function profileTraitSet(input: TraitInput): Promise<number> {
  if (!TRAIT_KINDS.includes(input.trait)) {
    throw new Error(`画像特征类型不合法：${String(input.trait)}（只能是 mastery / weakness_self / preference / style）。`);
  }
  if (input.trait === "mastery") {
    throw new Error("掌握度由本机作答记录统计得出，属于只读特征，不能手工写入。");
  }
  const id = await invokeStrict<number>("profile_trait_set", {
    kpId: input.kpId,
    trait: input.trait,
    value: input.value,
    evidence: input.evidence,
  });
  if (!Number.isFinite(Number(id))) {
    throw new Error("后端没有返回有效 id，这条画像特征没有保存成功。");
  }
  return Number(id);
}

/** 知识点列表（自述缺漏的勾选/录入用）；读不到返回 [] */
export async function knowledgePointsList(courseId: number): Promise<KnowledgePoint[]> {
  if (!isTauri()) return PREVIEW_KPS.filter((k) => k.course_id === courseId);
  const raw = await callRust<unknown>("knowledge_points_list", { courseId });
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeKnowledgePoint)
    .filter((k): k is KnowledgePoint => k !== null)
    .sort((a, b) => a.id - b.id);
}

/**
 * 手工录入一个知识点（自述缺漏里"我薄弱的是 XXX，列表里没有"用）。
 * 契约 §2.1：同名同课程已存在时后端返回既有 id，不会重复插。
 */
export async function knowledgePointSave(courseId: number, name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("知识点名称不能为空。");
  const id = await invokeStrict<number>("knowledge_point_save", {
    courseId,
    name: trimmed,
    priorId: null,
    parentId: null,
  });
  if (!Number.isFinite(Number(id))) {
    throw new Error("后端没有返回有效 id，知识点没有保存成功。");
  }
  return Number(id);
}
