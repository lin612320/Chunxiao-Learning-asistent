// M2 先验知识 AI 生成：生成 → **预览（可勾选 / 可编辑）** → 用户确认 → 入库。
//
// 契约：`docs/05-M2契约.md` §三；产品红线：`docs/00-可行性评估.md` §7.3
//   · 提示词只喂「课程名 + 课程简介 + 已导入材料的**文件名与 heading 列表**」（弱提示），
//     **绝不塞材料全文**；
//   · 要求模型输出**严格 JSON 数组**（两级树：顶层=章节，子项用 parent_topic 指向章节）；
//     **明令禁止编造具体数据 / 条文 / 页码 / 引用**；
//   · 解析容错：容忍 ```json 围栏与前后废话；解析失败要给**可读中文错误**并保留原始输出；
//   · 本文件**只负责生成与解析**，入库（`prior_add`）由课程页在用户点「确认入库」后执行 ——
//     严禁一键直接灌库。

import { chatStream, type AIConfig, type ApiMsg } from "./ai";

/** 生成出来的一条（入库前的草稿） */
export interface PriorDraft {
  topic: string;
  summary: string;
  detail: string;
  parent_topic: string | null;
}

/** 弱提示：已导入材料的文件名 + 本地抽出的 heading 列表（不含正文） */
export interface PriorMaterialHint {
  names: string[];
  headings: string[];
}

export interface PriorGenInput {
  courseName: string;
  intro?: string | null;
  materials?: PriorMaterialHint;
  /** 流式进度回调（已收到多少字），仅用于界面提示 */
  onProgress?: (chars: number) => void;
}

export type PriorGenResult =
  | { ok: true; items: PriorDraft[]; raw: string }
  | { ok: false; error: string; raw: string };

/** 入库时的固定口径（契约 §3.1：source 必填、低置信、来源标注；不传 verified → 默认待核对） */
export const PRIOR_SOURCE = "ai";
export const PRIOR_SOURCE_REF = "AI 生成 · 待核对";
export const PRIOR_CONFIDENCE = 0.5;

/** 生成超时（与视觉转录同量级，防止界面卡死） */
export const PRIOR_TIMEOUT_MS = 180_000;

/** 一次最多接受多少条（防止模型刷出几百条把界面撑爆） */
export const PRIOR_MAX_ITEMS = 40;

/** 系统提示词：口径写死在这里，改文案请同步契约 §三 */
export const PRIOR_SYSTEM_PROMPT = [
  "你是「春晓」——面向大学生的本地单机学习助手，正在帮用户为**课后复习**搭建一门课的知识骨架。",
  "",
  "输出要求（必须严格遵守）：",
  "1. 只输出**一个严格的 JSON 数组**，不要输出任何解释、前言、后记或 Markdown 说明；不要用代码围栏。",
  '2. 数组每一项形如：{"topic": "知识点名称", "summary": "一句话说明", "detail": "更详细的说明", "parent_topic": "所属章节的 topic 或 null"}。',
  "3. **两级树**：顶层项 = 章节（parent_topic 为 null）；其余项 = 章节下的知识点，其 parent_topic 必须**逐字等于**某个顶层项的 topic。",
  '4. **禁止编造具体数据、条文、页码、引用、人名、文献**：不要写"见第 x 页""教材第 x 章""根据某某论文""公式中系数为 x.xx"。只输出概念、定义、关系与方法思路这类不依赖具体出处的内容。',
  "5. 不要输出考试押题、真题、答案速出式内容；这是课后复习用的知识骨架，不是考试工具。",
  "6. 用中文；topic 简明（不超过 20 字），summary 一句话（不超过 60 字），detail 不超过 200 字。",
  "7. 条目总数控制在 6–16 条（含章节）。",
].join("\n");

/** 用户提示词：只带课程名 / 简介 / 材料文件名与标题，**不带材料正文** */
export function buildPriorUserPrompt(input: PriorGenInput): string {
  const names = (input.materials?.names ?? []).filter((n) => n.trim().length > 0).slice(0, 30);
  const headings = (input.materials?.headings ?? []).filter((h) => h.trim().length > 0).slice(0, 60);

  const lines: string[] = [
    `课程名称：${input.courseName.trim() || "（未填写）"}`,
    `课程简介：${(input.intro ?? "").trim() || "（未填写）"}`,
    "",
  ];

  if (names.length === 0 && headings.length === 0) {
    lines.push("这门课还没有导入任何材料：请只依据课程名称与简介给出通用的知识骨架。");
  } else {
    lines.push(
      "已导入材料（**只是弱提示**，帮助你贴合这门课的实际内容；标题不等于知识本身，也不要在输出里点名引用它们）：",
    );
    if (names.length > 0) lines.push(`文件名：${names.join("；")}`);
    if (headings.length > 0) {
      lines.push("标题行（由本机从材料里抽出的标题，仅供对齐章节层级）：");
      for (const h of headings) lines.push(`- ${h}`);
    }
  }

  lines.push("", "请按上面的要求输出 JSON 数组：");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 本地抽 heading（只送标题行，不送全文）
// ---------------------------------------------------------------------------

const HEADING_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/, // markdown 标题
  /^第\s*[0-9一二三四五六七八九十百零]+\s*[章节讲篇部课]/, // 第 3 章 / 第二节
  /^[一二三四五六七八九十]+\s*[、.．]/, // 一、二、
  /^\d+(\.\d+)*\s*[、.．]?\s*\S/, // 1.2 标题 / 1、标题
  /^(chapter|section|unit|lecture)\s*\d+/i,
];

/**
 * 从材料文本里抽"像标题"的行（本地纯函数，断网可用）。
 * 只保留 2–40 字、不以句末标点结尾的行 —— 目的是给模型一个章节层级的弱提示，
 * **不是**把正文喂给模型。
 */
export function extractHeadings(text: string, max = 40): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 2 || line.length > 40) continue;
    if (/[。；，,;]$/.test(line)) continue;
    if (!HEADING_PATTERNS.some((re) => re.test(line))) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.replace(/^#{1,6}\s+/, "").trim());
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 解析（容错 + 可读中文错误）
// ---------------------------------------------------------------------------

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeDraft(x: unknown): PriorDraft | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const topic = asText(o.topic);
  if (!topic) return null;
  // 容忍模型写成 camelCase 的 parentTopic
  const parentRaw = o.parent_topic ?? o.parentTopic;
  const parent = asText(parentRaw);
  return {
    topic,
    summary: asText(o.summary),
    detail: asText(o.detail),
    parent_topic: parent || null,
  };
}

/** 依次尝试几个候选片段：去围栏后的整体 → 首个 `[` 到末个 `]` 之间 */
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

export interface ParsePriorOutcome {
  items: PriorDraft[];
  error?: string;
}

/**
 * 把模型输出解析成草稿数组。
 * 解析失败**不静默**：返回可读中文错误（调用方把原始输出展示给用户）。
 */
export function parsePriorJson(raw: string): ParsePriorOutcome {
  const s = (raw ?? "").trim();
  if (!s) return { items: [], error: "模型没有返回任何内容（可能是空回复或被截断）。" };

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
      error: "模型返回的内容不是合法 JSON（已保留原始输出，可展开查看后重试）。",
    };
  }

  // 少数模型会包一层 {"items": [...]}
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const wrapped = (parsed as Record<string, unknown>).items ?? (parsed as Record<string, unknown>).data;
    if (Array.isArray(wrapped)) parsed = wrapped;
  }
  if (!Array.isArray(parsed)) {
    return {
      items: [],
      error: "模型返回的不是 JSON 数组（已保留原始输出，可展开查看后重试）。",
    };
  }

  const items: PriorDraft[] = [];
  const seen = new Set<string>();
  for (const x of parsed) {
    const d = normalizeDraft(x);
    if (!d) continue;
    const key = d.topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(d);
    if (items.length >= PRIOR_MAX_ITEMS) break;
  }
  if (items.length === 0) {
    return {
      items: [],
      error: "没能从模型的输出里解析出任何条目（每条至少要有 topic 字段）。原始输出已保留，可展开查看。",
    };
  }
  // 清掉指向不存在的章节的 parent_topic（避免入库时挂到不存在的父项）
  const topics = new Set(items.map((d) => d.topic));
  for (const d of items) {
    if (d.parent_topic && !topics.has(d.parent_topic)) d.parent_topic = null;
  }
  return { items };
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/**
 * 调一次模型生成知识骨架。
 * 走既有的 `chatStream`（BYOK 配置与错误口径都复用它），只把增量累计成完整文本。
 * **不写库** —— 结果交给课程页做预览。
 */
export async function generatePriorSkeleton(
  cfg: AIConfig,
  input: PriorGenInput,
): Promise<PriorGenResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "尚未配置 API Key：请先到「数据设置」配置后再生成（不会用模板假造一份知识骨架）。",
      raw: "",
    };
  }

  const messages: ApiMsg[] = [
    { role: "system", content: PRIOR_SYSTEM_PROMPT },
    { role: "user", content: buildPriorUserPrompt(input) },
  ];

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, PRIOR_TIMEOUT_MS);

  let acc = "";
  try {
    acc = await chatStream(cfg, messages, {
      temperature: 0.3,
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
        ? `生成超时（超过 ${Math.round(PRIOR_TIMEOUT_MS / 1000)} 秒）：可稍后重试，或先减少材料数量。`
        : `模型调用失败：${msg}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parsePriorJson(acc);
  if (parsed.error) return { ok: false, error: parsed.error, raw: acc };
  return { ok: true, items: parsed.items, raw: acc };
}
