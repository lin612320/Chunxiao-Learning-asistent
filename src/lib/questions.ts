// M4 题库：**命令封装 + 出题提示词 + 生成结果的 JSON 容错解析 + 客观题本地判分**。
//
// 契约：`docs/10-M4契约.md` §二 / §三.1；产品红线：`docs/00-可行性评估.md` §7.2、`10-M4契约.md` §一
//   · 出题走既有 `chatStream`（BYOK），提示词要求**严格 JSON 数组**，**不自动入库** ——
//     生成结果交给题库页做「预览 → 可编辑 → 用户确认」后才调 `questions_save_batch`；
//   · 未配 Key 时**不生成**（不许用模板假造题目冒充 AI 生成）；
//   · 解析容错：容忍 ```json 围栏与前后废话；失败给**可读中文错误**并保留原始输出；
//   · 客观题（choice / blank）在本机判分，**不调模型**；主观题（short / essay）交给用户自评；
//   · 文案口径：一律写「本机统计」，禁止「智能体自我进化 / 越用越聪明 / 模型在学习」。
//
// ⚠ 本文件**只与 Rust 命令 / 模型接口打交道**，不碰 React；双环境（桌面 / 浏览器预览）
//   的分派在 `hooks/useQuestions.ts` 里（照 `hooks/useChat.ts` 的写法）。
//   这里所有命令都用 `invokeStrict`：读也用严格模式，**读取失败必须能被看见**，
//   否则界面会把"读失败"谎报成"暂无记录"。

import { chatStream, type AIConfig, type ApiMsg } from "./ai";
import { invokeStrict } from "./tauri";
import type { AttemptItem, KnowledgePointItem, QuestionItem } from "../data/sample";

// ---------------------------------------------------------------------------
// 题型
// ---------------------------------------------------------------------------

export type QType = "choice" | "blank" | "short" | "essay";

export const QTYPES: QType[] = ["choice", "blank", "short", "essay"];

export const QTYPE_LABEL: Record<QType, string> = {
  choice: "选择题",
  blank: "填空题",
  short: "简答题",
  essay: "论述题",
};

export function isQType(v: unknown): v is QType {
  return typeof v === "string" && (QTYPES as string[]).includes(v);
}

export function qtypeLabel(qtype: string | null | undefined): string {
  return isQType(qtype) ? QTYPE_LABEL[qtype] : (qtype ?? "").trim() || "未知题型";
}

/** 客观题 = 能在本机判分的题型；主观题必须由用户自评（契约 §2.3） */
export function isObjective(qtype: string | null | undefined): boolean {
  return qtype === "choice" || qtype === "blank";
}

/** 0/1 的宽松读取：Rust 落库是 `0/1`，但前端也容忍 `true/false`；其它一律 null（= 没有值） */
export function bit(v: unknown): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v === 0 ? 0 : 1;
  return null;
}

// ---------------------------------------------------------------------------
// options：库里是 JSON 字符串，界面里是字符串数组
// ---------------------------------------------------------------------------

/** 解析 `options`（JSON 字符串 / 数组 / null）。解析不了就退化为按行切分，**不丢用户已有的内容** */
export function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    if (Array.isArray(v)) return parseOptions(v);
  } catch {
    /* 下面按纯文本兜底 */
  }
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 序列化成落库用的 JSON 字符串；空数组返回 null（Rust 侧要求能解析为 JSON 数组） */
export function serializeOptions(list: string[]): string | null {
  const clean = list.map((s) => s.trim()).filter(Boolean);
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

/** 编辑框里"一行一个选项" → 数组 */
export function optionsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 客观题本地判分（纯函数，不联网、不调模型）
// ---------------------------------------------------------------------------

/**
 * 答案归一化：去空白、去中英文标点、全角转半角、统一小写。
 * 目的是让「O(1)」与「O（1）」、「A.」与「a」、「BST」与「bst」都能判成同一个答案。
 */
export function normalizeAnswerText(s: unknown): string {
  return String(s ?? "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：！？“”‘’（）【】《》,.;:!?"'()[\]{}<>·…—–~`]/g, "")
    .toLowerCase();
}

/** 参考答案里可以用 `|` 写多个可接受写法（如 `O(1)|常数`） */
export function splitAcceptedAnswers(answer: string): string[] {
  return String(answer ?? "")
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把一个"选项答案"定位到选项下标（0 起）。
 * 依次尝试：① 与某个选项文本逐字相同（归一化后）→ ② 单个字母 A/B/C… → ③ 单个数字 1/2/3…
 * 定位不了返回 -1（调用方退化到文本比较）。
 */
export function optionIndexFrom(raw: unknown, options: string[]): number {
  const n = normalizeAnswerText(raw);
  if (!n || options.length === 0) return -1;
  const exact = options.findIndex((o) => normalizeAnswerText(o) === n);
  if (exact >= 0) return exact;
  if (options.length <= 26 && /^[a-z]$/.test(n)) return n.charCodeAt(0) - 97;
  if (/^[0-9]$/.test(n)) {
    const i = Number(n) - 1;
    if (i >= 0 && i < options.length) return i;
  }
  return -1;
}

export interface JudgeInput {
  qtype: string;
  /** 标准答案（选择题一般是选项文本；也容忍写成 A / 1） */
  answer: string;
  /** 用户作答 */
  userAnswer: string;
  /** 选择题选项（其它题型传空数组） */
  options?: string[];
}

/**
 * 客观题判分（**本机**，纯字符串比较）。
 * 选择题：优先把双方都定位到选项下标再比；定位不了就比归一化文本。
 * 填空题：与任一"可接受写法"归一化后相同即算对。
 */
export function judgeObjective(input: JudgeInput): boolean {
  const user = normalizeAnswerText(input.userAnswer);
  if (!user) return false;
  const accepted = splitAcceptedAnswers(input.answer);
  if (accepted.some((a) => normalizeAnswerText(a) === user)) return true;

  if (input.qtype === "choice") {
    const opts = input.options ?? [];
    const ai = optionIndexFrom(input.answer, opts);
    const ui = optionIndexFrom(input.userAnswer, opts);
    if (ai >= 0 && ui >= 0) return ai === ui;
  }
  return false;
}

/** 参考答案的展示文本：选择题若写的是 A/B/C 就补上选项原文，免得用户对着字母猜 */
export function answerDisplay(qtype: string, answer: string, options: string[]): string {
  const a = (answer ?? "").trim();
  if (qtype !== "choice" || options.length === 0) return a;
  const i = optionIndexFrom(a, options);
  if (i < 0) return a;
  const text = options[i];
  return normalizeAnswerText(text) === normalizeAnswerText(a) ? text : `${a}（${text}）`;
}

// ---------------------------------------------------------------------------
// 练习选题排序（**仅浏览器预览模式用**：桌面版由 Rust 的 `practice_pick` 排序）
// ---------------------------------------------------------------------------

/**
 * 掌握度公式 —— 与契约 §2.4 逐字一致（必须同时给样本数 `attempts`）：
 *   mastery = (correct + 1) / (attempts + 2)   // 拉普拉斯平滑，避免 0/0 与 1/1 的极端
 * ⚠ 这只是**本机统计量**，不是"模型学会了"。
 */
export function masteryOf(attempts: number, correct: number): number {
  return (correct + 1) / (attempts + 2);
}

export interface WeaknessKey {
  /** 该题所属知识点的作答次数 / 答对次数；没有知识点信息时传 null */
  attempts: number | null;
  correct: number | null;
}

/**
 * 预览模式的 `practice_pick` 排序（与 Rust 同口径，便于对照）：
 *   ① 从未作答的题优先；
 *   ② 其次按所属知识点的掌握度**升序**（越弱越先）；
 *   ③ 同分按 id 稳定排序。
 */
export function orderPracticeQuestions(
  rows: QuestionItem[],
  weaknessOf: (q: QuestionItem) => WeaknessKey,
): QuestionItem[] {
  const keyOf = (q: QuestionItem): [number, number, number] => {
    const done = (q.attempts ?? 0) > 0;
    const w = weaknessOf(q);
    const mastery = w.attempts == null || w.correct == null ? 0.5 : masteryOf(w.attempts, w.correct);
    return [done ? 1 : 0, mastery, q.id];
  };
  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// 出题提示词
// ---------------------------------------------------------------------------

/** 一次最多接受多少道（防止模型刷出几百道把界面撑爆） */
export const QUESTIONS_MAX_ITEMS = 30;

/** AI 生成题目的固定入库口径（契约 §一.5：`source='ai'`，且必须人工可校正） */
export const QUESTION_SOURCE_AI = "ai";
export const QUESTION_SOURCE_REF_AI = "AI 生成 · 待核对";

/** 生成超时（与知识骨架同量级，防止界面卡死） */
export const QUESTIONS_TIMEOUT_MS = 180_000;

/** 单次生成的题量上限（界面上的数量输入框也按它校验） */
export const QUESTIONS_MAX_COUNT = 20;

/** 每个知识点最多取几条先验知识摘要 / 材料片段喂给模型 */
export const QUESTIONS_MAX_PRIOR = 12;
export const QUESTIONS_MAX_SNIPPETS = 8;

/** 系统提示词：口径写死在这里，改文案请同步契约 §三.1 */
export const QUESTIONS_SYSTEM_PROMPT = [
  "你是「春晓」——面向大学生的本地单机学习助手，正在帮用户为**课后复习**出练习题。",
  "",
  "输出要求（必须严格遵守）：",
  "1. 只输出**一个严格的 JSON 数组**，不要输出任何解释、前言、后记或 Markdown 说明；不要用代码围栏。",
  '2. 数组每一项形如：{"qtype":"choice|blank|short|essay","stem":"题干","options":["A项","B项"],"answer":"参考答案","explain":"解析","difficulty":1,"kp_name":"知识点名称"}。',
  '3. `qtype` 只能取 choice（选择题）/ blank（填空题）/ short（简答题）/ essay（论述题）四个值之一。',
  "4. 只有 choice 才写 `options`（**2–5 个选项，逐字作为备选项**），且 `answer` 必须**逐字等于**其中某一个选项；其它题型不要写 options（写 null 或省略）。",
  "5. `answer` 必须是可独立判定的参考答案：选择/填空给最短的准确答案（填空不要写整句话），简答/论述给 1–3 句要点；`explain` 写为什么，以及常见误解。",
  "6. `difficulty` 是 1–5 的整数（1 最易、5 最难）；`kp_name` 必须**逐字等于**下面给出的某个知识点名称。",
  "7. **禁止编造具体数据、条文、页码、引用、人名、文献**：不要写「见第 x 页」「教材第 x 章」「根据某某论文」。只考概念、定义、关系、方法与常见误区。",
  "8. 不考押题、不出真题、不给答案速出式的应试技巧：这是课后复习用的练习题，不是考试工具。",
  "9. 用中文；题干一句话说清（不超过 120 字），explain 不超过 200 字。",
].join("\n");

export interface QuestionPriorHint {
  /** 知识点名称（必须逐字进提示词，模型要用它填 kp_name） */
  name: string;
  /** 该知识点对应的先验知识摘要（没同步到先验知识时为空） */
  summary?: string | null;
  detail?: string | null;
}

export interface QuestionMaterialHint {
  material: string;
  heading?: string | null;
  snippet: string;
}

export interface QuestionGenInput {
  courseName: string;
  kps: QuestionPriorHint[];
  materials?: QuestionMaterialHint[];
  count: number;
  /** 流式进度回调（已收到多少字），仅用于界面提示 */
  onProgress?: (chars: number) => void;
}

/** 用户提示词：知识点 + 先验知识摘要 + 可复用的材料片段 */
export function buildQuestionsUserPrompt(input: QuestionGenInput): string {
  const count = Math.max(1, Math.min(Math.round(input.count) || 1, QUESTIONS_MAX_COUNT));
  const kps = input.kps.filter((k) => k.name.trim().length > 0).slice(0, QUESTIONS_MAX_PRIOR);
  const lines: string[] = [
    `课程名称：${input.courseName.trim() || "（未填写）"}`,
    `本次出题数量：共 ${count} 道（请平均分配到下面各知识点，不要少给也不要多给）。`,
    "",
    "要考察的知识点（kp_name 必须逐字使用这里的名称）：",
  ];

  if (kps.length === 0) {
    lines.push("- （没有选中知识点：请只依据课程名称出通用复习题，kp_name 留空字符串）");
  } else {
    kps.forEach((k, i) => {
      lines.push(`【${i + 1}】${k.name.trim()}`);
      const summary = (k.summary ?? "").trim();
      const detail = (k.detail ?? "").trim();
      if (summary) lines.push(`    先验知识摘要：${summary}`);
      if (detail) lines.push(`    补充说明：${detail.replace(/\s*\n\s*/g, "；").slice(0, 300)}`);
    });
  }

  const mats = (input.materials ?? []).filter((m) => (m.snippet ?? "").trim().length > 0).slice(0, QUESTIONS_MAX_SNIPPETS);
  lines.push("");
  if (mats.length === 0) {
    lines.push(
      "用户这门课没有可用的材料片段：请只依据上面的知识点与你的通用知识出题，**不要编造材料出处**。",
    );
  } else {
    lines.push(
      "可参考的用户课程材料片段（**只是参考**，帮助你贴合这门课的实际讲法；不要点名引用文件名、不要编造页码）：",
    );
    mats.forEach((m, i) => {
      const heading = (m.heading ?? "").trim();
      lines.push(`【材料${i + 1}】（${m.material}${heading ? ` · ${heading}` : ""}）`);
      lines.push(m.snippet.trim().slice(0, 600));
    });
  }

  lines.push("", "请按上面的要求输出 JSON 数组：");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 解析（容错 + 可读中文错误）
// ---------------------------------------------------------------------------

/** 生成出来的一道题（入库前的草稿） */
export interface QuestionDraft {
  qtype: QType;
  stem: string;
  /** 非选择题为 [] */
  options: string[];
  answer: string;
  explain: string;
  /** 1–5 */
  difficulty: number;
  kp_name: string;
}

export interface ParseQuestionsOutcome {
  items: QuestionDraft[];
  /** 因格式不合法被丢弃的条数（不静默：界面要如实说明） */
  dropped: number;
  error?: string;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function clampDifficulty(v: unknown): number {
  const n = typeof v === "number" ? v : Number(asText(v));
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function normalizeDraft(x: unknown): QuestionDraft | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const stem = asText(o.stem);
  if (!stem) return null;

  // 题型：容忍简写（single/multi → choice、fill → blank、qa → short）
  const raw = asText(o.qtype).toLowerCase();
  const alias: Record<string, QType> = {
    choice: "choice",
    single: "choice",
    multi: "choice",
    select: "choice",
    blank: "blank",
    fill: "blank",
    fillin: "blank",
    short: "short",
    qa: "short",
    essay: "essay",
    long: "essay",
  };
  const qtype = alias[raw];
  if (!qtype) return null;

  let options = qtype === "choice" ? parseOptions(o.options ?? o.choices) : [];
  options = options.slice(0, 8);
  if (qtype === "choice" && options.length < 2) return null;

  let answer = asText(o.answer ?? o.correct_answer ?? o.reference);
  if (!answer) return null;

  // 选择题：模型常把答案写成 "B"，这里补成选项原文，判分与展示都更稳
  if (qtype === "choice") {
    const i = optionIndexFrom(answer, options);
    if (i >= 0) answer = options[i];
  }

  return {
    qtype,
    stem,
    options,
    answer,
    explain: asText(o.explain ?? o.analysis ?? o.explanation),
    difficulty: clampDifficulty(o.difficulty),
    kp_name: asText(o.kp_name ?? o.kpName ?? o.knowledge_point),
  };
}

/** 依次尝试几个候选片段：去围栏后的整体 → 首个 `[` 到末个 `]` 之间 → 原文 */
function candidates(raw: string): string[] {
  const s = raw.trim();
  const out: string[] = [];
  const fenced = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) out.push(s.slice(start, end + 1));
  if (fenced && fenced !== s) out.push(fenced);
  out.push(s);
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * 把模型输出解析成草稿数组。
 * 解析失败**不静默**：返回可读中文错误（调用方把原始输出展示给用户）。
 */
export function parseQuestionsJson(raw: string): ParseQuestionsOutcome {
  const s = (raw ?? "").trim();
  if (!s) return { items: [], dropped: 0, error: "模型没有返回任何内容（可能是空回复或被截断）。" };

  let parsed: unknown = null;
  let sawJson = false;
  for (const c of candidates(s)) {
    try {
      parsed = JSON.parse(c) as unknown;
      sawJson = true;
      break;
    } catch {
      /* 试下一个候选片段 */
    }
  }
  if (!sawJson) {
    return {
      items: [],
      dropped: 0,
      error: "模型返回的内容不是合法 JSON（已保留原始输出，可展开查看后重试）。",
    };
  }

  // 少数模型会包一层 {"items": [...]} / {"questions": [...]}
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const wrapped = o.items ?? o.questions ?? o.data;
    if (Array.isArray(wrapped)) parsed = wrapped;
  }
  if (!Array.isArray(parsed)) {
    return {
      items: [],
      dropped: 0,
      error: "模型返回的不是 JSON 数组（已保留原始输出，可展开查看后重试）。",
    };
  }

  const items: QuestionDraft[] = [];
  let dropped = 0;
  for (const x of parsed) {
    const d = normalizeDraft(x);
    if (!d) {
      dropped += 1;
      continue;
    }
    items.push(d);
    if (items.length >= QUESTIONS_MAX_ITEMS) break;
  }
  if (items.length === 0) {
    return {
      items: [],
      dropped,
      error:
        "没能从模型的输出里解析出任何题目（每道题至少要有 qtype / stem / answer，选择题还要有 2 个以上的 options）。原始输出已保留，可展开查看。",
    };
  }
  return { items, dropped };
}

// ---------------------------------------------------------------------------
// 生成（不写库；结果交给题库页做预览）
// ---------------------------------------------------------------------------

export type QuestionsGenResult =
  | { ok: true; items: QuestionDraft[]; dropped: number; raw: string }
  | { ok: false; error: string; raw: string };

/**
 * 调一次模型出题。走既有的 `chatStream`（BYOK 配置与错误口径都复用它），
 * 只把增量累计成完整文本。**不写库** —— 结果交给题库页做「可勾选可编辑预览」。
 */
export async function generateQuestions(
  cfg: AIConfig,
  input: QuestionGenInput,
): Promise<QuestionsGenResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "尚未配置 API Key：请先到「数据设置」配置后再生成（不会用模板假造题目冒充 AI 生成）。",
      raw: "",
    };
  }

  const messages: ApiMsg[] = [
    { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
    { role: "user", content: buildQuestionsUserPrompt(input) },
  ];

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, QUESTIONS_TIMEOUT_MS);

  let acc = "";
  try {
    acc = await chatStream(cfg, messages, {
      temperature: 0.4,
      signal: ctrl.signal,
      onDelta: (delta) => {
        acc += delta;
        input.onProgress?.(acc.length);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      raw: acc,
      error: timedOut
        ? `生成超时（超过 ${Math.round(QUESTIONS_TIMEOUT_MS / 1000)} 秒）：可稍后重试，或先减少知识点与题量。`
        : `模型调用失败：${msg}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseQuestionsJson(acc);
  if (parsed.error) return { ok: false, error: parsed.error, raw: acc };
  return { ok: true, items: parsed.items, dropped: parsed.dropped, raw: acc };
}

// ---------------------------------------------------------------------------
// 命令封装（桌面走 Rust/SQLite；参数 camelCase，行字段 snake_case）
// 全部走 invokeStrict：**失败会抛**，由数据层接住并交给界面展示，绝不静默。
// 浏览器预览模式不要调这些函数（invokeStrict 会抛"仅桌面版可用"），
// 双环境分派见 `hooks/useQuestions.ts`。
// ---------------------------------------------------------------------------

/** `knowledge_points_list(courseId)` → 行数组（空结果后端返回 `[]`） */
export async function kpList(courseId: number): Promise<KnowledgePointItem[]> {
  const list = await invokeStrict<KnowledgePointItem[]>("knowledge_points_list", { courseId });
  return Array.isArray(list) ? list : [];
}

export interface KpSyncResult {
  /** 本次新建了几个（幂等：已存在的同 `course_id` + `prior_id` 不重复建） */
  created: number;
  /** 该课程现在的知识点总数 */
  total: number;
}

/** `knowledge_points_sync_from_prior(courseId)` → `{created, total}`（**幂等**） */
export async function kpSyncFromPrior(courseId: number): Promise<KpSyncResult> {
  const r = await invokeStrict<{ created?: unknown; total?: unknown }>(
    "knowledge_points_sync_from_prior",
    { courseId },
  );
  const created = Number(r?.created);
  const total = Number(r?.total);
  return {
    created: Number.isFinite(created) ? created : 0,
    total: Number.isFinite(total) ? total : 0,
  };
}

export interface QuestionsListArgs {
  courseId?: number | null;
  kpId?: number | null;
  limit?: number;
}

/** `questions_list(courseId?, kpId?, limit?)` → 列表（含 attempts / last_correct） */
export async function questionsList(args: QuestionsListArgs): Promise<QuestionItem[]> {
  const payload: Record<string, unknown> = {};
  if (args.courseId != null) payload.courseId = args.courseId;
  if (args.kpId != null) payload.kpId = args.kpId;
  if (args.limit != null) payload.limit = args.limit;
  const list = await invokeStrict<QuestionItem[]>("questions_list", payload);
  return Array.isArray(list) ? list : [];
}

/** `question_get(id)` → 全字段（人工校正面板用它拿 options / flawed） */
export async function questionGet(id: number): Promise<QuestionItem> {
  return await invokeStrict<QuestionItem>("question_get", { id });
}

/** 入库一条题目的参数（`options` 传 JSON 字符串或 null） */
export interface QuestionSaveInput {
  kpId?: number | null;
  qtype: QType;
  stem: string;
  options?: string | null;
  answer: string;
  explain?: string | null;
  difficulty?: number | null;
  source: string;
  sourceRef?: string | null;
}

/**
 * `questions_save_batch(courseId, items)` → 新 id 数组。
 * **批量入库**（M3 已因 N 次 IPC 留下 T20 的教训）：调用方必须先用「确认入库」按钮收口。
 */
export async function questionsSaveBatch(
  courseId: number,
  items: QuestionSaveInput[],
): Promise<number[]> {
  const list = await invokeStrict<number[]>("questions_save_batch", { courseId, items });
  return Array.isArray(list) ? list : [];
}

/** `question_update(id, stem?, options?, answer?, explain?, difficulty?, flawed?)` → `()` */
export interface QuestionUpdatePatch {
  stem?: string;
  options?: string | null;
  answer?: string;
  explain?: string | null;
  difficulty?: number | null;
  flawed?: boolean;
}

export async function questionUpdate(id: number, patch: QuestionUpdatePatch): Promise<void> {
  await invokeStrict<void>("question_update", { id, ...patch });
}

/** `question_delete(id)` → `()`（Rust 侧级联删除其 attempts） */
export async function questionDelete(id: number): Promise<void> {
  await invokeStrict<void>("question_delete", { id });
}

export interface PracticePickArgs {
  courseId: number;
  kpId?: number | null;
  count?: number;
}

/** `practice_pick(courseId, kpId?, count?)` → **按弱项优先排序**的题目（排序在 Rust 侧做） */
export async function practicePick(args: PracticePickArgs): Promise<QuestionItem[]> {
  const payload: Record<string, unknown> = { courseId: args.courseId };
  if (args.kpId != null) payload.kpId = args.kpId;
  if (args.count != null) payload.count = args.count;
  const list = await invokeStrict<QuestionItem[]>("practice_pick", payload);
  return Array.isArray(list) ? list : [];
}

export interface AttemptRecordInput {
  questionId: number;
  userAnswer?: string | null;
  /** 客观题：本机判分结果；主观题传 null（由 `selfEval` 决定） */
  correct?: boolean | null;
  /** 主观题自评：1 = 答上来了，0 = 没答上来 */
  selfEval?: number | null;
  /** 从出题到提交的毫秒数（不许为负；Rust 侧会校验） */
  durationMs?: number | null;
  /** 把握程度 1–5，可空（超范围 Rust 侧会报可读错误） */
  confidence?: number | null;
}

/** `attempt_record(...)` → 新 id */
export async function attemptRecord(input: AttemptRecordInput): Promise<number> {
  return await invokeStrict<number>("attempt_record", {
    questionId: input.questionId,
    userAnswer: input.userAnswer ?? null,
    correct: input.correct ?? null,
    selfEval: input.selfEval ?? null,
    durationMs: input.durationMs ?? null,
    confidence: input.confidence ?? null,
  });
}

export interface AttemptsListArgs {
  courseId?: number | null;
  kpId?: number | null;
  /** true = 错题本数据源 */
  onlyWrong?: boolean;
  limit?: number;
}

/** `attempts_list(courseId?, kpId?, onlyWrong?, limit?)` → 作答记录（含题目原文） */
export async function attemptsList(args: AttemptsListArgs): Promise<AttemptItem[]> {
  const payload: Record<string, unknown> = {};
  if (args.courseId != null) payload.courseId = args.courseId;
  if (args.kpId != null) payload.kpId = args.kpId;
  if (args.onlyWrong != null) payload.onlyWrong = args.onlyWrong;
  if (args.limit != null) payload.limit = args.limit;
  const list = await invokeStrict<AttemptItem[]>("attempts_list", payload);
  return Array.isArray(list) ? list : [];
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 毫秒 → 人类可读的用时（作答计时用） */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "未记录";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

/** 一条作答记录是否算「错题」（**只用于浏览器预览模式**；桌面版由 Rust 过滤） */
export function isWrongAttempt(a: AttemptItem): boolean {
  const c = bit(a.correct);
  const s = bit(a.self_eval);
  if (c === 1 || s === 1) return false;
  return c === 0 || s === 0;
}
