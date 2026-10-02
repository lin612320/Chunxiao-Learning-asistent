import type { ReactNode } from "react";

/**
 * 全站图标集（**零依赖**：手写几何路径的内联 SVG）。
 *
 * 为什么不用图标库 / 保留 emoji：
 *   1. 项目硬约定「不新增第三方依赖」，所以图标必须自己画；
 *   2. 原先顶栏与导航用 emoji（🎯 ☀️ 🌙）当图标 —— emoji 在不同系统上字体不同、
 *      大小与基线不可控、颜色也无法跟随主题（暗色下尤其花），是"界面不高级"的典型来源。
 *      内联 SVG 用 `currentColor` 描边，自动跟随主题与文字色。
 *
 * 统一规格：24×24 视图框、线宽 1.6、圆角端点 —— 这样任意尺寸下笔画粗细观感一致。
 * 所有图标一律 `aria-hidden`：它们是**装饰性**的，语义由旁边的文字提供；
 * 若某个按钮只有图标，请在按钮上写 `aria-label` / `title`（不要靠图标自述）。
 */
export type IconName =
  | "home"
  | "book"
  | "chat"
  | "note"
  | "help"
  | "chart"
  | "timer"
  | "gear"
  | "target"
  | "sun"
  | "moon"
  | "lock"
  | "database"
  | "plus"
  | "chevron-right"
  | "info"
  | "inbox"
  | "check"
  | "alert"
  | "close"
  | "search"
  | "upload"
  | "download"
  | "edit"
  | "trash"
  | "play"
  | "pause"
  | "sparkles"
  | "bulb"
  | "refresh"
  // R12：笔记沉浸式编辑器的工具栏图标（沿用同一规格手绘，不引图标库）
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "quote"
  | "listUl"
  | "listOl"
  | "link"
  | "image"
  | "sigma"
  | "table"
  | "divider"
  // R13：材料
  | "folder"
  | "external"
  // R14：触控笔手写（工具栏）
  | "pen"
  | "pencil"
  | "marker"
  | "eraser"
  | "undo"
  | "redo"
  | "grid"
  | "fit"
  | "zoomIn"
  | "zoomOut"
  // R14b：标注工具
  | "line"
  | "select";

const PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3.2 10.6 12 3.4l8.8 7.2" />
      <path d="M5.6 9.6V20h12.8V9.6" />
      <path d="M9.9 20v-4.6h4.2V20" />
    </>
  ),
  book: (
    <>
      <path d="M4.2 4.6A2.2 2.2 0 0 1 6.4 2.4H19v16.2H6.4a2.2 2.2 0 0 0-2.2 2.2z" />
      <path d="M8.2 6.8h7" />
      <path d="M8.2 10.4h5" />
    </>
  ),
  chat: <path d="M20 11.8a7.7 7.7 0 0 1-11.2 6.9L4 20l1.3-4.3A7.7 7.7 0 1 1 20 11.8z" />,
  note: (
    <>
      <path d="M6.2 3.2h7.4l4.4 4.4v13.2H6.2z" />
      <path d="M13.6 3.2v4.4h4.4" />
      <path d="M9.2 12.2h6" />
      <path d="M9.2 15.8h4.2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.4 9.6a2.7 2.7 0 1 1 3.4 2.6c-.6.2-.9.7-.9 1.3v.5" />
      <path d="M12 17.1h.01" />
    </>
  ),
  chart: (
    <>
      <path d="M3.4 20h17.2" />
      <rect x="5.2" y="11.4" width="3.6" height="6" rx="1.2" />
      <rect x="10.2" y="6.6" width="3.6" height="10.8" rx="1.2" />
      <rect x="15.2" y="13.4" width="3.6" height="4" rx="1.2" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13.2" r="7.6" />
      <path d="M12 9.4v3.8l2.6 2" />
      <path d="M9.4 2.6h5.2" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.9v2.3M12 18.8v2.3M4.7 7.4l2 1.2M17.3 15.4l2 1.2M4.7 16.6l2-1.2M17.3 8.6l2-1.2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7.8" />
      <circle cx="12" cy="12" r="2.9" />
      <path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.1" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M5.4 18.6l1.6-1.6M17 7l1.6-1.6" />
    </>
  ),
  moon: <path d="M20 14.6A8.4 8.4 0 0 1 9.4 4 8.4 8.4 0 1 0 20 14.6z" />,
  lock: (
    <>
      <rect x="4.6" y="10.4" width="14.8" height="10" rx="2.6" />
      <path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.4" rx="7.4" ry="3" />
      <path d="M4.6 6.4v11.2c0 1.66 3.31 3 7.4 3s7.4-1.34 7.4-3V6.4" />
      <path d="M4.6 12c0 1.66 3.31 3 7.4 3s7.4-1.34 7.4-3" />
    </>
  ),
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  "chevron-right": <path d="m9.6 5.6 6.4 6.4-6.4 6.4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5" />
      <path d="M12 7.9h.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.6 13.4 6.2 5h11.6l2.6 8.4V19H3.6z" />
      <path d="M3.6 13.4h5.1l1 2.4h4.6l1-2.4h5.1" />
    </>
  ),
  check: <path d="m5 12.6 4.8 4.8L19 6.6" />,
  alert: (
    <>
      <path d="M12 3.8 2.9 19.8h18.2z" />
      <path d="M12 9.8v4.6" />
      <path d="M12 17.4h.01" />
    </>
  ),
  close: <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m15.8 15.8 4.4 4.4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16.2V4.4" />
      <path d="m7.6 8.8 4.4-4.4 4.4 4.4" />
      <path d="M4.4 15.8v2.6a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6v-2.6" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.4v11.8" />
      <path d="m7.6 11.8 4.4 4.4 4.4-4.4" />
      <path d="M4.4 15.8v2.6a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6v-2.6" />
    </>
  ),
  edit: (
    <>
      <path d="M4.2 19.8h4L19 9 15 5 4.2 15.8z" />
      <path d="M14.2 5.8 18.2 9.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4.8 7h14.4" />
      <path d="M9.4 7V4.8h5.2V7" />
      <path d="M6.6 7l1 12.4h8.8L17.4 7" />
    </>
  ),
  play: <path d="M8.4 5.4v13.2L19 12z" />,
  pause: <path d="M9.4 5.4v13.2M14.6 5.4v13.2" />,
  sparkles: (
    <>
      <path d="M11.6 3.6 13.1 8.7 18.2 10.2 13.1 11.7 11.6 16.8 10.1 11.7 5 10.2 10.1 8.7z" />
      <path d="m18.4 15.6.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  bulb: (
    <>
      <path d="M12 3.2a6.1 6.1 0 0 0-3.6 11v1.9h7.2V14.2A6.1 6.1 0 0 0 12 3.2z" />
      <path d="M9.4 18.6h5.2" />
      <path d="M10.4 21h3.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4.4V10h-5.6" />
    </>
  ),

  // ---- R12：笔记编辑器工具栏（规格同上：24 视图框 / currentColor 描边） ----
  bold: (
    <>
      <path d="M7.6 4.8h5.2a3.6 3.6 0 0 1 0 7.2H7.6z" />
      <path d="M7.6 12h6.2a3.6 3.6 0 0 1 0 7.2H7.6z" />
    </>
  ),
  italic: (
    <>
      <path d="M15.4 4.8h-4.2M12.8 19.2H8.6" />
      <path d="M14.6 4.8 10.2 19.2" />
    </>
  ),
  code: (
    <>
      <path d="m9.6 8.8-3.6 3.2 3.6 3.2" />
      <path d="m14.4 8.8 3.6 3.2-3.6 3.2" />
      <path d="M13.4 6.2 10.6 17.8" />
    </>
  ),
  heading: (
    <>
      <path d="M4.8 5.6v12.8M12.4 5.6v12.8M4.8 12h7.6" />
      <path d="M17 9.6l2-1.2v10.2M16.4 18.6h5" />
    </>
  ),
  quote: (
    <>
      <path d="M7.2 5.4v13.2" />
      <path d="M11.2 8.6h7.2M11.2 12h5.6M11.2 15.4h7.2" />
    </>
  ),
  listUl: (
    <>
      <path d="M9.6 6.6h10.2M9.6 12h10.2M9.6 17.4h10.2" />
      <circle cx="5.6" cy="6.6" r="1.2" />
      <circle cx="5.6" cy="12" r="1.2" />
      <circle cx="5.6" cy="17.4" r="1.2" />
    </>
  ),
  listOl: (
    <>
      <path d="M10.4 6.6h9.4M10.4 12h9.4M10.4 17.4h9.4" />
      <path d="M4.6 5.2h1.2v3.6M4.2 8.8h2.2" />
      <path d="M4 11.6h2.2v1.2l-2.2 2h2.2" />
      <path d="M4 17h2.2l-2.2 2.4h2.4" />
    </>
  ),
  link: (
    <>
      <path d="M10.4 13.6a3.4 3.4 0 0 0 4.8 0l2.8-2.8a3.4 3.4 0 0 0-4.8-4.8l-1.4 1.4" />
      <path d="M13.6 10.4a3.4 3.4 0 0 0-4.8 0l-2.8 2.8a3.4 3.4 0 0 0 4.8 4.8l1.4-1.4" />
    </>
  ),
  image: (
    <>
      <rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2.2" />
      <circle cx="8.8" cy="10.2" r="1.5" />
      <path d="m5.6 17.8 4.4-4.4 3.2 3.2 2.6-2.6 3.2 3.2" />
    </>
  ),
  sigma: <path d="M17.6 6.2H6.4l5.4 5.8-5.4 5.8h11.2" />,
  table: (
    <>
      <rect x="3.8" y="5.4" width="16.4" height="13.2" rx="1.8" />
      <path d="M3.8 10h16.4M9.8 10v8.6M15.2 10v8.6" />
    </>
  ),
  divider: <path d="M3.6 12h16.8M6.6 8.4h10.8M6.6 15.6h10.8" />,

  // ---- R13：材料 ----
  folder: (
    <>
      <path d="M3.6 7.2a2 2 0 0 1 2-2h3.4l2 2.4h7.4a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.6h5.4V10" />
      <path d="M19.4 4.6 12 12" />
      <path d="M18 14.6v3.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.6A1.6 1.6 0 0 1 5.6 6h3.8" />
    </>
  ),

  // ---- R14：触控笔手写 ----
  // 笔 = 斜杆 + 笔尖（手写的通用符号，比"钢笔轮廓"在任何尺寸下都更清楚）
  pen: (
    <>
      <path d="M16.4 3.9a1.9 1.9 0 0 1 2.7 2.7L8.6 17.1l-3.7 1 1-3.7z" />
      <path d="m14.6 5.7 3.7 3.7" />
    </>
  ),
  // 铅笔 = 同样的斜杆 + 尾部的"木质分割线"，与钢笔区分靠这一笔
  pencil: (
    <>
      <path d="M16.4 3.9a1.9 1.9 0 0 1 2.7 2.7L8.6 17.1l-3.7 1 1-3.7z" />
      <path d="M4.9 18.1 8 15" />
      <path d="M6.2 14.5 8.4 16.7" />
    </>
  ),
  // 荧光笔 = 粗笔身 + 一块"划出来的色带"
  marker: (
    <>
      <path d="M12.6 3.7 19.6 6l-5 11.2-4.9-1.7z" />
      <path d="M9.7 15.5 6.6 20.3H2.9" />
      <path d="M15.4 7.6l1 3.4" />
    </>
  ),
  // 橡皮 = 一块斜放的方块 + 擦掉的短线
  eraser: (
    <>
      <rect x="3.4" y="12.2" width="13.2" height="7.4" rx="1.6" transform="rotate(-45 10 15.9)" />
      <path d="M9.2 6.4 16 13.2" />
      <path d="M18.4 19.6h3.2" />
    </>
  ),
  // 撤销 / 重做：圆弧箭头（镜像的一对）
  undo: (
    <>
      <path d="M4.6 9.2h9.2a5 5 0 0 1 0 10H9" />
      <path d="M8.2 5.4 4.4 9.2l3.8 3.8" />
    </>
  ),
  redo: (
    <>
      <path d="M19.4 9.2H10.2a5 5 0 0 0 0 10h4.8" />
      <path d="M15.8 5.4l3.8 3.8-3.8 3.8" />
    </>
  ),
  grid: (
    <>
      <rect x="3.8" y="3.8" width="16.4" height="16.4" rx="1.8" />
      <path d="M9.2 3.8v16.4M14.8 3.8v16.4M3.8 9.2h16.4M3.8 14.8h16.4" />
    </>
  ),
  // 适应宽度 / 缩放：四角向外/向内的一对
  fit: (
    <>
      <path d="M4.4 9V4.4H9M15 4.4h4.6V9M19.6 15v4.6H15M9 19.6H4.4V15" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="10.6" cy="10.6" r="6.2" />
      <path d="M15.2 15.2 20 20" />
      <path d="M10.6 8v5.2M8 10.6h5.2" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.6" cy="10.6" r="6.2" />
      <path d="M15.2 15.2 20 20" />
      <path d="M8 10.6h5.2" />
    </>
  ),
  // 直线 = 一条斜线 + 两端端点（"尺子画的"那个意思）
  line: (
    <>
      <path d="M6.2 17.8 17.8 6.2" />
      <circle cx="5.4" cy="18.6" r="1.7" />
      <circle cx="18.6" cy="5.4" r="1.7" />
    </>
  ),
  // 框选 = 虚线矩形（四段断线，比实线更像"选区"）
  select: (
    <>
      <path d="M4 8.4V5.6a1.6 1.6 0 0 1 1.6-1.6h2.8" />
      <path d="M15.6 4h2.8A1.6 1.6 0 0 1 20 5.6v2.8" />
      <path d="M20 15.6v2.8a1.6 1.6 0 0 1-1.6 1.6h-2.8" />
      <path d="M8.4 20H5.6A1.6 1.6 0 0 1 4 18.4v-2.8" />
      <path d="M11 11h2v2h-2z" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  /** 显示边长（px）。默认 16；随文字用 16，独立按钮用 18。 */
  size?: number;
  className?: string;
  /** 线宽。默认 1.6；小尺寸下可调到 1.8 以免发虚。 */
  strokeWidth?: number;
}

export default function Icon({ name, size = 16, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
