// R14 · 手写笔记 ↔ **既有笔记链路** 的桥接层。
//
// 契约：`docs/25-平板端与触控笔手写契约.md` §四
//
// 核心设计（这是整个方案"整体框架不变"的支点）：
//   **手写笔记仍然是 `notes` 表里的一条普通笔记**，`content_md` 里装三样东西：
//     ① 一级标题（与 AI 整理的笔记同构）；
//     ② 每一页手写渲染出来的 **PNG dataURL**（`![手写 · 第 N 页](data:image/png;base64,…)`）；
//     ③ 一段 **```chunxiao-ink 围栏**，里面是笔迹的紧凑 JSON（这份才是可再编辑的**真源**）。
//
// 为什么这样切（而不是新建一张 `ink_pages` 表 + 新命令）：
//   · 零数据库改动 → 备份 / 还原 / 列表 / 搜索 / 导出 / 悬浮球桥接**全部白拿**，
//     用户看到的仍是"一条笔记"，不是"另一个物种"；
//   · PNG 让**只读端**（笔记列表的阅读视图、打印、Word 导出）不需要理解墨迹引擎；
//   · 围栏让**编辑端**能无损回到笔迹层（橡皮、撤销、改颜色都还能用）。
//
// ⚠ 两条必须如实说明的限制（不要假装它们不存在）：
//   1. `markdown.tsx` **只放行 png/jpeg/webp/gif 的 dataURL，刻意排除 `image/svg+xml`**
//      （SVG 是可执行文档类型，是脚本注入面）。所以墨迹必须**光栅化**成 PNG，
//      不能图省事存 SVG —— 存了也会被渲染器整段降级成纯文本；
//   2. `src-tauri/src/docx.rs` **目前不处理图片**，所以 .docx 导出里**看不到手写页**
//      （.md 导出是完整的，因为 PNG 就在 Markdown 里）。这一条已登记为待办，不在这里假装已解决。
//
// 围栏为什么能"看不见"：`lib/markdown.tsx` 把 ```chunxiao- 前缀的围栏当作**应用内部数据块**，
// 渲染为空、且不贡献任何纯文本（否则会破坏批注偏移那把尺子）。见该文件 §数据围栏。

import type { AIConfig } from "./ai";
import { DEFAULT_MODEL, normalizeEndpoint } from "./ai";
import { docChars, pageToPng, serializeDoc, parseDoc, type InkDoc } from "./ink";
import { contentBlockFor, VISION_HINT } from "./vision";

/** 数据围栏的语言标记（`lib/markdown.tsx` 按 `chunxiao-` 前缀整类隐藏） */
export const INK_FENCE_LANG = "chunxiao-ink";

/**
 * 手写笔记的 `source` 值。
 *
 * ⚠ 后端 `db.rs` 的 `NOTE_SOURCES` 是**白名单**，新增取值必须同步改那里，否则 `note_save`
 * 会抛出可读错误（这是好事：来源是"内容怎么来的"这一事实，不允许随便写）。
 */
export const INK_SOURCE = "ink";

/** 内联 PNG 的最长边（与 `lib/images.ts` 的 MAX_IMAGE_EDGE 同一口径：1600 够看清，体积可控） */
export const INK_PNG_MAX_EDGE = 1600;

// ---------------------------------------------------------------------------
// 编码：InkDoc → Markdown
// ---------------------------------------------------------------------------

/** 笔迹数据围栏（含定界行），解码时按同一把尺子找回来 */
export function inkFence(text: string): string {
  return "```" + INK_FENCE_LANG + "\n" + text + "\n```";
}

/**
 * 把一页渲染成 PNG dataURL 列表。**逐页渲染**（不是拼成一张长图）：
 * 拼长图会让"第几页"这个信息彻底丢失，也没法只重画改过的那一页。
 */
export function docToPngs(doc: InkDoc, maxEdge = INK_PNG_MAX_EDGE): string[] {
  return doc.pages.map((pg) => pageToPng(pg, { maxEdge }));
}

export interface EncodeInkInput {
  title: string;
  doc: InkDoc;
  /** 已经渲染好的 PNG（不传就现渲染；批量导出时复用同一份，避免重复光栅化） */
  pngs?: string[];
  /** 手写转文字的结果（模型转写，**非原文** —— 落库时必须如实标注） */
  ocrText?: string | null;
  maxEdge?: number;
}

/**
 * InkDoc → `content_md`。
 *
 * 结构固定为：H1 标题 → 逐页 PNG →（可选）文字稿小节 → 笔迹围栏。
 * 围栏**必须放最后**：它是数据，不是给人看的内容；放到中间会把"文字稿"和图片隔开。
 */
export function encodeInkMarkdown(input: EncodeInkInput): string {
  const title = (input.title || "").trim() || "手写笔记";
  const pngs = input.pngs ?? docToPngs(input.doc, input.maxEdge);
  const parts: string[] = [`# ${title}`, ""];

  pngs.forEach((url, i) => {
    parts.push(`![手写 · 第 ${i + 1} 页](${url})`, "");
  });

  const ocr = (input.ocrText ?? "").trim();
  if (ocr) {
    // 标注口径与 M2 视觉转录一致（VISION_NOTE 同义）：这是模型转写的，不是原文
    parts.push("## 文字稿（模型转写，非原文）", "", ocr, "");
  }

  parts.push("<!-- 以下为手写笔迹的原始数据，供再次编辑；请勿手动修改 -->", inkFence(serializeDoc(input.doc)), "");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 解码：Markdown → InkDoc
// ---------------------------------------------------------------------------

export interface DecodedInkNote {
  /** 正文里有没有笔迹围栏（没有 = 这不是一条手写笔记） */
  hasFence: boolean;
  /** 解析成功的笔迹文档；null = 没有围栏，或围栏内容读不出来 */
  doc: InkDoc | null;
  /** 有围栏但解析失败 —— 界面必须**如实告知**，不能让用户以为笔迹还在 */
  broken: boolean;
  /** 正文里的内联 PNG（按出现顺序；手写转文字时要用它们） */
  pngs: string[];
}

const FENCE_OPEN_RE = new RegExp("^```" + INK_FENCE_LANG + "\\s*$", "m");
const IMG_RE = /!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g;

/**
 * 从 `content_md` 里取回笔迹。
 *
 * 解析口径：找**第一个** ```chunxiao-ink 行，直到下一个 ``` 行为内容。
 * 找不到闭合围栏时：把剩下的全部当内容（与 `markdown.tsx` 对未闭合围栏的处理一致），
 * 解析失败就置 `broken=true` —— 调用方据此提示，**绝不返回一个半截的、看起来能用的文档**。
 */
export function decodeInkNote(contentMd: string): DecodedInkNote {
  const text = contentMd ?? "";
  const pngs: string[] = [];
  for (const m of text.matchAll(IMG_RE)) pngs.push(m[1]);

  const open = FENCE_OPEN_RE.exec(text);
  if (!open) return { hasFence: false, doc: null, broken: false, pngs };

  const start = open.index + open[0].length;
  const rest = text.slice(start);
  const closeAt = rest.search(/^```\s*$/m);
  const body = (closeAt >= 0 ? rest.slice(0, closeAt) : rest).trim();
  const doc = parseDoc(body);
  return { hasFence: true, doc, broken: doc == null, pngs };
}

/** 这条笔记是不是手写笔记（列表页拿不到正文，所以**判定以 `source` 为准**，见 `lib/notes.ts`） */
export function looksLikeInkMarkdown(contentMd: string): boolean {
  return FENCE_OPEN_RE.test(contentMd ?? "");
}

/** 手写笔记的一句话摘要（页数 + 笔数），用于界面与提示文案 */
export function inkSummary(doc: InkDoc): string {
  const strokes = doc.pages.reduce((n, p) => n + p.strokes.length, 0);
  return `${doc.pages.length} 页 · ${strokes} 笔`;
}

/** 笔迹数据的字符数（提示用户"这段数据占了多少"；PNG 另算） */
export function inkDataChars(doc: InkDoc): number {
  return docChars(doc);
}

// ---------------------------------------------------------------------------
// 手写转文字（可选工具；**必须走用户自己的模型**，不内置任何识别服务）
// ---------------------------------------------------------------------------

/**
 * 手写转文字的提示词。
 *
 * 与 M2 的 `VISION_PROMPT` 刻意分开：那一条是"转录课堂材料"，这一条要处理**连笔字**与
 * **手绘图形**，两者该说的话不一样。三条红线与项目其它提示词完全一致：
 *   看不清就说看不清（不猜）、公式要显式写出、不输出解释性废话。
 */
export const INK_OCR_PROMPT = [
  "你是手写笔记的转录助手。请把这一页**手写**内容转写成 Markdown。",
  "",
  "要求：",
  "1. 只写你在图里**确实看清**的内容。看不清的字用「◻」占位，并在该处后用括号标注「无法辨识」。",
  "2. **不要猜、不要补全、不要用你的知识替用户把句子写完整。**",
  "3. 数学公式用 LaTeX：行内 `$…$`，独立成行的用 `$$…$$`。",
  "4. 保留原有的分点、编号、缩进与层次关系。",
  "5. 手绘的图 / 表 / 箭头用一句括号说明描述（例如「（图：一条开口向上的抛物线）」），",
  "   **不要伪造坐标、数值或文字**——图里没写的就不要写。",
  "6. 不要输出任何解释、前言、后记，也不要用代码围栏把整篇包起来。",
].join("\n");

export interface InkOcrResult {
  ok: boolean;
  text: string;
  err?: string;
}

/** 单页识别超时（与 `vision.ts` 的 180 秒同口径） */
export const INK_OCR_TIMEOUT_MS = 180_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 把一页手写 PNG 交给用户配置的**视觉模型**转写成文字。
 *
 * ⚠ 这一条**会联网、会产生 token 费用**，且结果**不是原文**（模型转写）。
 *   所以：按钮上的措辞是「识别为文字（模型转写）」，结果落库时带小标题标注；
 *   没有配置 Key 时**直接如实报错**，不假装有离线识别能力（Web 层没有可用的离线手写识别）。
 *
 * 复用 `vision.ts` 的 `contentBlockFor`（MIME 推断）与 `VISION_HINT`（换模型的引导），
 * 错误措辞与那条链路保持一致 —— 用户在两处看到的是同一套说法。
 */
export async function recognizeInkPage(cfg: AIConfig, pngDataUrl: string): Promise<InkOcrResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      text: "",
      err: "尚未配置 API Key：手写转文字要交给支持视觉的模型做（Web 层没有可用的离线手写识别），请在「数据设置」配置后再试。",
    };
  }
  const block = contentBlockFor("手写页.png", pngDataUrl);
  if (!block) return { ok: false, text: "", err: "这一页渲染出来的图片格式不受支持（应为 PNG）。" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INK_OCR_TIMEOUT_MS);
  try {
    const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: cfg.model?.trim() || DEFAULT_MODEL,
        temperature: 0.1,
        stream: false,
        messages: [
          { role: "user", content: [{ type: "text", text: INK_OCR_PROMPT }, block] },
        ],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* 平台可能不回 body */
      }
      return {
        ok: false,
        text: "",
        err: `识别失败（HTTP ${res.status}）：${VISION_HINT}${detail ? `。平台返回：${detail}` : ""}`,
      };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, text: "", err: "模型返回的不是合法 JSON，读不出识别结果。" };
    }
    const d = data as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = d?.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((p) => {
                const part = p as { text?: unknown };
                return typeof part?.text === "string" ? part.text : "";
              })
              .join("")
          : "";
    if (!text.trim()) {
      return { ok: false, text: "", err: `模型没有返回任何文字（HTTP ${res.status}）：${VISION_HINT}` };
    }
    return { ok: true, text: text.trim() };
  } catch (e) {
    if (ctrl.signal.aborted) {
      return {
        ok: false,
        text: "",
        err: `识别超时（超过 ${Math.round(INK_OCR_TIMEOUT_MS / 1000)} 秒）：可稍后重试，或减少页数后逐页识别。`,
      };
    }
    return { ok: false, text: "", err: `无法完成识别：${errText(e)}（请到「数据设置」检查接口地址 / Key / 模型名）` };
  } finally {
    clearTimeout(timer);
  }
}
