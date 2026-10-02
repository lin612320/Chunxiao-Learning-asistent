// R14 · 触控笔手写：**墨迹引擎**（零依赖：纯几何 + Canvas 2D + 紧凑序列化）。
//
// 契约：`docs/25-平板端与触控笔手写契约.md` §三
//
// 为什么要自己写而不是引第三方（perfect-freehand / signature_pad 之类）：
//   1. 项目硬约定「不新增第三方依赖」（唯一一次破例是 KaTeX，已单独登记）——手写能零依赖做出来，
//      就不该为它开第二个口子；
//   2. 引库省的是"轮廓拟合"那一小块，而真正决定手感的是**采样策略**（`getCoalescedEvents`、
//      压感标定、丢帧时的断笔处理）与**重绘策略**（只画增量、撤销才全量）——这两块库帮不上忙；
//   3. 笔迹数据格式必须由我们自己定（要能塞进 `notes.content_md` 的围栏里跟着笔记一起备份）。
//
// 三条刻意的设计决定（都有代价，代价写在旁边）：
//   · **坐标系 = 页面坐标**（`InkPage.w/h` 这套逻辑像素），与屏幕缩放/滚动**解耦**。
//     好处：缩放、旋转、导出、重放全都同一套坐标；代价：每帧要把屏幕坐标反变换回页面坐标。
//   · **笔迹按"线宽分段"绘制**（`strokeRuns()`）：把密集点按量化后的线宽切成若干条折线，
//     每条折线**只 stroke 一次**。好处：一页几百条笔迹的红屏重绘仍然很快；
//     代价：线宽变化处是硬切换（步长 0.5px，肉眼不可见）。
//   · **撤销走操作栈**（新增/擦除/清空/改纸面/增删页），不是整页快照。
//     好处：内存与页面大小无关；代价：每种操作都要自己写正反两个方向（见 `InkOp`）。
//
// ⚠ 诚实边界（**不要把下面的说法当成已经做到的事**）：
//   · 压感**不做校准**：直接取 `PointerEvent.pressure`。不同笔的量程不同（S Pen 与 Apple Pencil
//     的原始曲线不一样），所以"同一条笔迹在两台设备上粗细感受不同"是真实的、已知的差异；
//   · 不做笔迹预测（`getPredictedEvents`）。预测要跟"真实点到达后回退重画"这套补偿配对，
//     没做补偿就用预测会出现"笔尖后面拖着一条会缩回去的尾巴"，比不加预测更糟；
//   · 不做手掌压力拒识（浏览器不给手掌数据）。防误触靠**"笔在写时忽略所有 touch"**这一条规则。

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/**
 * **能落进文档**的笔迹工具。
 * ⚠ `select` / `eraser` 不在这里：前者是交互（选框不进数据），后者是删点（擦完没有"橡皮笔迹"）。
 */
export type InkDrawTool = "pen" | "pencil" | "marker" | "line" | "stamp";

/** 界面上能选中的工具 = 落笔工具 + 橡皮 + 框选 */
export type InkTool = InkDrawTool | "eraser" | "select";

/** 纸面样式：空白 / 方格 / 横线 / 点阵 */
export type InkPaper = "blank" | "grid" | "lines" | "dots";

/** 一个采样点：页面坐标 + 压感（0–1；无压感设备恒为 0.5） */
export interface InkPoint {
  x: number;
  y: number;
  p: number;
}

export interface InkStroke {
  tool: InkDrawTool;
  color: string;
  /** 基准线宽（页面坐标下的像素）；实际线宽由 `widthAt()` 按压感缩放 */
  size: number;
  pts: InkPoint[];
  /**
   * `true` = **画在所有笔迹之下**（荧光笔高亮带专用，R14b）。
   *
   * 为什么需要单独一层：在别人的笔记上"划重点"必须是**底色**，盖在字上面就等于把字涂糊了。
   * 它不影响几何、橡皮或导出，只影响 `drawPageContent` 的绘制顺序（先画 behind，再画其余）。
   */
  behind?: boolean;
  /**
   * `tool === "stamp"` 时的**符号本身**（✓ ✗ ★ ？ → ① 这类标注符号，R14b）。
   *
   * 为什么不做成新的一种元素类型：符号的落点是**一个点**、有颜色与大小、要能框选/移动/删除/撤销
   * —— 这些语义与笔迹完全一致，复用 `InkStroke` 就不必给橡皮、框选、撤销栈各写第二套分支。
   */
  glyph?: string;
}

export interface InkPage {
  paper: InkPaper;
  /** 页面逻辑宽高（页面坐标） */
  w: number;
  h: number;
  strokes: InkStroke[];
  /**
   * 可选的**底图**（dataURL，PNG/JPEG）。
   *
   * 用途：把讲义截图 / 教材照片铺在纸下面，再用笔在上面圈画 —— 这是学生最需要的一种"手写"。
   * 代价：它会**跟着笔迹一起进 `content_md`**（因为是 base64），所以界面在插入时限制体积；
   * 底图不参与撤销栈（换底图是"换纸"，与笔迹分开，见 `setBg` 的说明）。
   */
  bg?: string | null;
}

export interface InkDoc {
  v: 1;
  pages: InkPage[];
}

// ---------------------------------------------------------------------------
// 常量（与 `docs/25` §3.2 的取值逐字对应）
// ---------------------------------------------------------------------------

/**
 * 默认页面：**A4 @150dpi**（1240×1754 逻辑像素）。
 *
 * 为什么用 A4 而不是"跟随屏幕"：手写笔记的出路是打印 / 导出 PDF / 放进 Word，
 * 页面比例一旦跟着屏幕走，这几条路全都会走形。屏幕装不下就用双指缩放看（这是平板的本能动作）。
 */
export const A4_W = 1240;
export const A4_H = 1754;

export const MIN_SIZE = 1;
export const MAX_SIZE = 24;

/** 可选颜色（页面坐标下的墨色；荧光笔另有自己的固定色板） */
export const PEN_COLORS = [
  "#1f2328",
  "#4176e6",
  "#ec1313",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
] as const;

/** 荧光笔色板（低不透明度，叠在正文之上是"划重点"的意思） */
export const MARKER_COLORS = ["#f7ad31", "#4ed17e", "#679efe", "#f25a5a"] as const;

export const TOOL_LABEL: Record<InkTool, string> = {
  pen: "钢笔",
  pencil: "铅笔",
  line: "直线",
  marker: "荧光笔",
  stamp: "标注符号",
  eraser: "橡皮",
  select: "框选",
};

export const PAPER_LABEL: Record<InkPaper, string> = {
  blank: "空白",
  grid: "方格",
  lines: "横线",
  dots: "点阵",
};

/** 工具栏顺序（按使用频次排：写 → 划重点 → 标注 → 修 → 选） */
export const TOOLS: readonly InkTool[] = ["pen", "pencil", "line", "marker", "stamp", "eraser", "select"];
export const PAPERS: readonly InkPaper[] = ["blank", "grid", "lines", "dots"];

/**
 * 标注符号表（R14b）。
 *
 * 选型依据：**学生批注笔记时真正常用的那几类**，而不是"emoji 大杂烩"。
 *   · 判对错：✓ ✗
 *   · 强调：★ ※ ！ ？
 *   · 顺序/编号：① ② ③（手写笔记里"第几条"用得比字母多）
 *   · 方向/因果：→ ← ⇒（画箭头手写很难直，用符号替代恰恰是"标注"该有的样子）
 *   · 提醒/存疑：⚠ ？
 *
 * ⚠ 刻意**不用** emoji（🌈🔥😭 那种）：不同系统字体不同、基线不齐、颜色不受控，
 *   与 `components/Icon.tsx` 里"不用 emoji 当图标"是同一条理由。
 */
export const STAMP_GLYPHS: readonly string[] = [
  "✓",
  "✗",
  "★",
  "☆",
  "※",
  "！",
  "？",
  "①",
  "②",
  "③",
  "→",
  "←",
  "↑",
  "↓",
  "⇒",
  "⚠",
  "+",
  "−",
  "=",
  "△",
  "□",
  "○",
];

/** 标注符号的字号：线宽滑杆的 6 倍（线宽 3 → 18px 的字，正好是一行批注的大小） */
export function stampFontSize(size: number): number {
  return clamp(size * 6, 12, 140);
}

/** 符号用的字体栈（与 `styles.css` 的 `--dsw-font-family` 同源，保证导出与屏幕一致） */
export function glyphFont(size: number): string {
  return `${Math.max(8, Math.round(size))}px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Helvetica, Arial, sans-serif`;
}

/** 纸面网格间距（页面坐标）；横线用同一个刻度，视觉上才是一套纸 */
const RULE_STEP = 62;
const PAPER_LINE = "#e6e9ef";
const PAPER_STRONG = "#d6dbe4";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function clamp01(n: number): number {
  return clamp(Number.isFinite(n) ? n : 0, 0, 1);
}

/** 保留小数位（序列化用；笔迹精度到 0.1px 已远超屏幕可分辨能力，却能省掉一半体积） */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 新建一个空页面 */
export function emptyPage(paper: InkPaper = "grid", w = A4_W, h = A4_H): InkPage {
  return { paper, w, h, strokes: [] };
}

/** 新文档（默认 1 页） */
export function emptyDoc(paper: InkPaper = "grid"): InkDoc {
  return { v: 1, pages: [emptyPage(paper)] };
}

export function cloneStroke(s: InkStroke): InkStroke {
  return { tool: s.tool, color: s.color, size: s.size, pts: s.pts.map((p) => ({ x: p.x, y: p.y, p: p.p })) };
}

export function clonePage(page: InkPage): InkPage {
  return {
    paper: page.paper,
    w: page.w,
    h: page.h,
    strokes: page.strokes.map(cloneStroke),
    bg: page.bg ?? null,
  };
}

export function cloneDoc(doc: InkDoc): InkDoc {
  return { v: 1, pages: doc.pages.map(clonePage) };
}

/** 笔迹点数（页面徽标用；不做全文扫描之外的事） */
export function docPointCount(doc: InkDoc): number {
  let n = 0;
  for (const pg of doc.pages) for (const s of pg.strokes) n += s.pts.length;
  return n;
}

export function docStrokeCount(doc: InkDoc): number {
  let n = 0;
  for (const pg of doc.pages) n += pg.strokes.length;
  return n;
}

// ---------------------------------------------------------------------------
// 输入：PointerEvent → 压感 / 是否画笔
// ---------------------------------------------------------------------------

/** 只取我们真正用到的那几个字段（便于在测试与浏览器外环境里构造假事件） */
export interface PenLikeEvent {
  pointerType: string;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  width?: number;
  height?: number;
}

/**
 * 从指针事件取**归一化压感**。
 *
 * 规则（这三条都是"如实"取向，不是"好看"取向）：
 *   · `pointerType === "pen"` → 用事件自己的 `pressure`（0–1）；
 *   · 非笔（mouse / touch）→ **固定 0.5**：鼠标没有压感，手指也没有。给 0 会让线宽趋近下限、
 *     看起来"画不出来"；给 1 又会显得比笔更粗 —— 0.5 与笔的中间压力一致；
 *   · 笔报告的 `pressure === 0`：这是"笔尖没接触"的合法读数（悬停），**照实给 0**，
 *     调用方据此决定不落点（见 `Handwrite.tsx` 的 `pointerdown` 判定）。
 *
 * ⚠ 已知差异：部分设备的 WebView 对笔**恒报 0.5**（不支持压感，或系统没开压感）。
 *   这时笔迹是等宽的 —— 这是如实的现象，不假装"有压感"。界面上有「压感检测」按钮可以自测。
 */
export function pressureOf(e: PenLikeEvent): number {
  if (e.pointerType !== "pen") return 0.5;
  return clamp01(e.pressure);
}

/** 倾斜（度）。没有倾斜能力的设备返回 0/0，界面据此显示「这支笔不报倾斜」 */
export function tiltOf(e: PenLikeEvent): { x: number; y: number } {
  return {
    x: e.pointerType === "pen" && Number.isFinite(e.tiltX) ? (e.tiltX as number) : 0,
    y: e.pointerType === "pen" && Number.isFinite(e.tiltY) ? (e.tiltY as number) : 0,
  };
}

/**
 * 接触面积（`width`/`height`，CSS 像素）。鼠标返回 0（规范如此），笔/手指才有值。
 * 用途仅限**诊断显示**（自检面板）——不参与绘制：面积与压感在不同设备上相关性太弱。
 */
export function contactSize(e: PenLikeEvent): number {
  const w = Number.isFinite(e.width) ? (e.width as number) : 0;
  const h = Number.isFinite(e.height) ? (e.height as number) : 0;
  return Math.max(w, h);
}

// ---------------------------------------------------------------------------
// 线宽：压感 → 实际线宽
// ---------------------------------------------------------------------------

/**
 * 压感 → 线宽系数。
 *
 * 取 `0.5 + 1.0 * p`：p=0.5 时系数正好 1.0（**基准线宽就是"中等力度"的线宽**），
 * p→0 收细到 0.5 倍，p→1 涨到 1.5 倍。这样"粗细"滑杆的数值与用户看到的线宽是对得上的。
 */
export function widthAt(tool: InkTool, size: number, p: number): number {
  const base = clamp(size, MIN_SIZE, MAX_SIZE);
  // 荧光笔 / 直线 / 符号 / 橡皮**都不随压力变宽**：
  // 直线要像尺子画的、符号是字形、荧光笔是色带、橡皮是固定半径 —— 它们变宽只会让人觉得"不受控"。
  if (tool === "marker" || tool === "eraser" || tool === "line" || tool === "stamp") return base;
  const f = 0.5 + 1.0 * clamp01(p);
  return Math.max(0.4, base * f);
}

/** 每种工具的绘制状态（透明度 / 叠加方式）。抽出来是为了"渲染"与"导出"共用同一套口径 */
export function toolStyle(tool: InkTool): {
  alpha: number;
  /** 是否用 multiply 叠加（荧光笔要"透"过下层墨色，而不是盖住） */
  multiply: boolean;
  /** 铅笔的粗糙度（页面坐标下的抖动幅度） */
  jitter: number;
} {
  switch (tool) {
    case "marker":
      return { alpha: 0.32, multiply: true, jitter: 0 };
    case "pencil":
      return { alpha: 0.9, multiply: false, jitter: 0.35 };
    case "eraser":
    case "select":
      return { alpha: 1, multiply: false, jitter: 0 };
    // 直线 = 尺子画的线：等宽、不抖、不透明
    case "line":
    case "stamp":
    case "pen":
    default:
      return { alpha: 1, multiply: false, jitter: 0 };
  }
}

// ---------------------------------------------------------------------------
// 采样：原始点 → 密集折线（断开处分成多段）
// ---------------------------------------------------------------------------

/**
 * **单段**加密：给定四个控制点，返回 `p1 → p2` 之间的采样点（含 `p2`，不含 `p1`）。
 *
 * 为什么要有"单段"版本：书写时的**增量绘制**只能在新点到达后才画上一段
 * （Catmull-Rom 需要 `p3` 才能确定曲率）。单段版本让"边写边画"与"整笔重绘"用**同一个公式**，
 * 所以抬手那一刻**不会出现笔迹位置突然一动**（那种"snap"是手写手感的第一杀手）。
 */
export function densifySegment(
  p0: InkPoint,
  p1: InkPoint,
  p2: InkPoint,
  p3: InkPoint,
  spacing: number,
): InkPoint[] {
  const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const out: InkPoint[] = [];
  if (d < 0.2) return out;
  const n = Math.max(1, Math.ceil(d / Math.max(0.5, spacing)));
  for (let k = 1; k <= n; k += 1) {
    const t = k / n;
    const t2 = t * t;
    const t3 = t2 * t;
    const f0 = -0.5 * t3 + t2 - 0.5 * t;
    const f1 = 1.5 * t3 - 2.5 * t2 + 1;
    const f2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const f3 = 0.5 * t3 - 0.5 * t2;
    out.push({
      x: p0.x * f0 + p1.x * f1 + p2.x * f2 + p3.x * f3,
      y: p0.y * f0 + p1.y * f1 + p2.y * f2 + p3.y * f3,
      p: p1.p + (p2.p - p1.p) * t,
    });
  }
  return out;
}

/**
 * 把一条笔迹的原始采样点**加密**成两条相邻点间距 ≈ `spacing` 的折线，并保留压感。
 *
 * 三个必须处理的真实情况：
 *   ① **单点**（点一下）：返回 [p, p] 这种"零长线段"——圆头线帽会把它画成一个圆点，
 *      这是"点一下就有一个点"的常见预期；
 *   ② **大跳变**（两个采样点隔得很远）：判定为**断笔**（笔离开屏幕又落下 / 丢帧），
 *      在此处切断，不做插值 —— 插值会拖出一条笔直的、根本不是用户写的线；
 *   ③ 相邻点极近（< 0.2px）：直接跳过，避免除零与无意义的点。
 *
 * 平滑用 Catmull-Rom（经过控制点，不产生"抄近路"的变形），与单段版本 `densifySegment` 同源。
 */
export function densify(pts: readonly InkPoint[], spacing: number, breakAt = 60): InkPoint[][] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [[{ x: pts[0].x, y: pts[0].y, p: pts[0].p }, { x: pts[0].x, y: pts[0].y, p: pts[0].p }]];
  const out: InkPoint[][] = [];
  let run: InkPoint[] = [{ x: pts[0].x, y: pts[0].y, p: pts[0].p }];

  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 0.2) continue; // ③ 极近点：噪声，丢掉
    if (d > breakAt) {
      // ② 断笔：收掉当前折线，另起一段（**不插值**）
      out.push(run);
      run = [{ x: b.x, y: b.y, p: b.p }];
      continue;
    }
    const p0 = pts[i - 2] ?? a;
    const p3 = pts[i + 1] ?? b;
    for (const q of densifySegment(p0, a, b, p3, spacing)) run.push(q);
  }
  if (run.length > 0) out.push(run);
  return out;
}

/** 单点笔迹的"圆点"：一个零长折线，由圆头线帽画出圆点（增量绘制与批量绘制共用） */
export function dotRun(stroke: InkStroke): InkRun {
  const w = quantW(widthAt(stroke.tool, stroke.size, stroke.pts[0]?.p ?? 0.5));
  const x = stroke.pts[0]?.x ?? 0;
  const y = stroke.pts[0]?.y ?? 0;
  return { w, flat: [x, y, x, y] };
}

/**
 * 一条笔迹的包围盒（页面坐标；空笔迹返回 null）。
 * 橡皮的"只重画被影响的那一小块"要靠它挑出真正需要重画的笔迹 —— 否则一次擦除要重画整页。
 */
export function strokeBBox(s: InkStroke): { x0: number; y0: number; x1: number; y1: number } | null {
  if (s.pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  // 把线宽/抖动造成的溢出算进去，避免"重画区域差一个像素"留下残影
  // （符号的溢出是"字的外框"，与线宽不是一回事）
  const pad = s.tool === "stamp" ? stampFontSize(s.size) * 0.75 + 2 : s.size * 1.6 + 2;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// ---------------------------------------------------------------------------
// 绘制：折线 → 按线宽分段的"绘制指令"
// ---------------------------------------------------------------------------

/** 一段等宽折线：`flat` 是平铺的 `[x0,y0,x1,y1,…]`，`w` 是这整段的线宽 */
export interface InkRun {
  w: number;
  flat: number[];
}

/**
 * 把一条笔迹变成若干**等宽折线**（这是"一页几百条笔迹也能秒重绘"的关键）。
 *
 * 线宽按 0.5px 量化后分组：相邻两点算出线宽 → 量化 → 与当前段一致就继续接，
 * 不一致就**在共享点上收尾并另起一段**（保证分段处几何连续，不出现断口）。
 *
 * 铅笔的抖动（`jitter`）在这里施加：抖动**由点位下标决定**（不是随机数），
 * 所以同一条笔迹每次重绘的位置完全一致 —— 否则"撤销后红屏"会看到笔迹在抖，像出了 bug。
 */
export function strokeRuns(stroke: InkStroke, strength: number): InkRun[] {
  // 符号不是"折线"，它由 `drawStroke` 的字体分支画，没有可 stroke 的路径
  if (stroke.tool === "stamp") return [];
  const style = toolStyle(stroke.tool);
  const spacing = clamp(stroke.size * 0.3, 0.8, 3);
  const polys = densify(stroke.pts, spacing);
  const runs: InkRun[] = [];

  for (const poly of polys) {
    if (poly.length < 2) continue;
    let curW = quantW(widthAt(stroke.tool, stroke.size, poly[0].p));
    let flat: number[] = [r1(poly[0].x), r1(poly[0].y)];
    for (let i = 1; i < poly.length; i += 1) {
      const a = poly[i - 1];
      const b = poly[i];
      const w = quantW(widthAt(stroke.tool, stroke.size, (a.p + b.p) / 2));
      let bx = b.x;
      let by = b.y;
      if (style.jitter > 0) {
        // 确定性抖动：下标驱动，不是随机数
        const k = (i * 2654435761) % 1000;
        const k2 = (i * 40503) % 1000;
        bx += ((k / 1000) * 2 - 1) * style.jitter * strength;
        by += ((k2 / 1000) * 2 - 1) * style.jitter * strength;
      }
      if (w !== curW) {
        // 线宽变了：当前段收尾（含 b 之前的点），另起一段并从 a 接上
        flat.push(r1(a.x), r1(a.y));
        runs.push({ w: curW, flat });
        curW = w;
        flat = [r1(a.x), r1(a.y)];
      }
      flat.push(r1(bx), r1(by));
    }
    if (flat.length >= 4) runs.push({ w: curW, flat });
  }
  return runs;
}

/** 线宽量化（0.5px 一档） */
function quantW(w: number): number {
  return Math.max(0.4, Math.round(w * 2) / 2);
}

/**
 * 一步绘制实际使用的线宽（**压感 → 线宽 → 0.5px 量化**）。
 *
 * ⚠ 增量绘制（边写边画）与批量绘制（整页重绘）**必须都走这个函数**：
 * 两处任何一处自己算线宽，抬手那一刻笔迹粗细就会跳一下 —— 这是手写手感最忌讳的事。
 */
export function displayWidth(tool: InkTool, size: number, p: number): number {
  return quantW(widthAt(tool, size, p));
}

/**
 * 折线段的**缓存**（`WeakMap`，key 是笔迹对象本身）。
 *
 * 为什么必须有：`strokeRuns()` 里的 Catmull-Rom 加密是**每次重绘都要重算**的纯计算，
 * 一页几百条笔迹时它才是重绘的真正瓶颈（`ctx.stroke()` 反而很便宜）。
 * 平移、缩放、橡皮局部重画都会触发整页重绘，不缓存就会在平板上直接卡成幻灯片。
 *
 * 依赖的**不变式**：一条笔迹提交进文档后**点集不再被修改**（所有的"改"都是替换整个对象：
 * 擦除重建、撤销换数组）。违反它的唯一后果是"屏幕上显示的是旧的几何"，不会崩 —— 但仍要守住。
 * 用 `WeakMap` 而不是在笔迹上挂字段：不污染可序列化的数据（`serializeDoc` 只认 tensor 字段）。
 */
const RUN_CACHE = new WeakMap<InkStroke, InkRun[]>();

/** 取（或算一次并缓存）这条笔迹的等宽折线段 */
export function cachedRuns(stroke: InkStroke): InkRun[] {
  const hit = RUN_CACHE.get(stroke);
  if (hit) return hit;
  const runs = strokeRuns(stroke, 1);
  RUN_CACHE.set(stroke, runs);
  return runs;
}

/**
 * 画一条笔迹（不含纸面）。
 *
 * `alphaScale` 用于"某一页正在淡出"之类的过渡；正常绘制传 1。
 * 橡皮笔迹**不进数据**（擦是删点，不是画白线），所以这里只有三种工具的样式。
 */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, alphaScale = 1): void {
  if (stroke.pts.length === 0) return;
  // R14b：标注符号走字体分支（没有路径可 stroke）
  if (stroke.tool === "stamp") {
    const pt = stroke.pts[0];
    ctx.save();
    ctx.globalAlpha = clamp01(alphaScale);
    ctx.fillStyle = stroke.color;
    ctx.font = glyphFont(stampFontSize(stroke.size));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stroke.glyph ?? "？", pt.x, pt.y);
    ctx.restore();
    return;
  }
  const style = toolStyle(stroke.tool);
  const runs = cachedRuns(stroke);
  if (runs.length === 0) return;

  const prevAlpha = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalAlpha = clamp01(style.alpha * alphaScale);
  if (style.multiply) ctx.globalCompositeOperation = "multiply";
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const run of runs) {
    ctx.lineWidth = run.w;
    ctx.beginPath();
    ctx.moveTo(run.flat[0], run.flat[1]);
    for (let i = 2; i < run.flat.length; i += 2) ctx.lineTo(run.flat[i], run.flat[i + 1]);
    // 单点笔迹：flat 长度 4，moveTo + lineTo 同一坐标 → 圆头线帽画出圆点
    ctx.stroke();
  }

  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevOp;
}

// ---------------------------------------------------------------------------
// 纸面
// ---------------------------------------------------------------------------

/**
 * 底图缓存（dataURL → 已解码的 `HTMLImageElement`）。
 *
 * 为什么用模块级缓存：`renderPage()` / `drawPageContent()` 都是**同步**的（导出、重绘都在
 * 事件回调里），没法在其中 `await` 一张图的解码。所以约定：
 *   · 想画底图，先 `await ensureBgLoaded(url)`（视图在载入笔记 / 插入图片时调一次）；
 *   · 之后所有同步绘制路径都从缓存里取，取不到就**不画底图**（宁可少画，也不阻塞或抛错）。
 */
const BG_CACHE = new Map<string, HTMLImageElement>();

/** 预解码一张底图；失败返回 null（调用方如实提示，不静默） */
export function ensureBgLoaded(url: string): Promise<HTMLImageElement | null> {
  const hit = BG_CACHE.get(url);
  if (hit) return Promise.resolve(hit.complete && hit.naturalWidth > 0 ? hit : null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      BG_CACHE.set(url, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 这张底图**现在**能不能同步画出来（给纯绘制路径用；不会触发加载） */
export function bgReady(url: string | null | undefined): boolean {
  if (!url) return false;
  const img = BG_CACHE.get(url);
  return !!img && img.complete && img.naturalWidth > 0;
}

/**
 * 画纸面底纹（**只画底纹，不铺白底**：白底由调用方决定，导出时才是必须的）。
 * `scale` 是当前缩放，用来让 1px 的线在放大后不至于变成虚影。
 */export function drawPaper(ctx: CanvasRenderingContext2D, page: InkPage, scale = 1): void {
  if (page.paper === "blank") return;
  const px = 1 / Math.max(0.2, scale);
  ctx.save();
  ctx.lineWidth = px;
  ctx.strokeStyle = PAPER_LINE;

  if (page.paper === "grid") {
    ctx.beginPath();
    for (let x = RULE_STEP; x < page.w; x += RULE_STEP) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, page.h);
    }
    for (let y = RULE_STEP; y < page.h; y += RULE_STEP) {
      ctx.moveTo(0, y);
      ctx.lineTo(page.w, y);
    }
    ctx.stroke();
  } else if (page.paper === "lines") {
    ctx.beginPath();
    for (let y = RULE_STEP; y < page.h; y += RULE_STEP) {
      ctx.moveTo(0, y);
      ctx.lineTo(page.w, y);
    }
    ctx.stroke();
  } else {
    // 点阵
    ctx.fillStyle = PAPER_STRONG;
    const r = px * 1.2;
    for (let x = RULE_STEP; x < page.w; x += RULE_STEP) {
      for (let y = RULE_STEP; y < page.h; y += RULE_STEP) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/**
 * 画一页（底图 → 纸面底纹 → **底层笔迹** → 其余笔迹），坐标原点是页面左上角；
 * **不开白底**，由调用方铺。
 *
 * R14b：分两趟画 —— `behind`（荧光高亮带）必须在所有墨迹之下，
 * 否则"划重点"会盖住字，那不是高亮，那是涂黑。
 */
export function drawPageContent(ctx: CanvasRenderingContext2D, page: InkPage, scale = 1): void {
  const bg = page.bg ? BG_CACHE.get(page.bg) : undefined;
  if (bg && bg.complete && bg.naturalWidth > 0) {
    // 等比铺满并居中（contain）：宁可留白边也不拉伸变形 —— 讲义截图被拉扁就没法在上面圈画了
    const s = Math.min(page.w / bg.naturalWidth, page.h / bg.naturalHeight);
    const w = bg.naturalWidth * s;
    const h = bg.naturalHeight * s;
    ctx.drawImage(bg, (page.w - w) / 2, (page.h - h) / 2, w, h);
  }
  drawPaper(ctx, page, scale);
  for (const s of page.strokes) if (s.behind) drawStroke(ctx, s, 1);
  for (const s of page.strokes) if (!s.behind) drawStroke(ctx, s, 1);
}

// ---------------------------------------------------------------------------
// 命中测试与橡皮（"擦"= 删点 + 断笔，不是画白线）
// ---------------------------------------------------------------------------

/** 点到线段距离的平方（避免开方，命中测试里够用） */
function distToSeg2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-9) t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** 这一笔是否被一个圆擦到 */
export function strokeHit(stroke: InkStroke, x: number, y: number, radius: number): boolean {
  // 符号：命中判定按字的外框（约 0.6 倍字号）而不是"点到点的距离"，
  // 否则一个 18px 的 ✓ 要在它正中心才能擦到，手感很怪
  if (stroke.tool === "stamp") {
    const r = radius + stampFontSize(stroke.size) * 0.6;
    const dx = (stroke.pts[0]?.x ?? 0) - x;
    const dy = (stroke.pts[0]?.y ?? 0) - y;
    return dx * dx + dy * dy <= r * r;
  }
  const r = radius + stroke.size / 2;
  const r2 = r * r;
  const pts = stroke.pts;
  if (pts.length === 1) {
    const dx = pts[0].x - x;
    const dy = pts[0].y - y;
    return dx * dx + dy * dy <= r2;
  }
  for (let i = 1; i < pts.length; i += 1) {
    if (distToSeg2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) return true;
  }
  return false;
}

/**
 * 在 `(x,y)` 处用一个半径 `radius` 的圆擦一次，返回**新的笔迹数组**。
 *
 * 语义是"删点"：被擦到的点被移除，剩下的点按**连续区间**重新组装成新笔迹（断笔语义）——
 * 所以从中间擦一刀会把一笔断成两笔，这是手写应用的常规行为，也是"橡皮"该有的样子。
 *
 * 只落单的点（孤立点）直接丢弃：一个点擦不了东西，留着还会在撤销栈里制造噪声。
 * **不修改传入的 page**（返回新数组），调用方负责替换 —— 便于撤销栈保存"擦之前"的原状。
 */
export function eraseAt(strokes: readonly InkStroke[], x: number, y: number, radius: number): InkStroke[] {
  const out: InkStroke[] = [];
  for (const s of strokes) {
    const hit = strokeHit(s, x, y, radius);
    if (!hit) {
      out.push(s);
      continue;
    }
    const r = radius + s.size / 2;
    const r2 = r * r;
    let run: InkPoint[] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ tool: s.tool, color: s.color, size: s.size, pts: run });
      run = [];
    };
    for (const p of s.pts) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy <= r2) flush();
      else run.push(p);
    }
    flush();
  }
  return out;
}

/** 一个矩形范围内（套索/框选）的笔迹下标 */
export function strokesInRect(
  strokes: readonly InkStroke[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  /** R14b：命中判定放宽的量（页面坐标）。>0 时只要求笔迹**外接框**与选框相交 */
  slack = 0,
): number[] {
  const lx = Math.min(x0, x1) - slack;
  const rx = Math.max(x0, x1) + slack;
  const ty = Math.min(y0, y1) - slack;
  const by = Math.max(y0, y1) + slack;
  const idx: number[] = [];
  strokes.forEach((s, i) => {
    // 判定用"笔迹的外接框与选框相交"：比"每个点都在框内"宽容得多，
    // 符合用户"圈住这一块"的直觉（要求整笔都在框内会让人觉得选不中）
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (const p of s.pts) {
      if (p.x < sx0) sx0 = p.x;
      if (p.y < sy0) sy0 = p.y;
      if (p.x > sx1) sx1 = p.x;
      if (p.y > sy1) sy1 = p.y;
    }
    if (sx1 >= lx && sx0 <= rx && sy1 >= ty && sy0 <= by) idx.push(i);
  });
  return idx;
}

// ---------------------------------------------------------------------------
// R14b：框选 · 高亮 · 移动（全部是纯函数：返回**新**数组，绝不就地改原笔迹）
// ---------------------------------------------------------------------------

/**
 * 平移一批笔迹。
 *
 * ⚠ 必须返回**新对象**：原对象还挂在撤销栈里当"改之前"的那一份，就地改点会让撤销变成"没改过"。
 *   这也是折线缓存 `RUN_CACHE` 能一直有效的前提（对象一变就不再复用缓存，是 WeakMap 的天然行为）。
 */
export function translateStrokes(strokes: readonly InkStroke[], dx: number, dy: number): InkStroke[] {
  return strokes.map((s) => ({
    tool: s.tool,
    color: s.color,
    size: s.size,
    behind: s.behind,
    glyph: s.glyph,
    pts: s.pts.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p })),
  }));
}

/** 一批笔迹的并集外接框（空数组 → null）。框选的虚线框、移动的按钮定位都靠它 */
export function unionBBox(
  strokes: readonly InkStroke[],
): { x0: number; y0: number; x1: number; y1: number } | null {
  let out: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const s of strokes) {
    const bb = strokeBBox(s);
    if (!bb) continue;
    out = out
      ? {
          x0: Math.min(out.x0, bb.x0),
          y0: Math.min(out.y0, bb.y0),
          x1: Math.max(out.x1, bb.x1),
          y1: Math.max(out.y1, bb.y1),
        }
      : { ...bb };
  }
  return out;
}

/**
 * 由选中的笔迹生成**荧光高亮带**（`behind = true`，铺在字下面）。
 *
 * 三条设计取舍：
 *   · **抽稀**（默认每条最多 60 个点）：高亮带是色块，不需要保留手写的高频抖动；
 *     不抽稀的话"高亮一段 1500 个点的板书"会让数据量翻倍；
 *   · 线宽 = 原线宽 × 4（并夹在 8–60）：既盖得住一行字，又不至于连成一片；
 *   · **符号不参与**（`stamp` 跳过）：给一个 ✓ 套一圈色带很怪，用户也看不明白。
 */
export function highlightFor(
  strokes: readonly InkStroke[],
  color: string,
  opts: { scale?: number; maxPoints?: number } = {},
): InkStroke[] {
  const scale = opts.scale ?? 4;
  const maxPoints = opts.maxPoints ?? 60;
  const out: InkStroke[] = [];
  for (const s of strokes) {
    if (s.tool === "stamp" || s.pts.length < 2) continue;
    const step = Math.max(1, Math.ceil(s.pts.length / maxPoints));
    const pts: InkPoint[] = [];
    for (let i = 0; i < s.pts.length; i += step) pts.push({ x: s.pts[i].x, y: s.pts[i].y, p: 0.5 });
    const last = s.pts[s.pts.length - 1];
    const tail = pts[pts.length - 1];
    if (!tail || tail.x !== last.x || tail.y !== last.y) pts.push({ x: last.x, y: last.y, p: 0.5 });
    out.push({
      tool: "marker",
      color,
      size: clamp(s.size * scale, 8, 60),
      pts,
      behind: true,
    });
  }
  return out;
}

/** 给一批笔迹换颜色（工具、线宽、符号、层序全部保留 —— 只换色） */
export function recolorStrokes(strokes: readonly InkStroke[], color: string): InkStroke[] {
  return strokes.map((s) => ({
    tool: s.tool,
    color,
    size: s.size,
    behind: s.behind,
    glyph: s.glyph,
    pts: s.pts.map((p) => ({ x: p.x, y: p.y, p: p.p })),
  }));
}

// ---------------------------------------------------------------------------
// 撤销栈（操作栈，不是整页快照）
// ---------------------------------------------------------------------------

/**
 * 一步可撤销的操作。每条都自带**正反两向**（`invert()` 给出反向操作）。
 *
 * ⚠ 这里刻意**只有一种笔迹操作**（`strokes`：整份笔迹数组的前后两份**浅拷贝**），
 * 而不是"新增一笔 / 擦掉一笔 / 清空"三种：
 *   · 三种写法的反向各不相同，`add` 的反向必须是"按引用删掉那一笔"——用"整数组替换"表达时
 *     极容易写成 `after: []`（撤销一步就把整页擦光）。这是实现期真实踩过的坑，写在这里防复发；
 *   · 浅拷贝只复制**引用**（一页几百条笔迹就是几百个指针，几 KB），不是深拷贝笔迹点；
 *   · 于是撤销栈的内存只与"笔迹条数 × 步数"有关，与"每笔多少个点"无关 —— 平板上不会被撑爆。
 *
 * 为什么不用"整页深拷贝快照"：一页密集书写的序列化在几百 KB 量级，100 步快照就是几十 MB。
 */
export type InkOp =
  | { kind: "strokes"; page: number; before: InkStroke[]; after: InkStroke[] }
  | { kind: "paper"; page: number; before: InkPaper; after: InkPaper }
  | { kind: "insertPage"; index: number; page: InkPage }
  | { kind: "removePage"; index: number; page: InkPage }
  | { kind: "movePage"; from: number; to: number };

function invert(op: InkOp): InkOp {
  switch (op.kind) {
    case "strokes":
      return { kind: "strokes", page: op.page, before: op.after, after: op.before };
    case "paper":
      return { kind: "paper", page: op.page, before: op.after, after: op.before };
    case "insertPage":
      return { kind: "removePage", index: op.index, page: op.page };
    case "removePage":
      return { kind: "insertPage", index: op.index, page: op.page };
    case "movePage":
      return { kind: "movePage", from: op.to, to: op.from };
  }
}

/** 就地执行一条操作（**不**入栈；入栈由 `pushOp` 负责） */
export function applyOp(doc: InkDoc, op: InkOp): void {
  switch (op.kind) {
    case "strokes": {
      const pg = doc.pages[op.page];
      if (pg) pg.strokes = op.after;
      return;
    }
    case "paper": {
      const pg = doc.pages[op.page];
      if (pg) pg.paper = op.after;
      return;
    }
    case "insertPage": {
      doc.pages.splice(clamp(op.index, 0, doc.pages.length), 0, op.page);
      return;
    }
    case "removePage": {
      if (doc.pages.length <= 1) return; // 最后一页不许删：没有页面的文档无处可写
      doc.pages.splice(clamp(op.index, 0, doc.pages.length - 1), 1);
      return;
    }
    case "movePage": {
      const from = clamp(op.from, 0, doc.pages.length - 1);
      const to = clamp(op.to, 0, doc.pages.length - 1);
      if (from === to) return;
      const [p] = doc.pages.splice(from, 1);
      doc.pages.splice(to, 0, p);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 撤销栈（操作栈）
// ---------------------------------------------------------------------------

/** 撤销栈上限（步）。100 步对"写错一个字"这类场景远远够用，也不会让内存长草。 */
export const HISTORY_MAX = 100;

export interface InkHistory {
  undo: InkOp[];
  redo: InkOp[];
}

export function newHistory(): InkHistory {
  return { undo: [], redo: [] };
}

/** 记录一步（清空重做栈 —— 所有编辑器的一致语义：改了新的，旧的重做链就作废） */
export function pushOp(h: InkHistory, op: InkOp): void {
  h.undo.push(op);
  if (h.undo.length > HISTORY_MAX) h.undo.shift();
  h.redo.length = 0;
}

/** 撤销一步（返回是否真的撤销了） */
export function undo(doc: InkDoc, h: InkHistory): boolean {
  const op = h.undo.pop();
  if (!op) return false;
  applyOp(doc, invert(op));
  h.redo.push(op);
  return true;
}

/** 重做一步 */
export function redo(doc: InkDoc, h: InkHistory): boolean {
  const op = h.redo.pop();
  if (!op) return false;
  applyOp(doc, op);
  h.undo.push(op);
  return true;
}

// ---------------------------------------------------------------------------
// 提交入口（视图只用这几个函数改文档 —— 保证"每一次改动都进撤销栈"）
// ---------------------------------------------------------------------------

/** 落下一笔（调用方保证 `stroke.pts.length >= 1`） */
export function commitAddStroke(doc: InkDoc, h: InkHistory, page: number, stroke: InkStroke): void {
  const pg = doc.pages[page];
  if (!pg) return;
  const before = pg.strokes.slice();
  const after = before.concat([stroke]);
  pg.strokes = after;
  pushOp(h, { kind: "strokes", page, before, after });
}

/** 在一个点上擦一次（返回是否有任何笔迹被擦到 —— 没擦到时**不入撤销栈**） */
export function commitErase(
  doc: InkDoc,
  h: InkHistory,
  page: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  const pg = doc.pages[page];
  if (!pg) return false;
  const before = pg.strokes.slice();
  const after = eraseAt(before, x, y, radius);
  if (after.length === before.length && after.every((s, i) => s === before[i])) return false;
  pg.strokes = after;
  pushOp(h, { kind: "strokes", page, before, after });
  return true;
}

/** 清空当前页（空页不入栈） */
export function commitClear(doc: InkDoc, h: InkHistory, page: number): boolean {
  const pg = doc.pages[page];
  if (!pg || pg.strokes.length === 0) return false;
  const before = pg.strokes.slice();
  pg.strokes = [];
  pushOp(h, { kind: "strokes", page, before, after: [] });
  return true;
}

/** 换纸面样式 */
export function commitPaper(doc: InkDoc, h: InkHistory, page: number, paper: InkPaper): void {
  const pg = doc.pages[page];
  if (!pg || pg.paper === paper) return;
  const before = pg.paper;
  pg.paper = paper;
  pushOp(h, { kind: "paper", page, before, after: paper });
}

/** 在某页之后插入一页，返回新页的下标 */
export function commitInsertPage(doc: InkDoc, h: InkHistory, index: number): number {
  const at = clamp(index, 0, doc.pages.length);
  const page = emptyPage("grid", doc.pages[0]?.w ?? A4_W, doc.pages[0]?.h ?? A4_H);
  doc.pages.splice(at, 0, page);
  pushOp(h, { kind: "insertPage", index: at, page });
  return at;
}

/** 删除一页（只剩一页时拒绝，如实返回 false） */
export function commitRemovePage(doc: InkDoc, h: InkHistory, index: number): boolean {
  if (doc.pages.length <= 1) return false;
  const at = clamp(index, 0, doc.pages.length - 1);
  const [page] = doc.pages.splice(at, 1);
  pushOp(h, { kind: "removePage", index: at, page });
  return true;
}

/** 调换两页顺序 */
export function commitMovePage(doc: InkDoc, h: InkHistory, from: number, to: number): boolean {
  const a = clamp(from, 0, doc.pages.length - 1);
  const b = clamp(to, 0, doc.pages.length - 1);
  if (a === b) return false;
  const [p] = doc.pages.splice(a, 1);
  doc.pages.splice(b, 0, p);
  pushOp(h, { kind: "movePage", from: a, to: b });
  return true;
}

// ---------------------------------------------------------------------------
// 序列化（紧凑 JSON；这是跟着笔记一起备份的**唯一**真源）
// ---------------------------------------------------------------------------

/**
 * 工具代号（**短**是这个格式的立足点：一页几万个点，每个点省 2 个字节就是几十 KB）。
 *
 * ⚠ `eraser` / `select` 刻意**没有代号**：它们不产生笔迹（擦是删点、选框不进数据）。
 *   编解码表都用 `InkDrawTool` 收口，让"橡皮笔迹混进库"这件事在类型层面就不可能发生。
 */
const TOOL_CODE: Record<InkDrawTool, string> = { pen: "n", pencil: "c", marker: "m", line: "l", stamp: "k" };
const CODE_TOOL: Record<string, InkDrawTool> = { n: "pen", c: "pencil", m: "marker", l: "line", k: "stamp" };

interface WireStroke {
  t: string;
  c: string;
  s: number;
  /** 平铺三元组 `[x,y,p, x,y,p, …]` */
  p: number[];
  /** R14b：`1` = 画在底层（荧光高亮带） */
  b?: number;
  /** R14b：标注符号（`t === "k"` 时才有） */
  g?: string;
}

interface WireDoc {
  v: number;
  pages: Array<{ paper: string; w: number; h: number; strokes: WireStroke[]; bg?: string }>;
}

/**
 * 文档 → 字符串。
 *
 * 格式取舍：点用**平铺数组 + 三元组**而不是对象数组 ——
 * `[{"x":1,"y":2,"p":0.5},…]` 每点约 30 字节，`[1,2,0.5,…]` 约 14 字节，
 * 一页密集书写（约 4 万个点）就是 1.2 MB 与 560 KB 的差别，而这串数据要**跟着笔记进 SQLite**。
 */
export function serializeDoc(doc: InkDoc): string {
  const wire: WireDoc = {
    v: 1,
    pages: doc.pages.map((pg) => {
      const one: WireDoc["pages"][number] = {
        paper: pg.paper,
        w: Math.round(pg.w),
        h: Math.round(pg.h),
        strokes: pg.strokes.map((s) => {
          const p: number[] = [];
          for (const pt of s.pts) p.push(r1(pt.x), r1(pt.y), r2(pt.p));
          const one: WireStroke = { t: TOOL_CODE[s.tool] ?? "n", c: s.color, s: r1(s.size), p };
          if (s.behind) one.b = 1;
          if (s.glyph) one.g = s.glyph;
          return one;
        }),
      };
      // 底图按原样带上（**不重编码**：重编码会损失画质，且它本来就是压缩过的）
      if (pg.bg) one.bg = pg.bg;
      return one;
    }),
  };
  return JSON.stringify(wire);
}

/**
 * 字符串 → 文档。**任何一处不合法就返回 null**（调用方必须如实告诉用户"这段笔迹数据读不出来"，
 * 绝不返回一个半截的、看起来能用的文档 —— 那会让用户以为笔记丢了却不知道丢在哪）。
 *
 * 校验口径刻意保守：页数 ≥1、尺寸有限且为正、点三元组长度是 3 的倍数。
 */
export function parseDoc(text: string): InkDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const d = raw as Partial<WireDoc> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.pages) || d.pages.length === 0) return null;
  const pages: InkPage[] = [];
  for (const pg of d.pages) {
    const w = Number(pg?.w);
    const h = Number(pg?.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const paper = (typeof pg?.paper === "string" && pg.paper in PAPER_LABEL ? pg.paper : "grid") as InkPaper;
    const strokes: InkStroke[] = [];
    const src = Array.isArray(pg?.strokes) ? pg.strokes : [];
    for (const s of src) {
      if (!s || typeof s !== "object") return null;
      const flat = Array.isArray(s.p) ? s.p : null;
      if (!flat || flat.length === 0 || flat.length % 3 !== 0) return null;
      const pts: InkPoint[] = [];
      for (let i = 0; i < flat.length; i += 3) {
        const x = Number(flat[i]);
        const y = Number(flat[i + 1]);
        const p = Number(flat[i + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p)) return null;
        pts.push({ x, y, p: clamp01(p) });
      }
      strokes.push({
        tool: CODE_TOOL[String(s.t)] ?? "pen",
        color: typeof s.c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s.c) ? s.c : "#1f2328",
        size: clamp(Number(s.s) || 3, MIN_SIZE, MAX_SIZE),
        pts,
        // `b` 只认字面量 1；符号只认 1–4 个字符（挡住把整段文本塞进来的脏数据）
        behind: s.b === 1 ? true : undefined,
        glyph: typeof s.g === "string" && s.g.length > 0 && s.g.length <= 4 ? s.g : undefined,
      });
    }
    const bg = typeof pg?.bg === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(pg.bg) ? pg.bg : null;
    pages.push({ paper, w: Math.round(w), h: Math.round(h), strokes, bg });
  }
  return { v: 1, pages };
}

/** 序列化后的字符数（用于界面提示"这段笔迹占了多少"；口径是 UTF-16 码元，不是字节） */
export function docChars(doc: InkDoc): number {
  return serializeDoc(doc).length;
}

// ---------------------------------------------------------------------------
// 导出（PNG / 打印）
// ---------------------------------------------------------------------------

/** 导出底色（纸的"白"）：不用纯白，纯白在多数屏幕上偏刺眼，且与应用的 --surface 不一致 */
export const PAPER_RGB = "#ffffff";

export interface RenderOptions {
  /** 最长边像素上限（与 `lib/images.ts` 的 MAX_IMAGE_EDGE 同一口径：1600 够看清，且体积可控） */
  maxEdge?: number;
  /** 白底（导出必须开；屏幕预览由 CSS 铺底，不用重复铺） */
  background?: string;
  /** 是否画纸面底纹 */
  paper?: boolean;
}

/**
 * 把一页渲染成一个新的 canvas（**按需离屏**，不碰屏幕上的那个）。
 *
 * 为什么要单独渲染而不是 `canvas.toDataURL()`：屏幕上的 canvas 是**带缩放与平移**的，
 * 直接导出会得到"当前视角的截图"（歪的、被裁的、带空白边的）。导出必须回到页面坐标系，
 * 按页面原始比例画一遍。
 */
export function renderPage(page: InkPage, opts: RenderOptions = {}): HTMLCanvasElement {
  const maxEdge = opts.maxEdge ?? 1600;
  const scale = Math.min(1, maxEdge / Math.max(page.w, page.h));
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(page.w * scale));
  cv.height = Math.max(1, Math.round(page.h * scale));
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持导出图片（canvas 不可用）。");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, page.w, page.h);
  }
  if (opts.paper !== false) drawPaper(ctx, page, 1 / scale);
  for (const s of page.strokes) drawStroke(ctx, s, 1);
  return cv;
}

/** 一页 → PNG dataURL（`markdown.tsx` 只放行 png/jpeg/webp/gif 的 dataURL，SVG 被刻意排除） */
export function pageToPng(page: InkPage, opts: RenderOptions = {}): string {
  return renderPage(page, { background: PAPER_RGB, ...opts }).toDataURL("image/png");
}

/** 浏览器下载（浏览器预览模式也能用，不依赖 Rust） */
export function downloadBlobUrl(fileName: string, url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 页面尺寸的人类可读描述 */
export function pageSizeLabel(page: InkPage): string {
  return `${page.w}×${page.h}`;
}
