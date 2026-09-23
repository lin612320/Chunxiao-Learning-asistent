// R1：**从本课对话提炼先验知识**——本机问答记录 → 素材（按字符预算从最新往前截断）→ 模型
//     → 严格 JSON 数组（两级树）→ 可勾选可编辑预览 → 用户点「确认入库」才写库（`prior_add_tree`）。
//
// 契约：`docs/11-R1对话课程归属与先验知识提炼契约.md`
//   · §一（口径红线）：素材含 AI 自己的回答必须声明；截断必须如实告知；无记录不生成；
//     提炼结果**不自动入库**（生成 → 预览 → 确认三步，沿用 M2 已冻结的管线）。
//   · §2.2 `chat_course_messages` 返回形状（本文件只做**防御性归一化**，不改字段名）。
//   · §2.3 `prior_add_tree(courseId, items, source, sourceRef, confidence)`：
//     `items` 元素字段 snake_case 且与 `PriorDraft` 逐字一致（**零字段转换**）；
//     子项 `parent_topic` 必须**逐字命中本批某个顶层 topic**，否则整批回滚。
//   · §3.4 本组件的流程与口径（含 `source="ai"` / `source_ref="从对话提炼 · 待核对"` / `confidence=0.4`）。
//
// 复用（**不重复实现**）：`./priorgen` 的 `parsePriorJson`（容忍 ```json 围栏与前后废话）、
//   `PriorDraft`（入库结构）、`PRIOR_MAX_ITEMS`（条目上限）、`PRIOR_TIMEOUT_MS`（生成超时）。
// 本文件只负责：素材构建 + 提示词 + 生成 + 入库口径常量 + 预览行的入库映射；**不写库**。

import { chatStream, type AIConfig, type ApiMsg } from "./ai";
import {
  parsePriorJson,
  PRIOR_MAX_ITEMS,
  PRIOR_TIMEOUT_MS,
  type ParsePriorOutcome,
  type PriorDraft,
} from "./priorgen";

// ---------------------------------------------------------------------------
// 口径常量（集中定义；改文案请同步契约 §3.4）
// ---------------------------------------------------------------------------

/** 素材字符预算：按这个预算从**最新往前**纳入消息（契约 §3.4） */
export const PRIOR_FROM_CHAT_BUDGET = 24_000;

/**
 * 单条消息最多纳入多少字：超长消息（整段贴进来的材料 / 长回答）只取前 N 字，
 * 并在界面上**如实计数**（不静默截断）。
 */
export const PRIOR_FROM_CHAT_MAX_MESSAGE_CHARS = 2_000;

/**
 * 一次向本机取回多少条记录：契约 §2.2 的默认值（上限 5000）。
 * 显式传参而不是靠默认值，是为了让界面上的「如实说明」能写出确切的条数上限。
 */
export const PRIOR_FROM_CHAT_FETCH_LIMIT = 2_000;

/** 入库来源（**不新增 source 枚举值**，区分只体现在 source_ref 上） */
export const PRIOR_FROM_CHAT_SOURCE = "ai";

/** 入库出处标注：与 M2 的「AI 生成 · 待核对」区分开，让人一眼看出素材来自对话 */
export const PRIOR_FROM_CHAT_SOURCE_REF = "从对话提炼 · 待核对";

/**
 * 入库置信度 0.4：**低于** M2 纯生成的 0.5 ——
 * 因为本次素材里混着【春晓】自己**未经核实**的回答（契约 §3.4 已拍板，不许改）。
 */
export const PRIOR_FROM_CHAT_CONFIDENCE = 0.4;

/**
 * 入库成功后广播的事件名。
 * 本组件只管生成与入库，**不负责刷新课程页的先验知识列表**；宿主页（`Course.tsx`）若需要
 * 即时刷新，监听这个事件即可（`detail: { courseId, count }`）。沿用既有 CustomEvent 惯例。
 */
export const PRIOR_FROM_CHAT_CHANGED = "chunxiao:prior-from-chat-saved";

// ---------------------------------------------------------------------------
// 本机问答记录（契约 §2.2 的形状）
// ---------------------------------------------------------------------------

export interface ChatCourseMessage {
  session_id: number;
  session_title: string;
  role: string;
  content: string;
  created_at: string;
}

/** `chat_course_messages` 的返回（字段名与契约 §2.2 逐字一致，只做类型声明） */
export interface ChatCourseMessages {
  /** 该课程会话总数（含无消息的） */
  session_count: number;
  /** 其中至少有一条可选消息的会话数 */
  session_count_with_messages: number;
  /** 本次实际返回的消息条数 */
  message_count: number;
  /** 满足条件的总条数（未截断前的） */
  available_count: number;
  /** message_count < available_count 时为 true */
  truncated: boolean;
  messages: ChatCourseMessage[];
}

/**
 * 防御性归一化：字段缺失 / 类型不对时不抛异常，缺什么就退回保守值。
 * 仍然只保留 `role != "system"` 且 `content` 非空的消息（契约 §2.2 的口径，这里再兜一层）。
 */
export function normalizeChatCourseMessages(value: unknown): ChatCourseMessages {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const raw = Array.isArray(o.messages) ? (o.messages as unknown[]) : [];
  const messages: ChatCourseMessage[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const m = x as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "";
    const content = typeof m.content === "string" ? m.content : "";
    if (!role || role === "system") continue;
    if (!content.trim()) continue;
    messages.push({
      session_id: typeof m.session_id === "number" ? m.session_id : -1,
      session_title: typeof m.session_title === "string" ? m.session_title : "",
      role,
      content,
      created_at: typeof m.created_at === "string" ? m.created_at : "",
    });
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    session_count: num(o.session_count, 0),
    session_count_with_messages: num(o.session_count_with_messages, 0),
    message_count: num(o.message_count, messages.length),
    available_count: num(o.available_count, messages.length),
    truncated: o.truncated === true,
    messages,
  };
}

/** 该课程一个可选的问答记录都没有（后端不返回 null，这里只判数组） */
export function hasNoChatMessages(m: ChatCourseMessages): boolean {
  return m.messages.length === 0;
}

// ---------------------------------------------------------------------------
// 素材构建（按字符预算从最新往前纳入；截断必须如实计数）
// ---------------------------------------------------------------------------

/** 素材的统计口径：界面上的「如实说明」全部取自这里，不另算一份 */
export interface ChatMaterialStats {
  /** 本次实际纳入素材（发给模型）的消息条数 */
  usedCount: number;
  /** 本次从本机一次取回的消息条数 */
  totalCount: number;
  /** 这门课符合条件的消息总条数（取 `available_count`，取不到时退回 totalCount） */
  availableCount: number;
  /** 本机单次取回有上限 → 更早的记录根本没取回来 */
  sourceTruncated: boolean;
  /** 因为超出字符预算被丢掉的条数（越早的越先丢） */
  droppedByBudget: number;
  /** 因为单条过长被截断字数的条数 */
  trimmedByLength: number;
  /** 素材正文的实际字符数（含逐条的编号行） */
  usedChars: number;
  /** 素材覆盖了几个会话 */
  sessionCount: number;
  /** 素材里最早 / 最新一条的时间（没有则 null） */
  firstAt: string | null;
  lastAt: string | null;
}

export interface ChatMaterial {
  /** 拼好的素材正文（逐条编号，供提示词直接拼接） */
  body: string;
  stats: ChatMaterialStats;
}

/**
 * 把问答记录拼成给模型看的素材。
 * **从最新往前**纳入（契约 §一.6）：先放最新的，装不下就停，丢掉的是更早的。
 * 只整条纳入；单条超过 `maxPerMessage` 时按前 N 字截断并计数（不静默）。
 */
export function buildPriorFromChatMaterial(
  messages: ChatCourseMessage[],
  budget: number = PRIOR_FROM_CHAT_BUDGET,
  maxPerMessage: number = PRIOR_FROM_CHAT_MAX_MESSAGE_CHARS,
): ChatMaterial {
  const usable = (Array.isArray(messages) ? messages : []).filter(
    (m) => m.role !== "system" && (m.content ?? "").trim().length > 0,
  );
  const totalCount = usable.length;

  const picked: ChatCourseMessage[] = [];
  let usedChars = 0;
  let droppedByBudget = 0;
  let trimmedByLength = 0;

  for (let i = totalCount - 1; i >= 0; i--) {
    const m = usable[i];
    let content = m.content.trim();
    if (content.length > maxPerMessage) {
      content = content.slice(0, maxPerMessage);
      trimmedByLength += 1;
    }
    // 60 字是编号行（编号 / 角色 / 时间 / 会话名）的粗估，宁可高估，别把预算撑破
    const cost = content.length + 60;
    // picked 为空时无论如何纳入一条：`maxPerMessage` 远小于 `budget`，正常不会触发
    if (usedChars + cost > budget && picked.length > 0) {
      droppedByBudget = i + 1;
      break;
    }
    picked.unshift({ ...m, content });
    usedChars += cost;
  }

  const lines: string[] = [];
  picked.forEach((m, idx) => {
    const who = m.role === "assistant" ? "春晓（AI 回答，未经核实）" : "用户";
    const at = m.created_at.trim() || "时间未记录";
    const se = m.session_title.trim();
    lines.push(`【${idx + 1}】${who}（${at}${se ? ` · 会话「${se}」` : ""}）`);
    lines.push(m.content);
    lines.push("");
  });

  return {
    body: lines.join("\n").trim(),
    stats: {
      usedCount: picked.length,
      totalCount,
      availableCount: totalCount,
      sourceTruncated: false,
      droppedByBudget,
      trimmedByLength,
      usedChars,
      sessionCount: new Set(picked.map((m) => m.session_id)).size,
      firstAt: picked.length > 0 ? picked[0].created_at.trim() || null : null,
      lastAt: picked.length > 0 ? picked[picked.length - 1].created_at.trim() || null : null,
    },
  };
}

/** 把后端返回的条数口径合并进统计（`available_count` / `truncated` 由本机给出，比本地推算准） */
export function withSourceCounts(material: ChatMaterial, source: ChatCourseMessages): ChatMaterial {
  const available = Math.max(
    source.available_count,
    source.message_count,
    material.stats.totalCount,
  );
  return {
    body: material.body,
    stats: {
      ...material.stats,
      availableCount: available,
      sourceTruncated: available > material.stats.totalCount,
    },
  };
}

/**
 * 界面上的**如实说明**（契约 §一.6）：用了多少条、共多少条、是否截断、有没有单条被截断。
 * 未截断就明说「本次未截断」，不含糊。
 */
export function describeChatMaterial(stats: ChatMaterialStats): string {
  const parts: string[] = [];
  if (stats.droppedByBudget > 0) {
    parts.push(
      `本次用了 ${stats.usedCount} 条（这门课共 ${stats.availableCount} 条，已按 ${PRIOR_FROM_CHAT_BUDGET} 字预算截断为最近的 ${stats.usedCount} 条，更早的 ${stats.droppedByBudget} 条未纳入）`,
    );
  } else if (stats.sourceTruncated) {
    parts.push(
      `本次用了 ${stats.usedCount} 条（这门课共 ${stats.availableCount} 条，本机单次最多取回 ${PRIOR_FROM_CHAT_FETCH_LIMIT} 条，更早的记录未纳入本次素材）`,
    );
  } else {
    parts.push(`本次用了 ${stats.usedCount} 条（这门课共 ${stats.availableCount} 条，本次未截断，全部纳入）`);
  }
  if (stats.trimmedByLength > 0) {
    parts.push(`其中 ${stats.trimmedByLength} 条过长，已各截断到 ${PRIOR_FROM_CHAT_MAX_MESSAGE_CHARS} 字`);
  }
  if (stats.sessionCount > 0) parts.push(`来自 ${stats.sessionCount} 个会话`);
  return parts.join("；") + "。";
}

// ---------------------------------------------------------------------------
// 提示词（口径写死在这里，改文案请同步契约 §一.5 / §3.4）
// ---------------------------------------------------------------------------

/** 系统提示词：严格 JSON 数组 + 两级树 + 免责声明 + 禁止编造 + 存疑标注 + 不押题 */
export const PRIOR_FROM_CHAT_SYSTEM_PROMPT = [
  "你是「春晓」——面向大学生的本地单机学习助手，正在把用户**这门课的问答记录**提炼成课后复习用的先验知识骨架。",
  "",
  "素材说明（必须当真）：",
  "1. 以下对话中【春晓】的回答**也是 AI 生成的、未经核实**，不得当作事实依据；只能把它当作「用户问过这个主题」的线索，不能当作知识本身的出处。",
  "2. 用户的提问也可能写错、记错。素材里明显有问题的地方，不要当成知识写进骨架。",
  "3. 提炼的是「这次对话里真正问过什么」，不要套一份通用教材目录。",
  "",
  "输出要求（必须严格遵守）：",
  "1. 只输出**一个严格的 JSON 数组**，不要输出任何解释、前言、后记或 Markdown 说明；不要用代码围栏。",
  '2. 数组每一项形如：{"topic": "知识点名称", "summary": "一句话说明", "detail": "更详细的说明", "parent_topic": "所属章节的 topic 或 null"}。',
  "3. **两级树**：顶层项 = 章节（parent_topic 为 null）；其余项 = 章节下的知识点，其 parent_topic 必须**逐字等于**某个顶层项的 topic。",
  '4. **禁止编造具体数据、条文、页码、引用、人名、文献**：不要写"见第 x 页""教材第 x 章""根据某某论文""公式中系数为 x.xx"。只输出概念、定义、关系与方法思路这类不依赖具体出处的内容。',
  "5. **不确定的内容必须显式标注存疑**：凡是从对话里没问清、前后矛盾、或你本身没有把握的，一律在该条的 summary 或 detail 里写明「待确认」并说明不确定的原因；不要把猜测用肯定的语气写成结论。",
  "6. 不输出考试押题、真题、答案速出式内容；这是课后复习用的知识骨架，不是考试工具。",
  "7. 用中文；topic 简明（不超过 20 字），summary 一句话（不超过 60 字），detail 不超过 200 字。",
  "8. 条目总数控制在 6–16 条（含章节）；宁可少而准，不要为凑数编条目。",
].join("\n");

/** 用户提示词：课程名 + 素材统计（如实说明）+ 问答记录正文 */
export function buildPriorFromChatUserPrompt(courseName: string, material: ChatMaterial): string {
  return [
    `课程名称：${courseName.trim() || "（未填写）"}`,
    "",
    "本机统计（只是告诉你这批素材的来路，不要复述进输出）：",
    describeChatMaterial(material.stats),
    "",
    "以下是这门课的问答记录（按时间从早到晚，最新的在最后）：",
    material.body,
    "",
    "请按上面的要求，只依据这份问答记录输出 JSON 数组：",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 生成（只产出草稿，**不写库**）
// ---------------------------------------------------------------------------

export interface PriorFromChatInput {
  courseName: string;
  material: ChatMaterial;
  /** 流式进度回调（已收到多少字），仅用于界面提示 */
  onProgress?: (chars: number) => void;
}

export type PriorFromChatResult =
  | { ok: true; items: PriorDraft[]; raw: string }
  | { ok: false; error: string; raw: string };

/**
 * 调一次模型，从问答记录里提炼知识骨架。
 * 走既有的 `chatStream`（BYOK 配置与错误口径都复用它），只把增量累计成完整文本；
 * 解析复用 `parsePriorJson`。**不写库** —— 结果交给组件做预览。
 */
export async function generatePriorFromChat(
  cfg: AIConfig,
  input: PriorFromChatInput,
): Promise<PriorFromChatResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "尚未配置 API Key：请先到「数据设置」配置后再提炼（不会用模板假造一份知识骨架）。",
      raw: "",
    };
  }

  const messages: ApiMsg[] = [
    { role: "system", content: PRIOR_FROM_CHAT_SYSTEM_PROMPT },
    { role: "user", content: buildPriorFromChatUserPrompt(input.courseName, input.material) },
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
        ? `提炼超时（超过 ${Math.round(PRIOR_TIMEOUT_MS / 1000)} 秒）：可稍后重试。`
        : `模型调用失败：${msg}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed: ParsePriorOutcome = parsePriorJson(acc);
  if (parsed.error) return { ok: false, error: parsed.error, raw: acc };
  return { ok: true, items: parsed.items.slice(0, PRIOR_MAX_ITEMS), raw: acc };
}

// ---------------------------------------------------------------------------
// 预览行 → `prior_add_tree` 的 items（字段与 PriorDraft 逐字一致：零字段转换）
// ---------------------------------------------------------------------------

/** 预览行：字段与 `PriorDraft` 逐字一致，另加勾选状态与一个稳定的 key */
export interface PriorFromChatRow extends PriorDraft {
  key: string;
  checked: boolean;
}

/** 预览顺序：章节在前，其子项紧随其后（缩进展示）；父项缺失的兜底成顶层，绝不丢条目 */
export function orderPriorFromChatRows(
  rows: PriorFromChatRow[],
): Array<{ row: PriorFromChatRow; depth: number; parentMissing: boolean }> {
  const out: Array<{ row: PriorFromChatRow; depth: number; parentMissing: boolean }> = [];
  const tops = rows.filter((r) => !r.parent_topic);
  const used = new Set<string>();
  for (const top of tops) {
    out.push({ row: top, depth: 0, parentMissing: false });
    used.add(top.key);
    for (const child of rows.filter((r) => r.parent_topic === top.topic)) {
      out.push({ row: child, depth: 1, parentMissing: !top.checked });
      used.add(child.key);
    }
  }
  // 兜底：parent_topic 指向子项、指向的章节已改名或被勾掉 → 按顶层展示并标出来
  for (const r of rows) {
    if (used.has(r.key)) continue;
    out.push({ row: r, depth: 0, parentMissing: false });
  }
  return out;
}

export interface BuildTreeResult {
  /** 直接交给 `prior_add_tree` 的 items（snake_case，与 PriorDraft 逐字一致） */
  items: PriorDraft[];
  /** 子项的所属章节没被勾选 / 名称已被改掉 → 本批里按顶层入库（否则整批会被回滚） */
  reparented: Array<{ topic: string; parent_topic: string }>;
  /** 勾选了、但名称为空而被丢掉的条数 */
  skipped: number;
}

/**
 * 预览行 → 入库 items。
 * · 先章节后子项（`prior_add_tree` 自己也在 Rust 侧先插顶层，这里保持同样的顺序，便于人读日志）；
 * · `parent_topic` 只保留**逐字命中本批某个顶层 topic** 的；命中不了就置 null 并在 `reparented`
 *   里如实报告 —— 因为契约 §2.3 规定命中不了会**整批回滚**，不能把这种失败甩给用户。
 */
export function buildPriorAddTreeItems(rows: PriorFromChatRow[]): BuildTreeResult {
  const picked = rows.filter((r) => r.checked && r.topic.trim().length > 0);
  const skipped = rows.filter((r) => r.checked && r.topic.trim().length === 0).length;

  const tops = picked.filter((r) => !(r.parent_topic ?? "").trim());
  const subs = picked.filter((r) => !!(r.parent_topic ?? "").trim());
  const topTopics = new Set(tops.map((r) => r.topic.trim()));

  const items: PriorDraft[] = [];
  const reparented: Array<{ topic: string; parent_topic: string }> = [];

  for (const r of tops) {
    items.push({
      topic: r.topic.trim(),
      summary: r.summary.trim(),
      detail: r.detail.trim(),
      parent_topic: null,
    });
  }
  for (const r of subs) {
    const topic = r.topic.trim();
    const parent = (r.parent_topic ?? "").trim();
    if (topTopics.has(parent)) {
      items.push({ topic, summary: r.summary.trim(), detail: r.detail.trim(), parent_topic: parent });
    } else {
      items.push({ topic, summary: r.summary.trim(), detail: r.detail.trim(), parent_topic: null });
      reparented.push({ topic, parent_topic: parent });
    }
  }

  return { items, reparented, skipped };
}

// ---------------------------------------------------------------------------
// 入库前的「结构会变化」警告文案（**事前知情**：不静默改变用户看到的内容）
// ---------------------------------------------------------------------------

/** 警告里列条目名时的截断规则：超过 16 字截成「前 16 字 + …」 */
export const PRIOR_FROM_CHAT_NAME_CLIP = 16;

/** 警告最多列几个条目名（多出来的用「等 N 条」收尾，避免警告被长列表撑爆） */
export const PRIOR_FROM_CHAT_WARN_MAX_NAMES = 5;

export function clipPriorTopicForWarning(topic: string): string {
  const t = (topic ?? "").trim();
  return t.length > PRIOR_FROM_CHAT_NAME_CLIP ? `${t.slice(0, PRIOR_FROM_CHAT_NAME_CLIP)}…` : t;
}

/** `「A」、「B」 等 7 条` —— 超过 `max` 个时只列前 `max` 个，并带上**总数** */
export function listPriorTopicNamesForWarning(
  topics: string[],
  max: number = PRIOR_FROM_CHAT_WARN_MAX_NAMES,
): string {
  const shown = topics.slice(0, max).map((t) => `「${clipPriorTopicForWarning(t)}」`);
  const more = topics.length - shown.length;
  return shown.join("、") + (more > 0 ? ` 等 ${topics.length} 条` : "");
}

/** 警告文案：`text` 是**完整句子**（便于逐字核对），`strong` 是其中要加粗强调的片段 */
export interface PriorFromChatWarning {
  /** 受影响的条数 */
  count: number;
  /** 完整句子（纯文本，界面按 `strong` 切一刀渲染成三个文本节点，不拼 HTML） */
  text: string;
  /** `text` 的子串：加粗显示的那一段 */
  strong: string;
}

/**
 * 子项的所属章节没被勾选 / 名称已被改 → 本批里按顶层入库。
 * 这会在**点「确认入库」之前**显示（渲染期就能算出来），让用户先决定是改勾选还是照此入库；
 * 入库成功后的 notice 里也会再说明一次。
 */
export function describeReparentedWarning(
  reparented: Array<{ topic: string; parent_topic: string }>,
): PriorFromChatWarning | null {
  if (reparented.length === 0) return null;
  const strong = "作为最外层的一条";
  const names = listPriorTopicNamesForWarning(reparented.map((r) => r.topic));
  return {
    count: reparented.length,
    strong,
    text:
      `有 ${reparented.length} 条下属知识的所属章节没勾选、或名称被改过，保存后会${strong}` +
      `（其余条目不受影响）。受影响：${names}。`,
  };
}

/** 勾选了、但知识点名称为空的条目会在入库时被跳过 —— 同样**事前**说清 */
export function describeSkippedWarning(skipped: number): PriorFromChatWarning | null {
  if (skipped <= 0) return null;
  const strong = "会被跳过";
  return {
    count: skipped,
    strong,
    text: `有 ${skipped} 条已勾选的内容知识点名称为空，保存时${strong}（其余条目不受影响）。`,
  };
}
