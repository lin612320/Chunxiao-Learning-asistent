/**
 * 图片工具（R4）：从剪贴板取图 → 压缩到可入库的尺寸 → 估算体积。**零依赖**（用 canvas）。
 *
 * 为什么必须压缩：截图粘贴进来的原图常是 2–4 MB 的 PNG。一张不压的图 base64 后
 * 还要再涨约 1/3，几次下来就能把本机数据库撑到不可用。这里在**入前端内存之前**就压好，
 * 后面（存储、发给模型、经桥接传给球）全程都用这一份。
 *
 * 与 Rust 侧的职责划分：
 *   · 这里管**体验**：超阈值就明确拒绝并告诉用户怎么办；
 *   · Rust 侧 `CHAT_IMAGES_MAX_BYTES`（6 MB）管**最后一道防线**：只保证库不被写坏。
 */

/** 压缩后最长边（像素）。1600 足够模型读清题干与板书，再大只是浪费体积与费用。 */
export const MAX_IMAGE_EDGE = 1600;

/** PNG 走不通时的兜底质量（JPEG 对文字截图略糊，但足够辨认，且体积小一个量级）。 */
export const JPEG_QUALITY = 0.85;

/** PNG 数据量超过这个值就改走 JPEG（纯色/文字截图 PNG 通常远小于此）。 */
const PNG_KEEP_LIMIT = 1_200_000;

/** 单条消息图片总量上限（**前端提示阈值**，比 Rust 的 6 MB 硬上限更严）。 */
export const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** dataURL 的字节数（base64 解码后的真实字节数，不是字符串长度） */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** 人类可读的体积（用于界面提示） */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 从粘贴事件里取出图片文件（没有图片时返回空数组，**不**吞掉纯文本粘贴） */
export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  const out: File[] = [];
  // 1) 标准路径：items 里带 kind === "file" 的图片
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  // 2) 兜底：某些来源只在 files 里给（例如从资源管理器复制图片文件）
  if (out.length === 0) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这张图读不出来（格式可能不受支持）"));
    };
    img.src = url;
  });
}

/**
 * 把一张图片压缩成 dataURL。
 *
 * 策略：先等比缩到最长边 `MAX_IMAGE_EDGE`；优先用 PNG（文字截图更清晰），
 * 只有当 PNG 结果明显偏大时才改用 JPEG —— **先保证看得清，再谈省体积**。
 * 透明背景的截图走 JPEG 会变成黑底，因此这种情况一律保留 PNG。
 */
export async function downscaleToDataUrl(file: File): Promise<string> {
  const img = await loadImage(file);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error("这张图的尺寸读不出来");

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持图片处理（canvas 不可用）");
  // 白底打底：JPEG 没有透明通道，透明区域会变黑；铺白底后再画
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const png = canvas.toDataURL("image/png");
  if (dataUrlBytes(png) <= PNG_KEEP_LIMIT) return png;
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export interface CollectResult {
  /** 成功压缩好的 dataURL（按用户粘贴顺序） */
  images: string[];
  /** 逐条如实说明被拒的原因（**不静默丢弃**） */
  rejected: string[];
}

/**
 * 把一批剪贴板图片收成可发送的 dataURL 列表。
 *
 * `existing` 是当前已经挂着的图片 —— 用来做**总量**判定：
 * 超过 `MAX_TOTAL_BYTES` 的部分会被拒绝并如实说明是"这一张"还是"总量"超了。
 */
export async function collectImages(files: File[], existing: string[]): Promise<CollectResult> {
  const images: string[] = [];
  const rejected: string[] = [];
  let total = existing.reduce((n, d) => n + dataUrlBytes(d), 0);

  for (const f of files) {
    try {
      const dataUrl = await downscaleToDataUrl(f);
      const bytes = dataUrlBytes(dataUrl);
      if (total + bytes > MAX_TOTAL_BYTES) {
        rejected.push(
          `「${f.name || "粘贴的图片"}」没放进来：加上它这条消息的图片共 ` +
            `${humanBytes(total + bytes)}，超过单条 ${humanBytes(MAX_TOTAL_BYTES)} 的上限。` +
            `可以少放几张，或先裁小一点。`,
        );
        continue;
      }
      total += bytes;
      images.push(dataUrl);
    } catch (e) {
      rejected.push(`「${f.name || "粘贴的图片"}」没放进来：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { images, rejected };
}
