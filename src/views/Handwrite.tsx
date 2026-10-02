// R14 · **触控笔手写笔记页**（平板优先的工作区：笔迹在 Canvas 上，工具在两侧）。
//
// 契约：`docs/25-平板端与触控笔手写契约.md` §五
//
// 这一页要同时满足三类设备，且**同一份代码**：
//   · **带笔的平板**（S Pen / Apple Pencil / Surface Pen）→ 笔书写、手指平移与双指缩放；
//   · **只有手指的平板 / 手机** → 打开「手指也能写」后手指也能写；
//   · **桌面鼠标**（开发与排障）→ 鼠标就是一支没有压感的笔（`pressure` 固定 0.5）。
//
// 六条刻意的设计决定（都有代价，写在旁边）：
//   ① **一个 canvas + 视图变换**（页面坐标 ↔ 屏幕坐标），不是"每条笔迹一个 DOM 节点"。
//      代价：坐标换算、命中测试、缩放全部自己写；收益：一页几百条笔迹也不掉帧。
//   ② **增量绘制**：边写边画用的分段加密与"整笔重绘"**同一个公式**（`densifySegment`）
//      与同一个线宽函数（`displayWidth`），所以抬手那一刻笔迹不会突然一动。
//   ③ **防误触靠"笔一出现就忽略所有 touch"**（外加 2.5 秒保护期），不靠手掌压力阈值。
//      理由：浏览器不给手掌数据，任何阈值都会误伤"用笔时用手指挪纸"这个正常动作。
//   ④ **橡皮 = 删点 + 断笔**（不是画白线）：笔迹数据里没有白色墨迹，换纸面颜色也不会露馅。
//      拖动一次整个擦除过程只进**一条**撤销记录（粉笔擦语义）。
//   ⑤ **帧率优化**：文档变更**不触发**重绘，只有真正改变像素的操作才重绘
//      （平移/缩放/换页/撤销 全量重绘；擦除只重绘受影响的那一小块）。
//      早期版本把"每次 setState"都接到重绘上，擦除时每个 move 事件重画整页 —— 真机上必卡。
//   ⑥ **保存 = 写回 `notes` 表的同一条笔记**（`source='ink'`，正文 = 逐页 PNG + 笔迹围栏）。
//      代价：正文带 base64，`content_len` 不是"字数"（列表页因此单独标「手写」）；
//      收益：备份 / 还原 / 列表 / 导出 / 悬浮球桥接**全部白拿**，零数据库改动。
//
// ⚠ 诚实边界（界面上不要暗示已经做到）：
//   · **不内建手写识别**。Web 层没有可用的离线中文手写识别；「识别为文字」是把页面 PNG 交给
//     **用户自己的**视觉模型（BYOK，会联网花 token），结果标注「模型转写，非原文」；
//   · **不做笔迹预测**（`getPredictedEvents`）——理由见 `lib/ink.ts` 文件头；
//   · **压感不校准**：同一笔迹在不同笔上粗细感受不同（有「笔自检」按钮可当场看读数）；
//   · **手绘图形不做吸附/识别**：画圆不会变成正圆，画线不会拉直。这条要写在界面上，
//     否则用户会以为"自己画不准"，而其实是根本没做这个功能；
//   · **底图换页不通用**：底图属于**某一页**，换底图不进撤销栈（它是"换纸"，不是"写字"）。

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Icon, { type IconName } from "../components/Icon";
import { useCourses } from "../hooks/useCourses";
import { useNoteDetail } from "../hooks/useNotes";
import { useSettings } from "../hooks/useSettings";
import { collectImages, dataUrlBytes, humanBytes } from "../lib/images";
import {
  A4_H,
  A4_W,
  MARKER_COLORS,
  MAX_SIZE,
  MIN_SIZE,
  PAPER_LABEL,
  PAPERS,
  PEN_COLORS,
  PAPER_RGB,
  STAMP_GLYPHS,
  TOOLS,
  TOOL_LABEL,
  contactSize,
  commitAddStroke,
  commitClear,
  commitInsertPage,
  commitPaper,
  commitRemovePage,
  densifySegment,
  displayWidth,
  docChars,
  docPointCount,
  drawPageContent,
  drawStroke,
  emptyDoc,
  ensureBgLoaded,
  highlightFor,
  newHistory,
  pressureOf,
  pushOp,
  recolorStrokes,
  redo as redoDoc,
  renderPage,
  stampFontSize,
  strokeBBox,
  strokeHit,
  strokesInRect,
  tiltOf,
  translateStrokes,
  undo as undoDoc,
  unionBBox,
  type InkDoc,
  type InkPage,
  type InkPoint,
  type InkStroke,
  type InkTool,
} from "../lib/ink";
import {
  INK_PNG_MAX_EDGE,
  INK_SOURCE,
  decodeInkNote,
  docToPngs,
  encodeInkMarkdown,
  recognizeInkPage,
} from "../lib/inknote";
import { noteSave, noteSourceInfo, todayStr } from "../lib/notes";
import "./Handwrite.css";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 画布上纸张四周的留白（视觉上像"纸放在桌面上"） */
const CANVAS_PAD = 24;

/** 笔一出现就进入的保护期：这期间**所有** touch 都不落笔（防手掌误触的第二道网） */
const PEN_GUARD_MS = 2500;

/** 手指书写时，接触面积超过这个值就当手掌 —— **启发式**，浏览器不给手掌数据 */
const PALM_CONTACT_PX = 52;

/** 底图体积上限（与 `lib/images.ts` 的 `PNG_KEEP_LIMIT` 同口径：超过就重压） */
const BG_MAX_BYTES = 1_200_000;

/** 缩放范围 */
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

/** 自检面板显示的事件条数 */
const DIAG_LINES = 4;

/** 断笔阈值（与 `lib/ink.ts` 的 `breakAt` 必须同口径，否则边写边画的接缝会错） */
const BREAK_AT = 60;

interface DiagLine {
  type: string;
  pressure: number;
  tilt: string;
  contact: number;
}

interface EraseSession {
  before: InkStroke[];
  changed: boolean;
}

/** 拖动选区的会话（与擦除一样：整个拖动只落**一条**撤销记录） */
interface MoveSession {
  start: { x: number; y: number };
  /** 按下瞬间的整页笔迹（撤销用） */
  before: InkStroke[];
  /** 被移动的笔迹下标 */
  idx: number[];
  moved: boolean;
}

/** 工具 → 图标（印章没有图标：它显示当前选中的符号本身，见工具栏渲染） */
const TOOL_ICON: Record<Exclude<InkTool, "stamp">, IconName> = {
  pen: "pen",
  pencil: "pencil",
  line: "line",
  marker: "marker",
  eraser: "eraser",
  select: "select",
};

/** 高亮带默认色（与 `MARKER_COLORS[0]` 同一支暖黄 —— "划重点"的默认色不该是别的） */
const HIGHLIGHT_COLOR = MARKER_COLORS[0];

// ---------------------------------------------------------------------------
// 模块级纯函数
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 这一下指针该不该落笔。
 *   · `pen` → 总是落笔（压感为 0 是"悬停"，由 `pointerdown` 之外的路径排掉）；
 *   · `mouse` → 落笔（桌面排障）；
 *   · `touch` → 只在「手指也能写」打开、不在笔保护期内、且接触面积不像手掌时才落笔。
 */
function shouldDraw(
  e: PointerEvent,
  opts: { fingerWrite: boolean; penGuardUntil: number; now: number },
): boolean {
  if (e.pointerType === "pen" || e.pointerType === "mouse") return true;
  if (!opts.fingerWrite) return false;
  if (opts.now < opts.penGuardUntil) return false;
  return !(contactSize(e) > PALM_CONTACT_PX);
}

/** 擦掉**一条**笔迹里被圆盖住的点（与 `lib/ink.ts` 的 `eraseAt` 同语义，但只处理一条） */
function eraseOneStroke(s: InkStroke, x: number, y: number, radius: number): InkStroke[] {
  const r = radius + s.size / 2;
  const r2 = r * r;
  const out: InkStroke[] = [];
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
  return out;
}

/** 从既有正文里取回"文字稿"（模型转写的那一节），供再次编辑与再次保存 */
function extractOcr(md: string): string {
  const m = /^##\s*文字稿（模型转写，非原文）\s*$([\s\S]*?)(?=^```chunxiao-ink|^##\s|$)/m.exec(md ?? "");
  return m ? m[1].trim() : "";
}

/** 文件名净化（与导出 .md 的口径一致） */
function safeName(name: string): string {
  return (name || "手写笔记").replace(/[\\/:*?"<>|]/g, " ").trim() || "手写笔记";
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function Handwrite() {
  const { id } = useParams<{ id: string }>();
  const noteId = id && /^\d+$/.test(id) ? Number(id) : null;
  const nav = useNavigate();
  const { search } = useLocation();
  const { courses } = useCourses();
  const { s, hasKey } = useSettings();
  const urlCourseId = (() => {
    const raw = new URLSearchParams(search).get("course");
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  })();

  const { note, loading, busy, error, setError, updateNote } = useNoteDetail(noteId);

  // —— 文档（真源）——
  // 放在 ref 里、用一个 `rev` 计数触发重渲染：笔迹对象图很大，走 setState 深拷贝会一卡一卡。
  const docRef = useRef<InkDoc>(emptyDoc());
  const histRef = useRef(newHistory());
  const [rev, setRev] = useState(0);
  const [dirtyFlag, setDirtyFlag] = useState(false);
  /** 文档改了：重渲染界面（笔数 / 撤销可用性 / 未保存标记）。**刻意不触发重绘**，理由见文件头 ⑤ */
  const refresh = useCallback((markDirty = true) => {
    setRev((v) => v + 1);
    if (markDirty) setDirtyFlag(true);
  }, []);

  // —— 工具状态 ——
  const [tool, setTool] = useState<InkTool>("pen");
  const [color, setColor] = useState<string>(PEN_COLORS[0]);
  const [size, setSize] = useState(3);
  const [pageIndex, setPageIndex] = useState(0);
  const [fingerWrite, setFingerWrite] = useState(false);
  const [penSeen, setPenSeen] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [diag, setDiag] = useState<DiagLine[]>([]);
  /** 当前标注符号（`tool === "stamp"` 时点一下就盖一个） */
  const [stampGlyph, setStampGlyph] = useState<string>(STAMP_GLYPHS[2]);
  /**
   * 框选的笔迹下标。
   * ⚠ 同时存**一份 ref**：`paint()` 是稳定回调（[] deps），读不到 state —— 见文件头 ⑤ 的取舍。
   */
  const selRef = useRef<number[]>([]);
  const [selCount, setSelCount] = useState(0);

  // —— 视图（缩放 / 平移）——
  const viewRef = useRef({ scale: 1, tx: CANVAS_PAD, ty: CANVAS_PAD });
  const [, setViewRev] = useState(0);
  const bumpView = useCallback(() => setViewRev((v) => v + 1), []);

  // —— 笔记元信息 ——
  const [title, setTitle] = useState("");
  const [courseId, setCourseId] = useState<number | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // —— 手写转文字 ——
  const [ocrText, setOcrText] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [ocrOpen, setOcrOpen] = useState(false);

  // —— DOM ——
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // —— 交互中的临时状态（一律走 ref：它们每次 pointermove 都在变，进 state 会拖垮帧率）——
  const liveRef = useRef<InkStroke | null>(null);
  const liveDrawnRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; scale: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const eraseRef = useRef<EraseSession | null>(null);
  const penGuardRef = useRef(0);
  /** 正在拖动的选区 */
  const moveRef = useRef<MoveSession | null>(null);
  /** 正在拉的选框（页面坐标；null = 没在拉） */
  const bandRef = useRef<{ x: number; y: number; x1: number; y1: number } | null>(null);

  // 绘制回调是**稳定**的（读 ref 而不是读 state），否则每切一次工具都要重建 ResizeObserver
  const pageIndexRef = useRef(pageIndex);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);

  const page: InkPage | undefined = docRef.current.pages[pageIndex];

  // -------------------------------------------------------------------------
  // 画布：绘制
  // -------------------------------------------------------------------------

  /** 画一帧：清屏 → 纸 → 底图 → 纸面底纹 → 全部笔迹 → 正在写的那一笔 */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const ctx = ctxRef.current;
    if (!cv || !ctx) return;
    const pg = docRef.current.pages[pageIndexRef.current];
    const v = viewRef.current;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!pg) return;

    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
    ctx.fillStyle = PAPER_RGB;
    ctx.fillRect(0, 0, pg.w, pg.h);
    drawPageContent(ctx, pg, v.scale);

    const live = liveRef.current;
    if (live && live.pts.length > 0) drawStroke(ctx, live, 1);

    // 选框（拉的过程中）与已选中的笔迹框：都画在页面上，位置才跟着缩放走
    const band = bandRef.current;
    const selIdx = selRef.current;
    if (band || selIdx.length > 0) {
      ctx.save();
      ctx.lineWidth = 1.5 / v.scale;
      ctx.setLineDash([7 / v.scale, 5 / v.scale]);
      ctx.strokeStyle = "rgba(65,118,230,0.95)";
      if (band) {
        const w = band.x1 - band.x, h = band.y1 - band.y;
        ctx.fillStyle = "rgba(65,118,230,0.10)";
        ctx.fillRect(band.x, band.y, w, h);
        ctx.strokeRect(band.x, band.y, w, h);
      }
      if (selIdx.length > 0) {
        const picked = selIdx.map((i) => pg.strokes[i]).filter(Boolean);
        const bb = unionBBox(picked);
        if (bb) {
          ctx.fillStyle = "rgba(65,118,230,0.10)";
          ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
          ctx.strokeRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
        }
      }
      ctx.restore();
    }
  }, []);

  const schedulePaint = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      paint();
    });
  }, [paint]);

  /** 全量重绘（平移 / 缩放 / 换页 / 撤销 / 换纸面 / 抬手后收尾时用） */
  const repaint = useCallback(() => {
    schedulePaint();
  }, [schedulePaint]);

  /** 局部重绘（橡皮专用）：只重画与矩形相交的笔迹 —— 擦除时每个 move 事件都重画整页是不可接受的 */
  const paintRegion = useCallback(
    (rect: { x0: number; y0: number; x1: number; y1: number }) => {
      const ctx = ctxRef.current;
      const pg = docRef.current.pages[pageIndexRef.current];
      if (!ctx || !pg) return;
      const v = viewRef.current;
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
      ctx.beginPath();
      ctx.rect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
      ctx.clip();
      ctx.fillStyle = PAPER_RGB;
      ctx.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
      // 底纹与底图也要补回来（否则擦过的地方是光板、底图会缺一块）
      drawPageContent(ctx, { ...pg, strokes: [] }, v.scale);
      for (const sc of pg.strokes) {
        const bb = strokeBBox(sc);
        if (!bb) continue;
        if (bb.x1 < rect.x0 || bb.x0 > rect.x1 || bb.y1 < rect.y0 || bb.y0 > rect.y1) continue;
        drawStroke(ctx, sc, 1);
      }
      ctx.restore();
    },
    [],
  );

  /** 让当前页"适应宽度" */
  const fitWidth = useCallback(() => {
    const wrap = wrapRef.current;
    const pg = docRef.current.pages[pageIndexRef.current];
    if (!wrap || !pg) return;
    const avail = Math.max(160, wrap.clientWidth - CANVAS_PAD * 2);
    const v = viewRef.current;
    v.scale = Math.min(MAX_SCALE, avail / pg.w);
    v.tx = CANVAS_PAD;
    v.ty = CANVAS_PAD;
    repaint();
    bumpView();
  }, [bumpView, repaint]);

  const zoomBy = useCallback(
    (factor: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const v = viewRef.current;
      const cx = wrap.clientWidth / 2;
      const cy = wrap.clientHeight / 2;
      const anchor = { x: (cx - v.tx) / v.scale, y: (cy - v.ty) / v.scale };
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      v.scale = next;
      v.tx = cx - anchor.x * next;
      v.ty = cy - anchor.y * next;
      repaint();
      bumpView();
    },
    [bumpView, repaint],
  );

  // 画布尺寸跟随容器（DPR / 转屏 / 分屏 / 键盘弹起都会走到这里）
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      ctxRef.current = cv.getContext("2d");
      paint();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [paint]);

  // 换页：全量重绘（换页是低频操作，重画整页完全可接受）；选区属于某一页，必须清掉
  useEffect(() => {
    selRef.current = [];
    setSelCount(0);
    bandRef.current = null;
    moveRef.current = null;
    repaint();
  }, [pageIndex, repaint]);

  // -------------------------------------------------------------------------
  // 载入既有笔记 / 初始化新文档
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (noteId == null || !note || loadedId === note.id) return;
    const decoded = decodeInkNote(note.content_md);
    if (decoded.doc) {
      docRef.current = decoded.doc;
    } else {
      docRef.current = emptyDoc();
      // **如实说**，不静默：用户必须知道"我正在一个空画布上写，保存会覆盖原来的正文"
      setNotice(
        decoded.hasFence
          ? "这条笔记里的笔迹数据读不出来（格式不对或被截断）。下面的画布是空的：继续写并保存会覆盖原有正文，请先另存一份再动手。"
          : "这条笔记不是手写笔记（没有笔迹数据）：下面的画布是空的，保存会把正文换成手写内容。",
      );
    }
    histRef.current = newHistory();
    setPageIndex(0);
    selRef.current = [];
    setSelCount(0);
    setTitle(note.title);
    setCourseId(note.course_id);
    setOcrText(extractOcr(note.content_md));
    setLoadedId(note.id);
    setSavedAt(null);
    setDirtyFlag(false);
    setRev((v) => v + 1);
    // 底图要先解码完成，才画得出来（同步绘制路径拿不到就跳过，见 lib/ink.ts 的 BG_CACHE）
    void (async () => {
      for (const p of docRef.current.pages) if (p.bg) await ensureBgLoaded(p.bg);
      fitWidth();
      repaint();
    })();
  }, [note, noteId, loadedId, fitWidth, repaint]);

  // 新笔记：默认课程 + 首次适应宽度
  useEffect(() => {
    if (noteId != null) return;
    if (courseId == null) {
      const active = urlCourseId ?? courses.find((c) => !c.archived)?.id ?? courses[0]?.id ?? null;
      if (active != null) setCourseId(active);
    }
  }, [noteId, courseId, courses, urlCourseId]);

  // 新建时也要适应一次宽度（layout 完成后）
  useEffect(() => {
    if (noteId != null) return;
    const t = window.setTimeout(() => fitWidth(), 0);
    return () => window.clearTimeout(t);
    // 只在挂载时做一次：之后用户的缩放不能被"自动适应"抢走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // 指针事件（**原生监听**：需要 `getCoalescedEvents`，React 合成事件拿不到）
  // -------------------------------------------------------------------------

  /** 指针事件 → 画布 CSS 坐标 */
  const localPos = useCallback((e: PointerEvent): { x: number; y: number } => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  /** 屏幕坐标 → 页面坐标 */
  const toPage = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const v = viewRef.current;
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  }, []);

  /** 在当前页擦一次（**不入撤销栈**：拖动整体由 `pointerup` 落一条记录） */
  const applyErase = useCallback(
    (x: number, y: number, radius: number) => {
      const pg = docRef.current.pages[pageIndexRef.current];
      if (!pg) return;
      let changed = false;
      const next: InkStroke[] = [];
      let x0 = x - radius;
      let y0 = y - radius;
      let x1 = x + radius;
      let y1 = y + radius;
      for (const sc of pg.strokes) {
        if (!strokeHit(sc, x, y, radius)) {
          next.push(sc);
          continue;
        }
        changed = true;
        const bb = strokeBBox(sc);
        if (bb) {
          x0 = Math.min(x0, bb.x0);
          y0 = Math.min(y0, bb.y0);
          x1 = Math.max(x1, bb.x1);
          y1 = Math.max(y1, bb.y1);
        }
        for (const k of eraseOneStroke(sc, x, y, radius)) next.push(k);
      }
      if (!changed) return;
      pg.strokes = next;
      if (eraseRef.current) eraseRef.current.changed = true;
      refresh();
      paintRegion({ x0, y0, x1, y1 });
    },
    [paintRegion, refresh],
  );

  /** 选区（下标）同时写 ref 与 state：ref 给 `paint()` 用，state 给界面用 */
  const setSel = useCallback((idx: number[]) => {
    selRef.current = idx;
    setSelCount(idx.length);
  }, []);

  /** 当前页上被选中的笔迹对象 */
  const selectedStrokes = useCallback((): InkStroke[] => {
    const pg = docRef.current.pages[pageIndexRef.current];
    if (!pg) return [];
    return selRef.current.map((i) => pg.strokes[i]).filter(Boolean) as InkStroke[];
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;

    const two = () => Array.from(pointersRef.current.values());

    const startPinch = () => {
      const pts = two();
      if (pts.length < 2) return false;
      const [a, b] = pts;
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        scale: viewRef.current.scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      return true;
    };

    const pushDiag = (e: PointerEvent) => {
      const t = tiltOf(e);
      const line: DiagLine = {
        type: e.pointerType,
        pressure: Number(pressureOf(e).toFixed(3)),
        tilt: `${Math.round(t.x)}°/${Math.round(t.y)}°`,
        contact: Math.round(contactSize(e)),
      };
      setDiag((prev) => [line, ...prev].slice(0, DIAG_LINES));
    };

    const onDown = (e: PointerEvent) => {
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* 某些浏览器对鼠标的 pointerId 会抛错，不影响后续逻辑 */
      }
      const p = localPos(e);
      pointersRef.current.set(e.pointerId, p);
      pushDiag(e);

      if (e.pointerType === "pen") {
        setPenSeen(true);
        penGuardRef.current = performance.now() + PEN_GUARD_MS;
      }

      // 两指 → 缩放/平移（同时取消正在写的这一笔：这是"我其实想缩放"的明确意图）
      if (pointersRef.current.size >= 2) {
        liveRef.current = null;
        liveDrawnRef.current = 0;
        panRef.current = null;
        bandRef.current = null;
        moveRef.current = null;
        startPinch();
        repaint();
        return;
      }

      const pg = docRef.current.pages[pageIndexRef.current];
      if (!pg) return;
      const pp = toPage(p.x, p.y);
      const now = performance.now();

      // ① **框选**（R14b）：交互工具，**手指也能用** —— 没有笔的平板照样要能选中/高亮
      if (tool === "select") {
        const bb = unionBBox(selectedStrokes());
        const inside = !!bb && pp.x >= bb.x0 && pp.x <= bb.x1 && pp.y >= bb.y0 && pp.y <= bb.y1;
        if (inside) {
          // 在选区里按下 = 拖动选中的笔迹（整个拖动只落一条撤销记录）
          moveRef.current = { start: pp, before: pg.strokes.slice(), idx: selRef.current.slice(), moved: false };
        } else {
          bandRef.current = { x: pp.x, y: pp.y, x1: pp.x, y1: pp.y };
        }
        schedulePaint();
        return;
      }

      // ② **标注符号**（R14b）：点一下就盖一个，同样手指可用
      if (tool === "stamp") {
        commitAddStroke(docRef.current, histRef.current, pageIndexRef.current, {
          tool: "stamp",
          color,
          size,
          glyph: stampGlyph,
          pts: [{ x: pp.x, y: pp.y, p: 0.5 }],
        });
        refresh();
        repaint();
        return;
      }

      if (!shouldDraw(e, { fingerWrite, penGuardUntil: penGuardRef.current, now })) {
        // 不落笔 → 单指拖动 = 挪纸（带笔的平板上最常用的动作）
        panRef.current = { x: p.x, y: p.y, tx: viewRef.current.tx, ty: viewRef.current.ty };
        return;
      }

      if (tool === "eraser") {
        // 整个拖动只落**一条**撤销记录：先拍快照
        eraseRef.current = { before: pg.strokes.slice(), changed: false };
        applyErase(pp.x, pp.y, size / 2);
        return;
      }

      // ③ 直线：只有两个点，拖动时替换第二个（不走"边写边画"的增量路径）
      if (tool === "line") {
        liveRef.current = {
          tool: "line",
          color,
          size,
          pts: [
            { x: pp.x, y: pp.y, p: 0.5 },
            { x: pp.x, y: pp.y, p: 0.5 },
          ],
        };
        liveDrawnRef.current = 2;
        return;
      }

      liveRef.current = {
        tool,
        color: tool === "marker" ? markerColorOf(color) : color,
        size,
        pts: [{ x: pp.x, y: pp.y, p: pressureOf(e) }],
      };
      liveDrawnRef.current = 0;
    };

    /** 取"合并事件"并把新点接到当前笔迹上，同时把**已经能确定曲率**的那几段画出来 */
    const extendLive = (e: PointerEvent, flushTail: boolean) => {
      const live = liveRef.current;
      const ctx = ctxRef.current;
      if (!live || !ctx) return;
      const v = viewRef.current;
      const dpr = window.devicePixelRatio || 1;

      // ① 合并事件：120Hz 的笔在 60Hz 的帧率下一次会给多个点。丢掉它们 = 把好笔降级成鼠标
      const raw = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = raw.length > 0 ? raw : [e];
      for (const ev of list) {
        const lp = localPos(ev);
        const pp = toPage(lp.x, lp.y);
        live.pts.push({ x: pp.x, y: pp.y, p: pressureOf(ev) });
      }

      // ② 增量绘制：第 i 段需要 pts[i-2…i+1]，所以平时只画到 pts.length-2
      const spacing = Math.max(0.8, Math.min(3, live.size * 0.3));
      ctx.save();
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
      ctx.strokeStyle = live.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = live.tool === "marker" ? 0.32 : live.tool === "pencil" ? 0.9 : 1;
      if (live.tool === "marker") ctx.globalCompositeOperation = "multiply";

      const from = Math.max(1, liveDrawnRef.current);
      const upto = flushTail ? live.pts.length - 1 : live.pts.length - 2;
      for (let i = from; i <= upto; i += 1) {
        const a = live.pts[i - 1];
        const b = live.pts[i];
        if (Math.hypot(b.x - a.x, b.y - a.y) > BREAK_AT) continue;
        const p0 = live.pts[i - 2] ?? a;
        const p3 = live.pts[i + 1] ?? b;
        const seg = densifySegment(p0, a, b, p3, spacing);
        if (seg.length === 0) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        for (const q of seg) ctx.lineTo(q.x, q.y);
        ctx.lineWidth = displayWidth(live.tool, live.size, (a.p + b.p) / 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.restore();
      liveDrawnRef.current = Math.max(liveDrawnRef.current, upto + 1);
    };

    const finishLive = (e: PointerEvent) => {
      const live = liveRef.current;
      if (!live) return;
      // 直线是"两点确定一条"，不走增量补点（否则会被追加成一串手写点）
      if (live.tool !== "line") extendLive(e, true);
      liveRef.current = null;
      liveDrawnRef.current = 0;
      if (live.pts.length === 0) return;
      if (live.tool === "line") {
        const a = live.pts[0];
        const b = live.pts[live.pts.length - 1];
        // 太短的直线当误触丢掉（6 页面像素以内，用户不可能是在画线）
        if (Math.hypot(b.x - a.x, b.y - a.y) < 6) {
          refresh();
          repaint();
          return;
        }
      }
      commitAddStroke(docRef.current, histRef.current, pageIndexRef.current, live);
      refresh();
      // 抬手后用**批量路径**重画一次：与增量路径像素等价，但坐标基准统一，
      // 后续每一次局部重绘（橡皮）才有可比对的基准
      repaint();
    };

    const onMove = (e: PointerEvent) => {
      const p = localPos(e);
      pointersRef.current.set(e.pointerId, p);

      // 双指：缩放 + 平移
      if (pointersRef.current.size >= 2) {
        const pinch = pinchRef.current ?? (startPinch() ? pinchRef.current : null);
        if (!pinch) return;
        const [a, b] = two();
        const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const v = viewRef.current;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (pinch.scale * dist) / pinch.dist));
        // 以两指中点为锚点：中点在页面上的位置保持不动（"捏得准"的关键）
        const anchor = { x: (pinch.cx - v.tx) / v.scale, y: (pinch.cy - v.ty) / v.scale };
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        v.scale = next;
        v.tx = c.x - anchor.x * next;
        v.ty = c.y - anchor.y * next;
        repaint();
        bumpView();
        return;
      }

      // 单指平移
      if (panRef.current) {
        const pan = panRef.current;
        viewRef.current.tx = pan.tx + (p.x - pan.x);
        viewRef.current.ty = pan.ty + (p.y - pan.y);
        repaint();
        return;
      }

      // 框选：拉选框 / 拖动选中的笔迹
      if (bandRef.current) {
        const pp = toPage(p.x, p.y);
        bandRef.current = { ...bandRef.current, x1: pp.x, y1: pp.y };
        schedulePaint();
        return;
      }
      if (moveRef.current) {
        const mv = moveRef.current;
        const pg = docRef.current.pages[pageIndexRef.current];
        if (!pg) return;
        const pp = toPage(p.x, p.y);
        const dx = pp.x - mv.start.x;
        const dy = pp.y - mv.start.y;
        if (dx !== 0 || dy !== 0) mv.moved = true;
        // 逐笔平移：只有被选中的那些点会被重建，其余笔迹**沿用原对象**（折线缓存继续有效）
        const next = mv.before.slice();
        for (const i of mv.idx) {
          const s = mv.before[i];
          if (s) next[i] = translateStrokes([s], dx, dy)[0];
        }
        pg.strokes = next;
        repaint();
        return;
      }

      // 直线预览：替换第二个端点（rAF 节流，重画整页但不至于每个事件都重画）
      if (liveRef.current && liveRef.current.tool === "line") {
        const st = liveRef.current;
        const pp = toPage(p.x, p.y);
        liveRef.current = { ...st, pts: [st.pts[0], { x: pp.x, y: pp.y, p: 0.5 }] };
        schedulePaint();
        return;
      }

      // 橡皮拖动
      if (eraseRef.current) {
        const pp = toPage(p.x, p.y);
        applyErase(pp.x, pp.y, size / 2);
        return;
      }

      // 笔（或手指/鼠标）在写
      if (liveRef.current) {
        extendLive(e, false);
      }
      // 其余情况（笔悬停 / 未落笔）刻意什么都不做：悬停重绘整页会让 120Hz 的笔把帧率吃光
    };

    const onUp = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      panRef.current = null;

      // 框选收尾：算出命中，并**保持选区**（用户接着要按「高亮 / 删除 / 移动」）
      const band = bandRef.current;
      if (band) {
        bandRef.current = null;
        const pg = docRef.current.pages[pageIndexRef.current];
        if (pg) {
          // slack = 6：笔迹的外接框只要碰得到选框就算选中 —— 手写很难框得"刚好"
          const idx = strokesInRect(pg.strokes, band.x, band.y, band.x1, band.y1, 6);
          setSel(idx);
          if (idx.length === 0) setNotice("这一框里没有笔迹：框大一点，或把要标的那一块圈进去。");
        }
        repaint();
      }

      // 拖动选区收尾：整个拖动只落**一条**撤销记录
      const mv = moveRef.current;
      if (mv) {
        moveRef.current = null;
        const pg = docRef.current.pages[pageIndexRef.current];
        if (pg && mv.moved) {
          pushOp(histRef.current, {
            kind: "strokes",
            page: pageIndexRef.current,
            before: mv.before,
            after: pg.strokes.slice(),
          });
          refresh();
        }
        repaint();
      }

      finishLive(e);

      const es = eraseRef.current;
      if (es) {
        eraseRef.current = null;
        const pg = docRef.current.pages[pageIndexRef.current];
        if (es.changed && pg) {
          pushOp(histRef.current, {
            kind: "strokes",
            page: pageIndexRef.current,
            before: es.before,
            after: pg.strokes.slice(),
          });
          // 擦除会改变下标 → 选区必须作废（否则"高亮"会标到别的笔迹上）
          setSel([]);
          refresh();
        }
      }
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {
        /* 指针已消失时某些浏览器会抛错，忽略 */
      }
    };

    const onCancel = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      panRef.current = null;
      pinchRef.current = null;
      bandRef.current = null;
      // 取消 = 这一笔作废（不是"提交半个字"）；擦除/拖动回滚到本次按下之前的快照
      liveRef.current = null;
      liveDrawnRef.current = 0;
      const es = eraseRef.current;
      if (es) {
        const pg = docRef.current.pages[pageIndexRef.current];
        if (pg) pg.strokes = es.before;
        eraseRef.current = null;
      }
      const mv = moveRef.current;
      if (mv) {
        const pg = docRef.current.pages[pageIndexRef.current];
        if (pg) pg.strokes = mv.before;
        moveRef.current = null;
      }
      repaint();
    };

    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onCancel);
    return () => {
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onCancel);
    };
    // ⚠ `color` / `stampGlyph` 必须进依赖：它们被 onDown 直接读（落笔用哪个颜色、印章用哪个符号），
    //   漏掉就会"换了颜色但写出来还是旧色"——这类闭包过期问题在事件回调里最难发现。
  }, [
    applyErase,
    bumpView,
    color,
    fingerWrite,
    localPos,
    refresh,
    repaint,
    schedulePaint,
    selectedStrokes,
    setSel,
    size,
    stampGlyph,
    toPage,
    tool,
  ]);

  // 桌面滚轮：Ctrl+滚轮 = 缩放，其余 = 平移
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const r = cv.getBoundingClientRect();
        const anchor = {
          x: (e.clientX - r.left - v.tx) / v.scale,
          y: (e.clientY - r.top - v.ty) / v.scale,
        };
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
        v.scale = next;
        v.tx = e.clientX - r.left - anchor.x * next;
        v.ty = e.clientY - r.top - anchor.y * next;
      } else {
        v.tx -= e.deltaX;
        v.ty -= e.deltaY;
      }
      repaint();
      bumpView();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [bumpView, repaint]);

  // -------------------------------------------------------------------------
  // 工具动作
  // -------------------------------------------------------------------------

  const doUndo = useCallback(() => {
    if (undoDoc(docRef.current, histRef.current)) {
      setSel([]); // 撤销会改变笔迹数组 → 下标作废，选区必须清掉
      refresh();
      repaint();
    }
  }, [refresh, repaint, setSel]);

  const doRedo = useCallback(() => {
    if (redoDoc(docRef.current, histRef.current)) {
      setSel([]);
      refresh();
      repaint();
    }
  }, [refresh, repaint, setSel]);

  const doClearPage = useCallback(() => {
    if (!window.confirm("清空这一页的全部笔迹？\n（可以撤销）")) return;
    if (commitClear(docRef.current, histRef.current, pageIndexRef.current)) {
      setSel([]);
      refresh();
      repaint();
    }
  }, [refresh, repaint, setSel]);

  // —— R14b：框选后的动作（高亮 / 变色 / 删除 / 取消）——

  /**
   * 给选中的笔迹铺一条**荧光高亮带**（画在底层）。
   *
   * 为什么是"新增一条底层笔迹"而不是"把原笔迹改成荧光色"：
   *   ① 后者会**丢掉原本的墨色**（读者看不出用户改过）；
   *   ② 高亮在人的认知里就是"底色"，盖在字下面才叫划重点；
   *   ③ 新增对象不动原对象 → 撤销一步就干净还原，不需要记住"原来是什么色"。
   */
  const doHighlight = useCallback(() => {
    const pg = docRef.current.pages[pageIndexRef.current];
    const picked = selectedStrokes();
    if (!pg || picked.length === 0) return;
    const hl = highlightFor(picked, HIGHLIGHT_COLOR);
    if (hl.length === 0) {
      setNotice("选中的只有标注符号：符号不做高亮带（给它套色带看不出想说什么）。");
      return;
    }
    const before = pg.strokes.slice();
    pg.strokes = before.concat(hl);
    pushOp(histRef.current, { kind: "strokes", page: pageIndexRef.current, before, after: pg.strokes });
    // 高亮带是**追加**的，原笔迹下标没变 → 选区保持，用户还能接着变色或删除
    refresh();
    repaint();
    setNotice(`已高亮 ${hl.length} 条笔迹（铺在字下面）。再点一次会叠一层，撤销可以退回。`);
  }, [refresh, repaint, selectedStrokes]);

  /** 把选中的笔迹换成当前颜色（保留工具、线宽、符号与层序） */
  const doRecolorSel = useCallback(() => {
    const pg = docRef.current.pages[pageIndexRef.current];
    if (!pg || selRef.current.length === 0) return;
    const before = pg.strokes.slice();
    const next = before.slice();
    let n = 0;
    for (const i of selRef.current) {
      const s = before[i];
      if (!s) continue;
      next[i] = recolorStrokes([s], color)[0];
      n += 1;
    }
    if (n === 0) return;
    pg.strokes = next;
    pushOp(histRef.current, { kind: "strokes", page: pageIndexRef.current, before, after: next });
    refresh();
    repaint();
    setNotice(`已把选中的 ${n} 条笔迹改成当前颜色。`);
  }, [color, refresh, repaint]);

  /** 删除选中的笔迹（**一步撤销**，与橡皮的"删点"语义不同：这里是整笔删） */
  const doDeleteSel = useCallback(() => {
    const pg = docRef.current.pages[pageIndexRef.current];
    if (!pg || selRef.current.length === 0) return;
    const kill = new Set(selRef.current);
    const before = pg.strokes.slice();
    const next = before.filter((_, i) => !kill.has(i));
    if (next.length === before.length) return;
    pg.strokes = next;
    pushOp(histRef.current, { kind: "strokes", page: pageIndexRef.current, before, after: next });
    setSel([]);
    refresh();
    repaint();
    setNotice(`已删除选中的 ${before.length - next.length} 条笔迹（可以撤销）。`);
  }, [refresh, repaint, setSel]);

  const doClearSel = useCallback(() => {
    setSel([]);
    repaint();
  }, [repaint, setSel]);

  const setPaper = useCallback(
    (paper: InkPage["paper"]) => {
      const pg = docRef.current.pages[pageIndexRef.current];
      if (!pg || pg.paper === paper) return;
      commitPaper(docRef.current, histRef.current, pageIndexRef.current, paper);
      refresh();
      repaint();
    },
    [refresh, repaint],
  );

  const addPage = useCallback(() => {
    const at = commitInsertPage(docRef.current, histRef.current, pageIndexRef.current + 1);
    setPageIndex(at);
    refresh();
  }, [refresh]);

  const removePage = useCallback(() => {
    if (docRef.current.pages.length <= 1) {
      setNotice("只有一页：删了就无处可写了。");
      return;
    }
    if (!window.confirm(`删除第 ${pageIndexRef.current + 1} 页？\n（可以撤销）`)) return;
    const at = pageIndexRef.current;
    if (commitRemovePage(docRef.current, histRef.current, at)) {
      setPageIndex(Math.max(0, Math.min(at, docRef.current.pages.length - 1)));
      refresh();
    }
  }, [refresh]);

  /** 插入底图（铺在当前页下面；**不进撤销栈**：换底图是"换纸"，不是"写字"） */
  const insertBg = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const res = await collectImages(files, []);
      if (res.images.length === 0) {
        setNotice(res.rejected.join("\n") || "没有可用的图片。");
        return;
      }
      const dataUrl = res.images[0];
      const bytes = dataUrlBytes(dataUrl);
      if (bytes > BG_MAX_BYTES) {
        setNotice(
          `这张图 ${humanBytes(bytes)} 超过底图上限 ${humanBytes(BG_MAX_BYTES)}（底图会跟着笔记一起存进本机库）：请先裁小或压缩再插入。`,
        );
        return;
      }
      const img = await ensureBgLoaded(dataUrl);
      if (!img) {
        setNotice("这张图读不出来（格式可能不受支持）。");
        return;
      }
      const pg = docRef.current.pages[pageIndexRef.current];
      if (!pg) return;
      pg.bg = dataUrl;
      refresh();
      repaint();
      setNotice(
        `已把这张图（${humanBytes(bytes)}）铺在第 ${pageIndexRef.current + 1} 页下面。换底图不进撤销栈，撤不回来。`,
      );
    },
    [refresh, repaint],
  );

  // -------------------------------------------------------------------------
  // 保存 / 导出 / 识别
  // -------------------------------------------------------------------------

  /**
   * 未保存 = 「文档动过」或「标题与库里不一样」。
   * ⚠ 刻意**不**用"重新序列化一次正文再对比"来判断（早期版本这么写）：
   *   那样每敲一个字都要把整篇手写重新光栅化成 PNG，平板上会直接卡死。
   */
  const dirty =
    dirtyFlag ||
    (noteId != null && note != null && title !== note.title) ||
    (noteId == null && title.trim() !== "");

  /** 保存前把底图都解码好，否则导出/保存的 PNG 里会缺底图 */
  const warmBg = useCallback(async () => {
    for (const p of docRef.current.pages) if (p.bg) await ensureBgLoaded(p.bg);
  }, []);

  const save = useCallback(async () => {
    const t = title.trim();
    if (!t) {
      setNotice("请先填笔记标题。");
      return;
    }
    if (docPointCount(docRef.current) === 0) {
      setNotice("还没有写任何笔迹：空笔记不落库。");
      return;
    }
    if (noteId == null && courseId == null) {
      setNotice("请先选一门课程：笔记必须归属到某门课。");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await warmBg();
      const md = encodeInkMarkdown({ title: t, doc: docRef.current, ocrText, maxEdge: INK_PNG_MAX_EDGE });
      const id = noteId ?? loadedId;
      if (id == null) {
        const newId = await noteSave({
          courseId: courseId as number,
          title: t,
          contentMd: md,
          date: todayStr(),
          source: INK_SOURCE,
        });
        setLoadedId(newId);
        setDirtyFlag(false);
        setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        setNotice("已保存到本机（来源标「手写」）。");
        nav(`/handwrite/${newId}`, { replace: true });
      } else {
        const ok = await updateNote({ title: t, contentMd: md });
        if (ok) {
          setDirtyFlag(false);
          setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
          setNotice(`已保存到本机（${docRef.current.pages.length} 页）。`);
        }
      }
    } catch (e) {
      setNotice(`保存失败：${errText(e)}`);
    } finally {
      setSaving(false);
    }
  }, [courseId, loadedId, noteId, ocrText, title, updateNote, warmBg, nav]);

  const exportPng = useCallback(() => {
    const pg = docRef.current.pages[pageIndexRef.current];
    if (!pg) return;
    let cv: HTMLCanvasElement;
    try {
      cv = renderPage(pg, { maxEdge: 2400, background: PAPER_RGB });
    } catch (e) {
      setNotice(`导出失败：${errText(e)}`);
      return;
    }
    cv.toBlob((blob) => {
      if (!blob) {
        setNotice("导出失败：当前环境无法生成 PNG。");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName(title)}-第${pageIndexRef.current + 1}页.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(`已导出第 ${pageIndexRef.current + 1} 页 PNG（含底图与纸面）。`);
    }, "image/png");
  }, [title]);

  /**
   * 打印 / 另存为 PDF：**临时把每一页的 <img> 塞进 DOM** 再走浏览器打印。
   * 为什么不直接打印屏幕上的 canvas：它只有"当前页 + 当前视角"，打出来是被裁过的一截。
   */
  const printAll = useCallback(async () => {
    await warmBg();
    const urls = docToPngs(docRef.current, 2000);
    const holder = document.createElement("div");
    holder.className = "hw-print-holder";
    urls.forEach((u, i) => {
      const img = document.createElement("img");
      img.src = u;
      img.alt = `手写 · 第 ${i + 1} 页`;
      holder.appendChild(img);
    });
    document.body.appendChild(holder);
    document.body.classList.add("hw-printing");
    const cleanup = () => {
      document.body.classList.remove("hw-printing");
      holder.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.setTimeout(() => window.print(), 50);
    window.setTimeout(cleanup, 120_000);
  }, [warmBg]);

  const runOcr = useCallback(async () => {
    if (!hasKey) {
      setOcrMsg("尚未配置模型 API Key：手写转文字要交给支持视觉的模型做（Web 层没有可用的离线手写识别），请先到「数据设置」配置。");
      return;
    }
    setOcrBusy(true);
    setOcrMsg("准备中…");
    try {
      await warmBg();
      const pngs = docToPngs(docRef.current, INK_PNG_MAX_EDGE);
      const out: string[] = [];
      for (let i = 0; i < pngs.length; i += 1) {
        setOcrMsg(`正在识别第 ${i + 1} / ${pngs.length} 页…`);
        const r = await recognizeInkPage(s.ai, pngs[i]);
        if (!r.ok) {
          setOcrMsg(`第 ${i + 1} 页识别失败：${r.err ?? "未知原因"}`);
          return;
        }
        out.push(`### 第 ${i + 1} 页`, "", r.text, "");
      }
      setOcrText(out.join("\n").trim());
      setOcrMsg("识别完成：文字稿已放进笔记（标「模型转写，非原文」），记得点「保存」。");
    } catch (e) {
      setOcrMsg(`识别失败：${errText(e)}`);
    } finally {
      setOcrBusy(false);
    }
  }, [hasKey, s, warmBg]);

  const goBack = useCallback(() => {
    if (dirty && !window.confirm("这条笔记有未保存的改动，确定离开吗？\n选「取消」可以回去继续写。")) return;
    nav(courseId != null ? `/notes?course=${courseId}` : "/notes");
  }, [courseId, dirty, nav]);

  // 键盘快捷键（桌面排障与效率；`save` 已定义，此处在它之后）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if ((mod && k === "y") || (mod && e.shiftKey && k === "z")) {
        e.preventDefault();
        doRedo();
      } else if (mod && k === "s") {
        e.preventDefault();
        void save();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selRef.current.length > 0) {
        // 选中笔迹后按删除键 —— 与所有图形编辑器一致，且要拦住 Backspace 的"后退"默认行为
        e.preventDefault();
        doDeleteSel();
      } else if (e.key === "Escape" && selRef.current.length > 0) {
        e.preventDefault();
        doClearSel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doClearSel, doDeleteSel, doRedo, doUndo, save]);

  // 未保存就关窗要拦一下（与沉浸式编辑器同一口径）
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const src = note ? noteSourceInfo(note.source) : null;
  const palette: readonly string[] = tool === "marker" ? MARKER_COLORS : PEN_COLORS;
  const zoomPct = Math.round(viewRef.current.scale * 100);
  const pageCount = docRef.current.pages.length;
  const canUndo = histRef.current.undo.length > 0;
  const canRedo = histRef.current.redo.length > 0;
  const coalescedOk = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;

  return (
    <div className="editor-shell-inner hw-page" data-rev={rev}>
      {/* ---------------- 顶栏 ---------------- */}
      <header className="hw-bar">
        <button className="ghost-btn" onClick={goBack} title="返回笔记列表">
          <Icon name="chevron-right" className="editor-back" />
          笔记
        </button>
        <input
          className="hw-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="手写笔记标题"
          aria-label="笔记标题"
        />
        <div className="hw-bar-right">
          {src && <span className={src.cls}>{src.text}</span>}
          {noteId == null ? (
            <label className="hw-course">
              <span>课程</span>
              <select
                value={courseId ?? ""}
                onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">（请选择）</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.archived ? "（已归档）" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="tag">{courses.find((c) => c.id === courseId)?.name ?? `课程 #${courseId}`}</span>
          )}
          <span className="hw-dirty" aria-live="polite">
            {saving
              ? "保存中…"
              : loading && !note
                ? "加载中…"
                : dirty
                  ? "未保存"
                  : savedAt
                    ? `已保存 ${savedAt}`
                    : "已保存"}
          </span>
          <button className="primary" disabled={saving || busy} onClick={() => void save()} title="保存（Ctrl+S）">
            保存
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div
          className={"settings-msg " + (error ? "err" : "ok")}
          onClick={() => (error ? setError(null) : setNotice(null))}
        >
          {error ?? notice}
        </div>
      )}
      {note && note.source === "ai_session" && (
        <div className="notes-ai-warn">
          这是一条 AI 整理的笔记，不是手写笔记：在这里保存会把正文换成手写内容。
        </div>
      )}

      <div className="hw-body">
        {/* ---------------- 工具轨 ---------------- */}
        <aside className="hw-tools" aria-label="手写工具">
          <div className="hw-tool-group">
            {TOOLS.map((t) => (
              <button
                key={t}
                className={"hw-tool" + (tool === t ? " on" : "")}
                title={t === "select" ? "框选：圈住笔迹后可高亮 / 变色 / 拖动 / 删除" : TOOL_LABEL[t]}
                aria-label={TOOL_LABEL[t]}
                aria-pressed={tool === t}
                onClick={() => setTool(t)}
              >
                {/* 标注符号没有图标：按钮上直接显示**当前选中的那个符号**，一眼看出会盖上什么 */}
                {t === "stamp" ? (
                  <span className="hw-tool-glyph" aria-hidden="true">
                    {stampGlyph}
                  </span>
                ) : (
                  <Icon name={TOOL_ICON[t as Exclude<InkTool, "stamp">]} size={18} />
                )}
                <span className="hw-tool-label">{TOOL_LABEL[t]}</span>
              </button>
            ))}
          </div>

          {/* 标注符号面板：只在选中「标注符号」时出现（不选它时不占地方） */}
          {tool === "stamp" && (
            <div className="hw-tool-group">
              <span className="hw-group-label">符号（点一下盖一个）</span>
              <div className="hw-glyphs">
                {STAMP_GLYPHS.map((g) => (
                  <button
                    key={g}
                    className={"hw-glyph" + (stampGlyph === g ? " on" : "")}
                    style={stampGlyph === g ? { color, borderColor: color } : undefined}
                    title={`标注符号 ${g}`}
                    aria-label={`标注符号 ${g}`}
                    onClick={() => setStampGlyph(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <span className="hw-hint">字号跟「粗细」滑杆走（当前 {stampFontSize(size)}px）</span>
            </div>
          )}

          <div className="hw-tool-group">
            <span className="hw-group-label">颜色</span>
            <div className="hw-colors">
              {palette.map((c) => (
                <button
                  key={c}
                  className={"hw-color" + (color === c ? " on" : "")}
                  style={{ background: c }}
                  title={c}
                  aria-label={`颜色 ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          <div className="hw-tool-group">
            <span className="hw-group-label">粗细 {size}</span>
            <input
              className="hw-size"
              type="range"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={1}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              aria-label="笔迹粗细"
            />
          </div>

          <div className="hw-tool-group hw-tool-row">
            <button
              className="hw-tool-icon"
              title="撤销（Ctrl+Z）"
              aria-label="撤销"
              disabled={!canUndo}
              onClick={doUndo}
            >
              <Icon name="undo" size={18} />
            </button>
            <button
              className="hw-tool-icon"
              title="重做（Ctrl+Y）"
              aria-label="重做"
              disabled={!canRedo}
              onClick={doRedo}
            >
              <Icon name="redo" size={18} />
            </button>
            <button className="hw-tool-icon" title="清空本页" aria-label="清空本页" onClick={doClearPage}>
              <Icon name="trash" size={18} />
            </button>
          </div>

          <div className="hw-tool-group">
            <span className="hw-group-label">输入方式</span>
            <button
              className={"hw-switch" + (fingerWrite ? " on" : "")}
              onClick={() => setFingerWrite((v) => !v)}
              title={
                fingerWrite
                  ? "手指也能书写：手掌误触可能被当成笔（没有笔时才用这个）"
                  : "只有笔能书写（推荐）：手指拖动 = 挪纸，双指 = 缩放"
              }
            >
              <Icon name="pen" size={15} />
              {fingerWrite ? "手指也能写" : "仅笔书写"}
            </button>
            {penSeen && !fingerWrite && <span className="hw-hint">已检测到触控笔</span>}
          </div>

          <div className="hw-tool-group">
            <button className="hw-switch" onClick={() => setShowDiag((v) => !v)} title="查看压感 / 倾斜 / 事件来源">
              <Icon name="info" size={15} />
              {showDiag ? "收起自检" : "笔自检"}
            </button>
          </div>
        </aside>

        {/* ---------------- 画布区 ---------------- */}
        <div className="hw-stage">
          <div className="hw-stage-bar">
            <div className="hw-subgroup">
              {PAPERS.map((pp) => (
                <button
                  key={pp}
                  className={"chip" + ((page?.paper ?? "grid") === pp ? " chip-active" : "")}
                  onClick={() => setPaper(pp)}
                  title={`纸面：${PAPER_LABEL[pp]}`}
                >
                  {PAPER_LABEL[pp]}
                </button>
              ))}
            </div>
            <div className="hw-subgroup">
              <button className="hw-tool-icon" title="适应宽度" aria-label="适应宽度" onClick={fitWidth}>
                <Icon name="fit" size={16} />
              </button>
              <button className="hw-tool-icon" title="缩小" aria-label="缩小" onClick={() => zoomBy(0.8)}>
                <Icon name="zoomOut" size={16} />
              </button>
              <span className="hw-zoom">{zoomPct}%</span>
              <button className="hw-tool-icon" title="放大" aria-label="放大" onClick={() => zoomBy(1.25)}>
                <Icon name="zoomIn" size={16} />
              </button>
            </div>
            <div className="hw-subgroup">
              <button
                className="hw-tool-icon"
                title="上一页"
                aria-label="上一页"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              >
                ‹
              </button>
              <span className="hw-pages">
                第 {pageIndex + 1} / {pageCount} 页
              </span>
              <button
                className="hw-tool-icon"
                title="下一页"
                aria-label="下一页"
                disabled={pageIndex >= pageCount - 1}
                onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
              >
                ›
              </button>
              <button className="ghost-btn" onClick={addPage} title="在后面加一页">
                <Icon name="plus" size={14} /> 加页
              </button>
              <button className="ghost-btn" onClick={removePage} title="删除当前页">
                删页
              </button>
            </div>
            <div className="hw-subgroup">
              <button
                className="ghost-btn"
                onClick={() => fileRef.current?.click()}
                title="把一张图片铺在当前页下面作为底图（可以在上面圈画）"
              >
                <Icon name="image" size={15} /> 底图
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void insertBg(files);
                }}
                aria-label="选择底图图片"
              />
              <button className="ghost-btn" onClick={exportPng} title="导出当前页为 PNG">
                <Icon name="download" size={15} /> PNG
              </button>
              <button className="ghost-btn" onClick={() => void printAll()} title="打印或另存为 PDF（逐页输出）">
                PDF
              </button>
              <button
                className="ghost-btn"
                disabled={ocrBusy}
                onClick={() => void runOcr()}
                title="把整页手写交给你的视觉模型转写成文字（会联网，用你自己的 Key）"
              >
                <Icon name="sparkles" size={15} /> {ocrBusy ? "识别中…" : "识别为文字"}
              </button>
            </div>
          </div>

          {/* R14b：选区动作条 —— **有选区才出现**（没选区时不占一行） */}
          {selCount > 0 && (
            <div className="hw-selbar">
              <span className="hw-selbar-info">已选中 {selCount} 笔</span>
              <button
                className="primary small"
                onClick={doHighlight}
                title="在选中的笔迹下面铺一条荧光色带（划重点；再点会叠一层，可撤销）"
              >
                高亮
              </button>
              <button className="ghost-btn" onClick={doRecolorSel} title="把选中的笔迹换成左边当前选中的颜色">
                换成当前颜色
              </button>
              <button className="danger-btn" onClick={doDeleteSel} title="删除选中的笔迹（Delete 键同效，可撤销）">
                删除
              </button>
              <span className="muted">在选区里按住拖动 = 整体移动</span>
              <button className="ghost-btn" onClick={doClearSel} title="取消选择（Esc 同效）">
                取消选择
              </button>
            </div>
          )}

          {ocrMsg && (
            <div className="hw-ocr-msg" onClick={() => setOcrMsg(null)}>
              {ocrMsg}
            </div>
          )}

          {/* R14：识别为文字的结果 —— 可预览、可复制、可清空；保存时它会跟笔记一起落库 */}
          {ocrText && (
            <div className="hw-ocr-panel">
              <div className="hw-ocr-head">
                <b>文字稿</b>
                <span className="src-badge src-ai">模型转写 · 非原文</span>
                <button className="ghost-btn" onClick={() => setOcrOpen((v) => !v)}>
                  {ocrOpen ? "收起" : "展开"}
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(ocrText);
                        setOcrMsg("文字稿已复制到剪贴板。");
                      } catch {
                        // 剪贴板可能被策略拒绝（非安全上下文 / 权限）—— 如实说，别假装复制成功
                        setOcrMsg("这个环境不允许直接写剪贴板：请展开后手动选中复制。");
                        setOcrOpen(true);
                      }
                    })();
                  }}
                >
                  复制
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => {
                    setOcrText("");
                    setOcrOpen(false);
                    setOcrMsg("已清空文字稿（记得保存，否则库里那份还在）。");
                  }}
                >
                  清空
                </button>
                <span className="muted">保存后它会写进笔记的「文字稿」小节</span>
              </div>
              {ocrOpen && <pre className="hw-ocr-body">{ocrText}</pre>}
            </div>
          )}

          {showDiag && (
            <div className="hw-diag">
              <div className="hw-diag-head">
                <b>笔自检</b>
                <span className="muted">
                  {coalescedOk
                    ? "支持合并事件：高采样率的笔不会被降级成鼠标。"
                    : "当前环境不支持合并事件：120Hz 的笔只能按帧取点，笔迹会略糙。"}
                </span>
              </div>
              {diag.length === 0 ? (
                <span className="muted">还没收到指针事件：用笔在纸上点一下（或者用鼠标点一下）。</span>
              ) : (
                <table className="hw-diag-table">
                  <thead>
                    <tr>
                      <th>来源</th>
                      <th>压感</th>
                      <th>倾斜</th>
                      <th>接触面积</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diag.map((d, i) => (
                      <tr key={i}>
                        <td>{d.type}</td>
                        <td>{d.pressure}</td>
                        <td>{d.tilt}</td>
                        <td>{d.contact}px</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <span className="muted">
                压感恒为 0.5 = 这支笔（或这个 WebView）不报压感，笔迹会是等宽的；倾斜恒为 0°/0° 同理。
              </span>
            </div>
          )}

          <div className="hw-canvas-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} className="hw-canvas" />
          </div>

          <footer className="hw-foot">
            <span>{page ? `${page.w}×${page.h}` : `${A4_W}×${A4_H}`}</span>
            <span>本页 {page?.strokes.length ?? 0} 笔</span>
            <span>
              全篇 {pageCount} 页 · {docPointCount(docRef.current)} 个点
            </span>
            <span>笔迹数据 {humanBytes(docChars(docRef.current))}</span>
            <span className="muted">
              {fingerWrite ? "手指也能写；手掌误触可能被当成笔。" : "笔书写 · 手指拖动纸张 · 双指缩放。"}
              画圆 / 画线**不会**自动变规整。
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 组件外的纯辅助
// ---------------------------------------------------------------------------

/** 荧光笔统一用暖黄（切回钢笔时用户选的颜色仍然保留在 state 里） */
function markerColorOf(c: string): string {
  return (MARKER_COLORS as readonly string[]).includes(c) ? c : MARKER_COLORS[0];
}
