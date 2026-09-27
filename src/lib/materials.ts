// M1 材料层：字节导入（base64）+ 全文检索 + 出处拼装。
//
// 契约：`docs/03-M1材料导入与检索契约.md`
//   · `extract_material_b64(fileName, dataB64)` → `{kind, text, blocks, truncated, note}`
//   · `material_search(courseId, query, limit)` → `MaterialHit[]`（无命中是 `[]`，不是 null）
//   · 行字段 snake_case；命令参数 camelCase（见 lib/tauri.ts 注释）
//
// 降级：`!isTauri()`（浏览器预览）时两条命令都走 `data/sample.ts` 的示例数据，
//       保证 UI 能脱离 Rust 调试。

import { callRust, invokeStrict, isTauri } from "./tauri";
import {
  loadSampleDb,
  sampleExtractMaterialB64,
  sampleMaterialSearch,
  type ExtractResult,
  type MaterialHit,
  type MaterialItem,
  type MsgRef,
} from "../data/sample";

export type { ExtractResult, MaterialHit, MsgRef };

/** 与 Rust 侧一致的单文件上限：20 MB（前端先拦一道，给更早的可读提示） */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** 导入时接受的文件类型（与契约 §4.1 的 input accept 一致） */
export const IMPORT_ACCEPT =
  ".pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.csv,.png,.jpg,.jpeg,.webp";

// ---------------------------------------------------------------------------
// 读文件为 base64
// ---------------------------------------------------------------------------

/**
 * 读文件为 base64。用 `readAsDataURL` 拿到的是 `data:<mime>;base64,....`，
 * Rust 侧容忍这个前缀（契约 §2.2），所以原样传即可。
 */
export function readFileAsB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result;
      if (typeof r === "string" && r.length > 0) resolve(r);
      else reject(new Error("读取文件内容失败（读到的内容为空）。"));
    };
    fr.onerror = () => reject(new Error("读取文件失败，可能没有权限或被占用。"));
    fr.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// 文本提取
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `extract_material_b64`：把字节交给 Rust 落临时文件 → 复用本地离线提取 → 删临时文件。
 * 这里是**写入类**链路的一环（会落盘材料），失败必须可见 → 用 invokeStrict。
 */
export async function extractMaterialB64(
  fileName: string,
  dataB64: string,
): Promise<ExtractResult> {
  if (!isTauri()) return sampleExtractMaterialB64(fileName, dataB64);
  const r = await invokeStrict<ExtractResult>("extract_material_b64", { fileName, dataB64 });
  return {
    kind: r.kind ?? "unknown",
    text: r.text ?? "",
    blocks: typeof r.blocks === "number" ? r.blocks : 0,
    truncated: !!r.truncated,
    note: r.note ?? null,
  };
}

/**
 * 该提取结果是否属于"本机解析不了、需要视觉/文件输入模型"的诚实提示。
 * Rust 只在 pdf / 图片 / 不支持的格式上返回 note，这里据此措辞。
 */
export function needsVisionModel(res: Pick<ExtractResult, "kind">): boolean {
  return res.kind === "pdf" || res.kind === "image";
}

/** 导入完成后给用户看的一条提示（pdf / 图片未配 Key 时用契约指定的话术，其余原样转达） */
export function noteForUser(res: ExtractResult): string | null {
  const note = (res.note ?? "").trim();
  if (!note) return null;
  if (needsVisionModel(res)) {
    return `本格式需要配置支持视觉 / 文件输入的模型；当前未配置 API Key，已按"只有文件名、没有正文"入库（本机提取提示：${note}）。到「数据设置」填好 Key 后重新导入一次，即可拿到模型转录的正文（会显式标注「模型解析，非原文」）。`;
  }
  return note;
}

// ---------------------------------------------------------------------------
// 全文检索
// ---------------------------------------------------------------------------

/** 检索结果：ok=false 表示**检索没跑成**（不是"没命中"），两者必须区分开，否则会谎报"材料里没有" */
export type SearchOutcome =
  | { ok: true; hits: MaterialHit[] }
  | { ok: false; error: string };

/**
 * `material_search`：在已导入材料的切块里按关键词召回。
 * `courseId` 传 null = 全库检索（无课程上下文的全局对话 / 悬浮球）。
 */
export async function materialSearch(
  courseId: number | null,
  query: string,
  limit = 8,
): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) return { ok: true, hits: [] };
  if (!isTauri()) {
    return { ok: true, hits: sampleMaterialSearch(courseId, q, limit) };
  }
  try {
    const list = await invokeStrict<MaterialHit[]>("material_search", {
      courseId,
      query: q,
      limit,
    });
    return { ok: true, hits: Array.isArray(list) ? list : [] };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

// ---------------------------------------------------------------------------
// 检索词抽取（M2 修复：中文提问没有空格，整句检索几乎必然 0 命中）
// ---------------------------------------------------------------------------

/**
 * 中文提问通常没有空格，直接拿整句去检索会：
 * FTS（trigram）要求整短语命中、LIKE 要求整句字面命中 → **几乎必然 0 命中**，
 * 于是「先查课程材料再回答」看起来就是坏的。
 *
 * 所以在调 `material_search` 之前，先把问题抽成**内容关键词**（如"梯度下降" + "学习率"），
 * 再用空格连起来传给 Rust —— Rust 按空白 / 标点切分，空格连接能保证它拿到的是多个词。
 * Rust 返回的 `terms` 是它实际使用的词，前端继续用它做高亮。
 */
const SEARCH_STOPWORDS: string[] = [
  // 疑问 / 功能词（切分时按长度从长到短优先匹配，避免"什么是"被"什么"截断）
  "什么是",
  "是什么",
  "为什么",
  "为啥",
  "怎么样",
  "怎样",
  "怎么",
  "如何",
  "哪些",
  "有什么",
  "的区别",
  "区别",
  "一下",
  "解释",
  "说明",
  "介绍",
  "适合",
  "可以",
  "能否",
  "以及",
  "请",
  "什么",
  "和",
  "与",
  "及",
  "的",
  "了",
  "是",
  "吗",
  "呢",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 停用词切分器（长的在前，一次扫描切完所有停用词） */
const STOP_RE = new RegExp(
  [...SEARCH_STOPWORDS].sort((a, b) => b.length - a.length).map(escapeRe).join("|"),
  "g",
);

/** 片段切分：空白 + 中英文标点（口径与 Rust 侧一致） */
const SEG_RE = /[\s,，.。、;；:：!！?？'"“”‘’()（）《》〈〉【】\[\]{}<>·…—\-–]+/;

/** 是否含中日韩统一表意文字（决定要不要按"字窗"再切） */
const HAS_CJK = /[\u4e00-\u9fff]/;

export interface SearchTermsResult {
  /** 送给 `material_search` 的词表 */
  terms: string[];
  /** true = 没能抽出关键词（例如用户只输入了"为什么"），已**退回整句检索** */
  fallback: boolean;
}

/**
 * 抽检索词 + 给出是否走了兜底（UI 需要如实告诉用户"本轮按整句检索"）。
 *
 * 规则（可微调，但改这里要同步改注释与报告）：
 *  1. 先按空白与中英文标点切段；
 *  2. 每段再按停用词切块（"梯度下降的学习率" → "梯度下降" + "学习率"）；
 *  3. 丢弃长度 < 2 的块；
 *  4. 含中文且长度 > 6 的块（连写长片段几乎不可能整串命中）再按 **4 字窗口**切，
 *     步长 3、每块最多 3 个窗口；纯英文 / 数字块（如 backpropagation、CNN）整块保留，
 *     因为它们是完整词，字窗只会切出垃圾；
 *  5. 去重（大小写不敏感）、优先长的片段、最多 `max` 个；
 *  6. 兜底：一个词都没抽出来 → 退回原始问题（保证不会因为抽词失败而检索不到东西）。
 */
export function extractSearchTermsWithInfo(question: string, max = 3): SearchTermsResult {
  const q = (question ?? "").trim();
  if (!q) return { terms: [], fallback: false };

  const primary: string[] = [];
  const windows: string[] = [];

  for (const seg of q.split(SEG_RE)) {
    for (const piece of seg.split(STOP_RE)) {
      const w = piece.trim();
      if (w.length < 2) continue;
      if (HAS_CJK.test(w) && w.length > 6) {
        for (let i = 0, n = 0; i + 4 <= w.length && n < 3; i += 3, n += 1) {
          windows.push(w.slice(i, i + 4));
        }
        continue;
      }
      primary.push(w);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  const ordered = [...primary.sort((a, b) => b.length - a.length), ...windows];
  for (const w of ordered) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= Math.max(1, max)) break;
  }

  if (out.length === 0) return { terms: [q], fallback: true };
  return { terms: out, fallback: false };
}

/** 只要词表的简版（契约要求的纯函数） */
export function extractSearchTerms(question: string, max = 3): string[] {
  return extractSearchTermsWithInfo(question, max).terms;
}

// ---------------------------------------------------------------------------
// 注入系统提示词的编号来源块（契约 §4.2 第 2 步，格式逐字对齐）
// ---------------------------------------------------------------------------

/** 有命中时的来源块表头（契约原文，不要改） */
export const MATERIAL_BLOCK_HEAD =
  "你可以引用下面这些来自用户课程材料的片段。只引用真实片段，不要编造。\n" +
  '若片段不足以回答，请明确说"材料中未找到相关内容"。';

/** 检索没命中时注入的说明：如实告知，并允许模型用自己的知识回答（但要求标注出处） */
export const NO_MATERIAL_BLOCK =
  "未在你的课程材料中找到相关内容（已在你的本机材料库里检索过）。\n" +
  "可以按你自身的知识回答，但必须显式标注「以下为模型补充，无材料出处，请自行核对」，不要把这部分说成来自用户的课程材料。";

/** 检索本身失败时的说明：不能谎称"材料里没有" */
export const SEARCH_FAILED_BLOCK =
  "本机材料检索这次没有执行成功，因此本次回答没有任何材料片段可引用。\n" +
  "请明确告知用户「检索失败、无法引用材料」，不要编造材料出处。";

/** 把命中的切块拼成 `【1】（材料名 · 标题路径）\\n<片段>` 形式的编号来源块 */
export function buildMaterialBlock(hits: MaterialHit[]): string {
  const lines: string[] = [MATERIAL_BLOCK_HEAD, ""];
  hits.forEach((h, i) => {
    const heading = (h.heading ?? "").trim();
    const title = heading ? `${h.material} · ${heading}` : h.material;
    const page = typeof h.page === "number" ? `，第 ${h.page} 页` : "";
    lines.push(`【${i + 1}】（${title}${page}）`);
    lines.push(h.snippet.trim());
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/** 命中 → 落库用的引用数组（只留可回链的字段，片段摘要截断到 300 字） */
export function refsFromHits(hits: MaterialHit[]): MsgRef[] {
  return hits.map((h) => ({
    material: h.material,
    heading: h.heading ?? null,
    snippet: h.snippet.length > 300 ? `${h.snippet.slice(0, 300)}…` : h.snippet,
    material_id: h.material_id ?? null,
    chunk_id: h.chunk_id ?? null,
    page: h.page ?? null,
    score: h.score ?? null,
    // M2：把本轮检索词一起落库，引用来源列表才能做命中高亮；没有就不写这个键
    terms: Array.isArray(h.terms) && h.terms.length > 0 ? h.terms.slice(0, 8) : undefined,
  }));
}

/** 一条引用的显示标题：材料名 · 标题路径 */
export function refTitle(r: MsgRef): string {
  const heading = (r.heading ?? "").trim();
  return heading ? `${r.material} · ${heading}` : r.material;
}

// ---------------------------------------------------------------------------
// R13：材料原文件 —— 留副本 / 打开 / 定位 / 补路径
// ---------------------------------------------------------------------------

/**
 * 把导入的原始文件在**本机留一份副本**，返回可直接交给系统打开的绝对路径。
 *
 * 为什么需要：材料的正文是按**字节**提取的（浏览器只给得到字节、给不到绝对路径），
 * 所以 M1 契约里 `materials.file_path` 一直是空字符串 —— 因此
 * 「点材料打开原文件」这件事**根本无从谈起**。有了副本，`open_file` 才有东西可开，
 * 而且用户把原文件移走/删掉之后春晓这边照样能打开。
 */
export async function storeMaterialFile(fileName: string, dataB64: string): Promise<string> {
  return await invokeStrict<string>("material_store_file", { fileName, dataB64 });
}

/** 给**已有**材料补记真实路径（只改 `file_path` 一列，不碰正文与切块） */
export async function setMaterialPath(id: number, filePath: string): Promise<void> {
  await invokeStrict<void>("material_set_path", { id, filePath });
}

/**
 * 用**系统默认程序**打开文件（PDF 会打开你的 PDF 阅读器）。
 * Rust 侧有扩展名白名单，且会先检查文件是否真的还在 ——
 * 文件被删/被移走时返回可读错误，**不静默失败**。
 */
export async function openWithSystem(path: string): Promise<void> {
  await invokeStrict<void>("open_file", { path });
}

/** 在资源管理器里定位文件（`explorer /select`） */
export async function revealInFolder(path: string): Promise<void> {
  await invokeStrict<void>("reveal_in_folder", { path });
}

/** 删除材料（切块随外键级联删除） */
export async function deleteMaterial(id: number): Promise<void> {
  await invokeStrict<void>("material_delete", { id });
}

/**
 * 人类可读的文件大小。**课程页与材料页共用一份** ——
 * 两处各写一个格式化函数，迟早会在"小于 1 KB 怎么写""一位小数还是两位"上漂移。
 */
export function fmtSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 读某几门课程的材料。`courseIds = null` 表示**全部课程**（逐课取回后合并）。
 *
 * 为什么是逐课取回：`materials_list` 的契约要求必填 `course_id`（M0 冻结），
 * 不去动它；课程数量是个位数，几次 IPC 完全够用，也避免为一个页面改冻结接口。
 */
export async function listMaterials(courseIds: number[] | null): Promise<MaterialItem[]> {
  if (!isTauri()) {
    const db = loadSampleDb();
    return courseIds == null
      ? db.materials
      : db.materials.filter((m) => courseIds.includes(m.course_id));
  }
  if (courseIds == null) return [];
  const all: MaterialItem[] = [];
  for (const cid of courseIds) {
    const list = await callRust<MaterialItem[]>("materials_list", { courseId: cid });
    if (Array.isArray(list)) all.push(...list);
  }
  return all;
}
