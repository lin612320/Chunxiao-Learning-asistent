// M3 笔记与批注：命令封装 + 生成提示词 + 导出工具 + **锚点自愈**（纯函数）。
//
// 契约：`docs/07-M3契约.md` §三（批注锚点与自愈）/ §4.1（笔记页）/ §一（T2 渲染器）
//   · 参数 **camelCase**（`courseId` / `targetKind` / `blockIndex` / `startOff` / `endOff` /
//     `contentMd` / `sessionId`）；DB 行返回字段 **snake_case**（`content_md` / `created_at` /
//     `block_index` / `start_off` / `content_len`）；空列表是 `[]`，不是 null。
//   · 写入类操作一律 `invokeStrict`（失败必须可见）；读取类在桌面走命令、`!isTauri()` 走示例数据。
//   · 产品红线：AI 整理的笔记标 `source='ai_session'` + 「待核对」且**不自动入库**；
//     无当天问答记录时如实提示，**不用模板冒充 AI 整理**；不面向考试。
//
// 批注锚点 = `block_index`（块序号）+ `start_off`/`end_off`（**块内纯文本**字符偏移）+ `quote`。
// 渲染前必须走 `resolveAnnotations()` 自愈：位置对不上就重新定位并标「位置已自动修正」，
// 全文都找不到就归入「已失效的批注」——**绝不假装它还在原位**。

import { chatStream, type AIConfig, type ApiMsg } from "./ai";
import { invokeStrict, isTauri } from "./tauri";
import { loadSampleDb, type NoteItem } from "../data/sample";
import { blockPlainTexts, type MdMark } from "./markdown";

// ---------------------------------------------------------------------------
// 类型与常量（字段名与 SQL 列名逐字一致）
// ---------------------------------------------------------------------------

/** 笔记来源：`ai_session`（AI 依据某次对话整理）/ `user`（用户自己写的） */
export type NoteSource = "ai_session" | "user";

/** 批注挂载对象类型（后端 `target_kind`） */
export const NOTE_TARGET_KIND = "note";

/** 批注可选颜色（与 markdown.tsx 的 `md-mark-*` 一致） */
export const ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;

export const COLOR_LABEL: Record<string, string> = {
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  pink: "粉",
  purple: "紫",
};

/** `notes_list` 的一行（**不含全文**，全文走 `note_get`） */
export interface NoteRow {
  id: number;
  course_id: number;
  session_id?: number | null;
  title: string;
  date?: string | null;
  /** 最近一次导出的文件绝对路径（null = 未导出） */
  exported?: string | null;
  source: string;
  created_at: string;
  /** 正文字符数（Rust 侧 `length(content_md)`） */
  content_len: number;
}

/** `note_get` 的返回：多一个 `content_md` 全文 */
export interface NoteDetail extends NoteRow {
  content_md: string;
}

/** `annotations_list` 的一行（锚点三件套都允许为 null —— 旧数据没有块序号） */
export interface AnnotationRow {
  id: number;
  target_kind: string;
  target_id: number;
  block_index?: number | null;
  quote?: string | null;
  start_off?: number | null;
  end_off?: number | null;
  color?: string | null;
  comment?: string | null;
  created_at: string;
}

/** 来源徽标口径（列表与详情共用；AI 整理的内容一律标「待核对」） */
export function noteSourceInfo(source: string): { text: string; cls: string; ai: boolean } {
  if ((source ?? "").trim() === "ai_session") {
    return { text: "AI 整理 · 待核对", cls: "src-badge src-ai", ai: true };
  }
  return { text: "自己写的", cls: "src-badge src-user", ai: false };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 本地日期 `YYYY-MM-DD`（与 Rust `note_save` 的默认口径一致：本地时间，不用 UTC 切） */
export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 从时间戳里取本地日期前缀。
 * `created_at` 在本项目里可能是 `YYYY-MM-DD HH:mm`（前端 chat_history_save 写的）
 * 也可能是 RFC3339（后端其它写入路径），两者的前 10 位都是日期 → 统一取前缀，避免时区二次换算。
 */
export function dayOf(ts: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((ts ?? "").trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 读取（桌面走命令 / 预览走示例数据）
// ---------------------------------------------------------------------------

function noteRowOf(n: NoteItem): NoteRow {
  return {
    id: n.id,
    course_id: n.course_id,
    session_id: n.session_id ?? null,
    title: n.title,
    date: n.date ?? null,
    exported: n.exported ?? null,
    source: n.source,
    created_at: n.created_at,
    content_len: n.content_md.length,
  };
}

/** 笔记列表（`courseId` 传 null = 全部课程） */
export async function notesList(courseId: number | null): Promise<NoteRow[]> {
  if (!isTauri()) {
    const db = loadSampleDb();
    const rows = courseId == null ? db.notes : db.notes.filter((n) => n.course_id === courseId);
    return rows.map(noteRowOf).sort((a, b) => b.id - a.id);
  }
  const list = await invokeStrict<NoteRow[]>(
    "notes_list",
    courseId == null ? undefined : { courseId },
  );
  return Array.isArray(list) ? list : [];
}

/** 笔记详情（含 Markdown 全文） */
export async function noteGet(id: number): Promise<NoteDetail> {
  if (!isTauri()) {
    const n = loadSampleDb().notes.find((x) => x.id === id);
    if (!n) throw new Error(`笔记不存在（id=${id}），可能已被删除；请刷新页面后重试。`);
    return { ...noteRowOf(n), content_md: n.content_md };
  }
  return await invokeStrict<NoteDetail>("note_get", { id });
}

/** 某条笔记的批注列表（后端已按「块序号 → 块内起点 → id」排序） */
export async function annotationsList(noteId: number): Promise<AnnotationRow[]> {
  if (!isTauri()) {
    return loadSampleDb()
      .annotations.filter((a) => a.target_kind === NOTE_TARGET_KIND && a.target_id === noteId)
      .map((a) => ({ ...a }));
  }
  const list = await invokeStrict<AnnotationRow[]>("annotations_list", {
    targetKind: NOTE_TARGET_KIND,
    targetId: noteId,
  });
  return Array.isArray(list) ? list : [];
}

// ---------------------------------------------------------------------------
// 写入（一律 invokeStrict；浏览器预览模式下会抛出「仅桌面版可用」的可读错误）
// ---------------------------------------------------------------------------

export interface NoteSaveInput {
  courseId: number;
  sessionId?: number | null;
  title: string;
  contentMd: string;
  /** 不传 = 由后端按本地日期填 */
  date?: string | null;
  source: NoteSource;
}

/** 新建笔记，返回新 id。空标题 / 空正文在前端就拦下（给更早的可读提示） */
export async function noteSave(input: NoteSaveInput): Promise<number> {
  const title = input.title.trim();
  if (!title) throw new Error("笔记标题不能为空。");
  if (!input.contentMd.trim()) throw new Error("笔记正文不能为空。");
  return await invokeStrict<number>("note_save", {
    courseId: input.courseId,
    sessionId: input.sessionId ?? null,
    title,
    contentMd: input.contentMd,
    date: input.date ?? null,
    source: input.source,
  });
}

/** 局部更新标题 / 正文（改不了来源与导出记录：那是"内容怎么来的"这一事实） */
export async function noteUpdate(
  id: number,
  patch: { title?: string; contentMd?: string },
): Promise<void> {
  const args: Record<string, unknown> = { id };
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new Error("笔记标题不能为空。");
    args.title = t;
  }
  if (patch.contentMd !== undefined) args.contentMd = patch.contentMd;
  await invokeStrict<void>("note_update", args);
}

export async function noteDelete(id: number): Promise<void> {
  await invokeStrict<void>("note_delete", { id });
}

/**
 * 导出 .docx（Rust 本机生成，不联网）。
 * ⚠ `dir` 为空时后端会返回「请先选择导出目录。」—— 这是**如实**的失败，前端据此提示用户填目录。
 */
export async function noteExportDocx(id: number, dir: string): Promise<string> {
  return await invokeStrict<string>("note_export_docx", { id, dir: dir.trim() });
}

export interface AnnotationAddInput {
  targetId: number;
  blockIndex: number;
  quote: string;
  startOff: number;
  endOff: number;
  color?: string | null;
  comment?: string | null;
}

export async function annotationAdd(input: AnnotationAddInput): Promise<number> {
  return await invokeStrict<number>("annotation_add", {
    targetKind: NOTE_TARGET_KIND,
    targetId: input.targetId,
    blockIndex: input.blockIndex,
    quote: input.quote,
    startOff: input.startOff,
    endOff: input.endOff,
    color: input.color ?? null,
    comment: input.comment ?? null,
  });
}

export async function annotationUpdate(
  id: number,
  patch: { color?: string; comment?: string },
): Promise<void> {
  const args: Record<string, unknown> = { id };
  if (patch.color !== undefined) args.color = patch.color;
  if (patch.comment !== undefined) args.comment = patch.comment;
  await invokeStrict<void>("annotation_update", args);
}

export async function annotationDelete(id: number): Promise<void> {
  await invokeStrict<void>("annotation_delete", { id });
}

// ---------------------------------------------------------------------------
// 锚点自愈（契约 §三）—— 纯函数，可在预览模式下完整验证
// ---------------------------------------------------------------------------

export interface ResolvedAnnotation {
  row: AnnotationRow;
  /** 定位到的块序号；**-1 = 已失效**（全文都找不到 quote） */
  blockIndex: number;
  start: number;
  end: number;
  /** true = 原位置对不上，靠搜索重新定位过（界面必须标「位置已自动修正」） */
  healed: boolean;
}

/** 忽略空白后的文本 + 每个字符在原串里的下标（用于把"去空白匹配"映射回真实偏移） */
function normWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (/\s/.test(ch)) continue;
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

/**
 * 在 `text` 里找 `quote`：先精确匹配；找不到再去掉空白匹配（Markdown 重排常只改动换行与空格，
 * 精确匹配会失败但内容其实还在）。返回的是**原串上的** `[start, end)`。
 */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  if (!text || !quote) return null;
  const i = text.indexOf(quote);
  if (i >= 0) return { start: i, end: i + quote.length };

  const nt = normWithMap(text);
  const nq = quote.replace(/\s+/g, "");
  if (!nq) return null;
  const j = nt.norm.indexOf(nq);
  if (j < 0) return null;
  return { start: nt.map[j], end: nt.map[j + nq.length - 1] + 1 };
}

/**
 * 逐条解析批注锚点（契约 §三 的三步）：
 *   ① 按 `block_index` + 偏移取文本，与 `quote` 比对 → 一致就直接用；
 *   ② 不一致 → 先在该块内搜索 `quote`，再**退化为全文**搜索（优先靠近原块序号的块）→ 找到则
 *      `healed = true`（界面标「位置已自动修正」）；
 *   ③ 全文都找不到 → `blockIndex = -1`（归入「已失效的批注」，**不假装它还在原位**）。
 *
 * `plains` 必须是 `blockPlainTexts(content_md)`——它与渲染出来的 `[data-block]` 元素
 * `textContent` 用同一把尺子（见 `lib/markdown.tsx` 顶部注释），所以这里的偏移可以直接交给
 * `<Markdown marks={...} />`，也是选区偏移的同一坐标系。
 */
export function resolveAnnotations(
  rows: AnnotationRow[],
  plains: string[],
): ResolvedAnnotation[] {
  return rows.map((row) => {
    const dead: ResolvedAnnotation = { row, blockIndex: -1, start: 0, end: 0, healed: false };
    const quote = row.quote ?? "";
    if (!quote.trim()) return dead; // 没有 quote 的旧批注无法校验，也不能假装能定位

    const raw = row.block_index;
    const bi = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const inRange = bi != null && bi >= 0 && bi < plains.length;

    // ① 原位置校验
    if (inRange && bi != null && typeof row.start_off === "number" && typeof row.end_off === "number") {
      const text = plains[bi];
      const s = row.start_off;
      const e = row.end_off;
      if (s >= 0 && e > s && e <= text.length && text.slice(s, e) === quote) {
        return { row, blockIndex: bi, start: s, end: e, healed: false };
      }
    }

    // ② 当前块内重新搜索
    if (inRange && bi != null) {
      const hit = findQuote(plains[bi], quote);
      if (hit) return { row, blockIndex: bi, start: hit.start, end: hit.end, healed: true };
    }

    // ③ 退化为全文搜索（离原块序号越近越优先，保证结果稳定可预期）
    const order = plains
      .map((_, i) => i)
      .sort((a, b) => {
        const da = bi == null ? Number.MAX_SAFE_INTEGER : Math.abs(a - bi);
        const dbb = bi == null ? Number.MAX_SAFE_INTEGER : Math.abs(b - bi);
        return da - dbb || a - b;
      });
    for (const i of order) {
      if (i === bi) continue;
      const hit = findQuote(plains[i], quote);
      if (hit) return { row, blockIndex: i, start: hit.start, end: hit.end, healed: true };
    }

    // ④ 全文都找不到 → 已失效
    return dead;
  });
}

/**
 * 便捷入口：直接拿 Markdown 全文解析锚点（视图用）。
 * 纯函数，`!isTauri()` 预览模式下走的是同一套代码，所以自愈逻辑在两种模式下都可验证。
 */
export function resolveNoteAnnotations(
  contentMd: string,
  rows: AnnotationRow[],
): ResolvedAnnotation[] {
  return resolveAnnotations(rows, blockPlainTexts(contentMd));
}

/** 拆成「能画在正文上的」与「已失效的」两组（失效组要单独成列并允许删除） */
export function splitResolved(list: ResolvedAnnotation[]): {
  placed: ResolvedAnnotation[];
  invalid: ResolvedAnnotation[];
} {
  const placed: ResolvedAnnotation[] = [];
  const invalid: ResolvedAnnotation[] = [];
  for (const r of list) (r.blockIndex >= 0 && r.end > r.start ? placed : invalid).push(r);
  return { placed, invalid };
}

/** 悬停提示：备注摘要 + （自动修正时）明确标出位置被改过 */
export function markTitleOf(r: ResolvedAnnotation): string {
  const c = (r.row.comment ?? "").trim();
  const parts = [c || "（这条批注没有写备注）"];
  if (r.healed) parts.push("位置已自动修正");
  return parts.join(" · ");
}

/** 已定位的批注 → `Markdown` 的 `marks` 层（key = 块序号） */
export function marksFrom(list: ResolvedAnnotation[]): Record<number, MdMark[]> {
  const out: Record<number, MdMark[]> = {};
  for (const r of list) {
    if (r.blockIndex < 0 || r.end <= r.start) continue;
    const bucket = out[r.blockIndex] ?? (out[r.blockIndex] = []);
    bucket.push({
      id: r.row.id,
      start: r.start,
      end: r.end,
      color: r.row.color ?? "yellow",
      title: markTitleOf(r),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成：当天问答记录 → 可编辑预览 → 用户点保存才入库
// ---------------------------------------------------------------------------

export interface DayMessage {
  role: string;
  content: string;
  created_at?: string | null;
  /** 来自哪个会话（让用户知道这次整理用了哪些对话） */
  session_id: number;
  session_title: string;
}

export interface DayCollectResult {
  messages: DayMessage[];
  /** 有当天消息的会话数 */
  sessionCount: number;
  /** 这门课**有问答记录**的其它日期（最多 3 个，倒序）——用于"今天没有记录"时给出可操作提示 */
  otherDates: string[];
  /** 这门课能读到的会话总数（0 = 还没聊过） */
  totalSessions: number;
}

/** `chat_course_messages`（R1 新增）的返回形状，逐字对应契约 `docs/11-R1…契约.md` §2.2 */
interface CourseMessageRow {
  session_id: number;
  session_title: string;
  role: string;
  content: string;
  created_at?: string | null;
}
interface CourseMessagesResult {
  session_count: number;
  session_count_with_messages?: number;
  message_count?: number;
  available_count?: number;
  truncated?: boolean;
  messages?: CourseMessageRow[];
}

/** 一次最多取回多少条课程消息（后端上限即 5000；默认 2000 偏小，这里显式拉满） */
const COURSE_MESSAGES_LIMIT = 5000;

/**
 * 收集某课程某天的问答记录（桌面：**一次** `chat_course_messages`；预览：示例数据）。
 * **只读、不写库**；没有当天记录时返回空数组，由调用方如实提示，绝不凭空生成。
 *
 * ⚠ 闭 T20（见 `docs/09-M3实现记录.md` §四）：旧实现是「列会话 + 逐个 `chat_history_load`」，
 *   会话一多就是 **1+N 次 IPC**。`chat_course_messages` 一次取回该课程全部问答，并自带
 *   `session_count`（正好是本函数要的 `totalSessions`），就地按日期过滤即可。
 *
 * ⚠ 消息顺序由「按会话分组」变为「**按时间正序**」（后端 `ORDER BY created_at, id`）。
 *   这是有意的：`buildNoteUserPrompt` 把消息逐条编号后交给模型，当天记录按时间读更自然，
 *   且不再依赖会话列表顺序；提示词里不引用会话分组，既有口径不受影响。
 *
 * ⚠ 残留风险（已登记为 T22）：后端按 limit 取**最近的** N 条，故课程消息总量超过
 *   `COURSE_MESSAGES_LIMIT` 时，**最早的那些日期会读不到**。`truncated` 标志未在本函数
 *   的返回结构里透出（`DayCollectResult` 形状已冻结、不便扩字段）。
 */
export async function collectDayMessages(
  courseId: number,
  date: string,
): Promise<DayCollectResult> {
  let rows: CourseMessageRow[] = [];
  let totalSessions = 0;

  if (isTauri()) {
    const bulk = await invokeStrict<CourseMessagesResult>("chat_course_messages", {
      courseId,
      limit: COURSE_MESSAGES_LIMIT,
    });
    totalSessions = bulk?.session_count ?? 0;
    rows = Array.isArray(bulk?.messages) ? bulk.messages : [];
  } else {
    const db = loadSampleDb();
    const mine = db.sessions.filter((x) => x.course_id === courseId);
    totalSessions = mine.length;
    rows = mine.flatMap((se) =>
      (db.messages[String(se.id)] ?? []).map((m) => ({
        session_id: se.id,
        session_title: se.title,
        role: m.role,
        content: m.content,
        created_at: m.created_at ?? null,
      })),
    );
  }

  const messages: DayMessage[] = [];
  const dates = new Set<string>();
  const hitSessions = new Set<number>();

  for (const m of rows) {
    if (m.role === "system") continue;
    if (!(m.content ?? "").trim()) continue;
    const d = dayOf(m.created_at);
    if (d) dates.add(d);
    if (d !== date) continue;
    hitSessions.add(m.session_id);
    messages.push({
      role: m.role,
      content: m.content,
      created_at: m.created_at ?? null,
      session_id: m.session_id,
      session_title: m.session_title,
    });
  }

  const otherDates = Array.from(dates)
    .filter((d) => d !== date)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, 3);

  return { messages, sessionCount: hitSessions.size, otherDates, totalSessions };
}

/** 生成超时（与先验知识骨架同量级，防止界面卡死） */
export const NOTE_TIMEOUT_MS = 180_000;

/** 单条消息最多带多少字（问答记录可能很长，避免把整段对话塞进请求） */
export const NOTE_MAX_MESSAGE_CHARS = 2000;

/** 全部消息合计最多带多少字（超出部分如实截断并在提示里说明） */
export const NOTE_MAX_TOTAL_CHARS = 24_000;

/** 系统提示词：口径写死在这里，改文案请同步契约 §4.1 */
export const NOTE_SYSTEM_PROMPT = [
  "你是「春晓」——面向大学生的本地单机学习助手，正在把用户**当天与你的问答记录**整理成一页课后复习用的课堂笔记。",
  "",
  "输出要求（必须严格遵守）：",
  "1. 只输出 Markdown 正文，不要输出任何解释、前言、后记；也不要用代码围栏把整篇包起来。",
  "2. 第一行必须是 `# ` 开头的一级标题（不超过 20 字，点明这页笔记的主题）。",
  "3. 正文用小节（`##`）组织；要点用列表**分条**写，一条一个要点，不要写成大段散文。",
  "4. 术语、符号、公式要显式写出：术语用加粗或行内代码标出；公式用纯文本写法（例如 `O(n log n)`、`Ax = λx`）。",
  "5. **禁止编造**具体的页码、条文、文献、人名与数值（不要写「见教材第 x 页」「根据某某论文」）。",
  "6. 只依据下面给出的当天问答记录整理。记录里没有的内容不要补；不要把你自己的知识伪装成这次对话的结论。",
  "7. 记录里没说清、前后不一致、或你不确定的，集中放到最后一节 `## 待确认`，每条**显式标注「待确认」**并写清不确定的原因。",
  "8. 这是课后理解与复习用的笔记，不是考试工具：不要输出押题、真题、答案速出式内容。",
  "9. 用中文；保持简洁，总长度控制在 1200 字以内。",
].join("\n");

/** 用户提示词：课程 + 日期 + 当天问诊记录（逐条编号，便于模型引用） */
export function buildNoteUserPrompt(input: {
  courseName: string;
  date: string;
  messages: DayMessage[];
}): { text: string; truncated: boolean } {
  const lines: string[] = [
    `课程名称：${input.courseName.trim() || "（未填写）"}`,
    `笔记日期：${input.date}`,
    `当天问答记录：共 ${input.messages.length} 条消息，来自 ${new Set(input.messages.map((m) => m.session_id)).size} 个会话。`,
    "",
  ];
  let used = 0;
  let truncated = false;
  input.messages.forEach((m, i) => {
    const who = m.role === "assistant" ? "春晓" : "我";
    let body = m.content.trim();
    if (body.length > NOTE_MAX_MESSAGE_CHARS) {
      body = `${body.slice(0, NOTE_MAX_MESSAGE_CHARS)}…（本条过长，已截断）`;
      truncated = true;
    }
    const head = `【${i + 1}】${who}（${m.created_at ?? "时间未记录"}）`;
    if (used + body.length > NOTE_MAX_TOTAL_CHARS) {
      truncated = true;
      return;
    }
    used += body.length;
    lines.push(head, body, "");
  });
  if (truncated) {
    lines.push("（注：上面的记录因过长被截断过；请不要为截断掉的部分编造内容。）", "");
  }
  lines.push("请按上面的要求输出 Markdown 笔记：");
  return { text: lines.join("\n"), truncated };
}

export interface NoteDraftParse {
  title: string;
  content: string;
  /** false = 模型没给一级标题，标题是本地按「课程 + 日期」拼的（界面上要说明） */
  titleFromModel: boolean;
}

/** 去掉整篇的 ``` 围栏（这是格式噪声，不是内容） */
function stripOuterFence(s: string): string {
  const m = /^```[A-Za-z0-9_+-]*[ \t]*\n([\s\S]*?)\n?```$/.exec(s.trim());
  return m ? m[1].trim() : s.trim();
}

/**
 * 把模型输出解析成「标题 + Markdown 正文」。**不静默改内容**：
 * 只去整篇围栏；标题有就用模型的，没有就用本地兜底标题并标记 `titleFromModel=false`。
 * 返回 null = 没有任何正文可用（调用方必须如实报错，不能生成空笔记）。
 */
export function parseNoteDraft(raw: string, fallbackTitle: string): NoteDraftParse | null {
  const content = stripOuterFence(raw ?? "");
  if (!content) return null;
  for (const line of content.split("\n")) {
    const m = /^ {0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[1].trim()) {
      return { title: m[1].trim(), content, titleFromModel: true };
    }
  }
  return { title: fallbackTitle, content, titleFromModel: false };
}

export type NoteGenResult =
  | ({ ok: true; raw: string } & NoteDraftParse)
  | { ok: false; error: string; raw: string };

export interface NoteGenInput {
  courseName: string;
  date: string;
  messages: DayMessage[];
  /** 流式进度回调（已收到多少字），仅用于界面提示 */
  onProgress?: (chars: number) => void;
}

/**
 * 调一次模型生成笔记草稿（走既有 `chatStream`，复用 BYOK 配置与错误口径）。
 * **不写库** —— 结果只交给页面做「可编辑预览」，用户点「保存」才会 `note_save`。
 */
export async function generateNoteMarkdown(
  cfg: AIConfig,
  input: NoteGenInput,
): Promise<NoteGenResult> {
  if (!(cfg.apiKey ?? "").trim()) {
    return {
      ok: false,
      raw: "",
      error: "尚未配置 API Key：请先到「数据设置」配置后再生成（不会用模板假造一份笔记冒充 AI 整理）。",
    };
  }
  if (input.messages.length === 0) {
    return {
      ok: false,
      raw: "",
      error: "这一天没有问答记录，没有可整理的内容（春晓不会凭空生成笔记）。",
    };
  }

  const prompt = buildNoteUserPrompt(input);
  const messages: ApiMsg[] = [
    { role: "system", content: NOTE_SYSTEM_PROMPT },
    { role: "user", content: prompt.text },
  ];

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, NOTE_TIMEOUT_MS);

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
    return {
      ok: false,
      raw: acc,
      error: timedOut
        ? `生成超时（超过 ${Math.round(NOTE_TIMEOUT_MS / 1000)} 秒）：可稍后重试。`
        : `模型调用失败：${errText(e)}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`,
    };
  } finally {
    clearTimeout(timer);
  }

  const fallback = `${input.courseName.trim() || "课堂"} · ${input.date} 笔记`;
  const parsed = parseNoteDraft(acc, fallback);
  if (!parsed) {
    return {
      ok: false,
      raw: acc,
      error: "模型没有返回可用的 Markdown 正文（可能是空回复或被截断）。",
    };
  }
  return { ok: true, raw: acc, ...parsed };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 文件名净化（去掉 Windows 不允许的字符，避免下载/导出失败） */
export function safeFileName(name: string): string {
  const s = (name || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (s || "笔记").slice(0, 80);
}

/**
 * 浏览器下载 Markdown（Blob + `a.download`）——**预览模式也能用**，因为它完全不依赖 Rust。
 */
export function downloadMarkdown(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器取消下载，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * docx 导出目录：**本机没有可靠的系统目录来源**（项目未引入 dialog 插件，且不允许新增依赖），
 * 所以做成"可选且可记忆"的一个输入框：优先用上次填过的目录，没有就传空串，
 * 让后端如实返回「请先选择导出目录。」，前端再引导用户填一个。
 */
export const LS_EXPORT_DIR = "chunxiao:notes-export-dir";

export function readExportDir(): string {
  try {
    return (localStorage.getItem(LS_EXPORT_DIR) ?? "").trim();
  } catch {
    return "";
  }
}

export function rememberExportDir(dir: string): void {
  try {
    const d = dir.trim();
    if (d) localStorage.setItem(LS_EXPORT_DIR, d);
  } catch {
    /* localStorage 不可用时只影响"记住上次目录"，不影响导出 */
  }
}

/** 便于在报告 / 界面里引用同一段措辞 */
export const PDF_HINT = "PDF 通过浏览器打印 → 另存为 PDF";
