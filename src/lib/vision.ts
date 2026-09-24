// M2 视觉转录：把 pdf / 图片交给支持视觉（或文件输入）的模型，转录成可学习文本。
//
// 契约：`docs/05-M2契约.md` §二
//   · 本文件**不动** `lib/ai.ts` 的 `chatStream`（那个只做流式文本），自己发一次 `stream: false` 的请求；
//   · 转录文本是**模型解析、非原文** —— 调用方必须把 `VISION_NOTE` 写进材料的 note，UI 必须显式展示；
//   · 失败时把 HTTP 状态 + "可能不支持图片/文件输入"的提示拼成**可读中文错误**，不静默失败。
//
// MIME 口径按文件名扩展名推断，与 `src-tauri/src/office.rs` 的 pdf / 图片分派保持一致
// （pdf / png / jpg / jpeg / webp / gif / bmp）。

import { DEFAULT_MODEL, normalizeEndpoint, type AIConfig, type ApiContentPart } from "./ai";

export interface VisionResult {
  ok: boolean;
  text: string;
  err?: string;
}

/** 契约 §2.2 给出的提示词原文（**逐字使用**，不要改写） */
export const VISION_PROMPT =
  "你是课堂材料的转录助手。请完整提取这份材料的可学习内容：标题与章节层级、正文要点、公式与符号、图表说明、例题与解答。只输出材料本身可靠呈现的内容，不要评论、不要补全缺失信息；无法可靠辨识的部分明确标注「无法辨识」。";

/** 落库时必带的标注（契约 §2.1 / §2.3：模型解析、非原文）
 *  ⚠ R3：改成用户看得懂的说法；语义（**不是原文**）不变，仍逐条显式展示。 */
export const VISION_NOTE = "这是模型转写的，不是原文";

/** 转录文本上限（契约 §2.2：超出截断） */
export const VISION_MAX_CHARS = 80000;

/** 单次请求超时（契约 §2.2：180 秒） */
export const VISION_TIMEOUT_MS = 180_000;

/** 平台可能不支持该输入时的提示（契约要求拼进可读中文错误） */
export const VISION_HINT =
  "当前模型可能不支持图片/文件输入，请在数据设置改用支持视觉的模型（如 gpt-4o、Qwen-VL）";

// ---------------------------------------------------------------------------
// MIME 推断 / 内容块构造
// ---------------------------------------------------------------------------

/** 按扩展名推断 MIME（与 Rust `office.rs` 的分派一致）；不支持的格式返回空串 */
export function mimeOf(fileName: string): string {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return "";
  }
}

/** 该文件是否属于"能交给视觉/文件输入模型"的格式 */
export function isVisionCapable(fileName: string): boolean {
  const mime = mimeOf(fileName);
  return mime === "application/pdf" || mime.startsWith("image/");
}

/** 去掉 `data:...;base64,` 前缀（`readAsDataURL` 会给一串前缀，Rust 侧也容忍它） */
function stripDataUrl(v: string): string {
  const s = (v || "").trim();
  if (!/^data:/i.test(s)) return s;
  const i = s.indexOf(",");
  return i >= 0 ? s.slice(i + 1).trim() : s;
}

/**
 * 按 MIME 选内容块：
 *   · `image/*`        → `{ type: "image_url", image_url: { url: "data:<mime>;base64,<b64>" } }`
 *   · `application/pdf`→ `{ type: "file", file: { filename, file_data: "data:application/pdf;base64,<b64>" } }`
 * 其它格式返回 null（调用方据此给可读中文错误）。
 */
export function contentBlockFor(fileName: string, base64: string): ApiContentPart | null {
  const mime = mimeOf(fileName);
  const b64 = stripDataUrl(base64);
  if (!b64) return null;
  if (mime === "application/pdf") {
    return {
      type: "file",
      file: { filename: fileName, file_data: `data:application/pdf;base64,${b64}` },
    };
  }
  if (mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// R4：图片提问 —— 能力判定与转写
// ---------------------------------------------------------------------------

/**
 * 常见「能看图」模型的名称特征（用于「自动」模式判定）。
 *
 * ⚠ 这是**启发式**，不是能力探测：真正的能力探测得发一次请求才准。
 * 函数名刻意叫 `looks*` 而不是 `is*` —— 猜错的代价只是"多发一次带图片的请求"
 * （模型不支持时接口会报错，界面如实显示），因此设置页给了用户**显式覆盖**
 * （自动 / 直接发图 / 先转成文字），不靠猜。
 */
const VISION_MODEL_HINTS = [
  "vl",
  "vision",
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "claude",
  "gemini",
  "glm-4v",
  "glm-4.5v",
  "llava",
  "internvl",
  "minicpm-v",
  "pixtral",
  "doubao-vision",
  "step-1v",
];

/** 模型名看起来能不能看图（见上：启发式，不保证准确） */
export function looksVisionCapable(model: string): boolean {
  const m = (model || "").toLowerCase();
  if (!m) return false;
  return VISION_MODEL_HINTS.some((h) => m.includes(h));
}

/**
 * 给 dataURL 造一个**假文件名**，只为让 `contentBlockFor` 推导出正确 MIME。
 *
 * 为什么不直接写 "图片.png"：粘贴进来的可能是 JPEG，而 `mimeOf` 是**按扩展名**判断的 ——
 * 名字写着 png、实际是 jpeg 时，发给模型的内容块 MIME 就错了（部分平台会因此拒收）。
 */
export function fileNameForDataUrl(dataUrl: string, index: number): string {
  const m = /^data:([^;,]+)[;,]/.exec((dataUrl || "").trim());
  const mime = (m?.[1] ?? "image/png").toLowerCase();
  const ext = mime === "image/jpeg" ? "jpg" : mime.startsWith("image/") ? mime.slice(6) : "png";
  return `粘贴图片${index + 1}.${ext}`;
}

export interface ImageTranscript {
  ok: boolean;
  text: string;
  err?: string;
}

/**
 * 用视觉模型把一批 dataURL 逐张转写成文字。
 *
 * 这是「主模型看不了图」时的兜底路径：转写结果会**原样**拼进提问文本，
 * 并由调用方明确标注「图片已转成文字（模型转写，非原文）」—— 不冒充原文。
 */
export async function transcribeDataUrls(
  cfg: AIConfig,
  dataUrls: string[],
): Promise<ImageTranscript[]> {
  const out: ImageTranscript[] = [];
  for (let i = 0; i < dataUrls.length; i++) {
    const r = await transcribeWithModel(cfg, fileNameForDataUrl(dataUrls[i], i), dataUrls[i]);
    out.push({ ok: r.ok, text: r.text, err: r.err });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 失败结果：把调用方给的 `note`（本机提取为什么需要视觉模型）作为补充说明附在后面，便于排障 */
function fail(msg: string, note?: string | null): VisionResult {
  const extra = (note ?? "").trim();
  return { ok: false, text: "", err: extra ? `${msg}\n（本机提取提示：${extra}）` : msg };
}

/** 从 OpenAI 兼容响应里取出文本（content 可能是字符串，也可能是内容块数组） */
function extractText(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = d?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: unknown };
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("");
  }
  return "";
}

/**
 * 用视觉模型转录一份 pdf / 图片。
 *
 * 注意：这里是**只读**能力（不写库、不落盘），失败以 `{ ok: false, err }` 返回，
 * 由课程页决定是"保留原文案按文件名入库"还是把失败原因并入提示 —— 都不静默。
 */
export async function transcribeWithModel(
  cfg: AIConfig,
  fileName: string,
  base64: string,
  note?: string | null,
): Promise<VisionResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return fail("尚未配置 API Key：请先到「数据设置」填入支持视觉的模型（Key 只保存在本机）。");
  }

  const block = contentBlockFor(fileName, base64);
  if (!block) {
    return fail(
      `无法把「${fileName}」交给视觉模型：只支持 pdf 与图片（png / jpg / jpeg / webp / gif / bmp）；` +
        "其它格式请先用本地离线提取。",
      note,
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);

  try {
    const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: cfg.model?.trim() || DEFAULT_MODEL,
        temperature: 0.1,
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: VISION_PROMPT }, block],
          },
        ],
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* 平台可能不回 body，读不到就算了 */
      }
      return fail(
        `模型转录失败（HTTP ${res.status}）：${VISION_HINT}${detail ? `。平台返回：${detail}` : ""}`,
        note,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return fail("模型返回的内容不是合法 JSON，读不出转录文本。", note);
    }

    const text = extractText(data);
    if (!text.trim()) {
      return fail(`模型没有返回任何转录文本（HTTP ${res.status}）：${VISION_HINT}`, note);
    }
    // 契约：上限 8 万字，超出截断（调用方用 VISION_MAX_CHARS 判断是否截断并标注）
    return { ok: true, text: text.length > VISION_MAX_CHARS ? text.slice(0, VISION_MAX_CHARS) : text };
  } catch (e) {
    if (ctrl.signal.aborted) {
      return fail(
        `转录超时（超过 ${Math.round(VISION_TIMEOUT_MS / 1000)} 秒）：文件较大或网络较慢，可稍后重试，` +
          "或先把材料转成文本 / 拆成更小的图片再导入。",
        note,
      );
    }
    return fail(`无法完成转录：${errText(e)}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`, note);
  } finally {
    clearTimeout(timer);
  }
}
