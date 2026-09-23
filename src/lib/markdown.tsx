// M3 · T2：最小 Markdown → React 渲染器（**零依赖**）。
//
// 契约：`docs/07-M3契约.md` §一
//   · 支持：ATX 标题 / 无序·有序列表（含一层嵌套）/ ``` 代码块 / 行内代码 /
//     **粗体**·*斜体* / `>` 引用 / `---` 水平线 / 表格 / 链接 / 段落；
//   · 安全红线：**禁止** `dangerouslySetInnerHTML`、**禁止**拼接 HTML 字符串，
//     一切走 React 元素；链接只允许 `http:` / `https:` / `mailto:`，
//     其余（含 `javascript:`）**降级为纯文本**；代码块内容原样作为文本节点渲染。
//
// 块划分是批注锚点的地基（契约 §三）：
//   `splitBlocks(md)` 与渲染时每个块元素上的 `data-block={index}` **一一对应** ——
//   两者都由同一个 `parseBlocks()` 产出，因此不可能出现"渲染顺序与块序不一致"。
//   规则：表格整体一块、代码块整体一块、连续列表项一块、连续引用行一块、
//   单个标题 / 段落 / 水平线各一块。
//
// 批注层（契约 §4.1）：`marks` 用"**块内纯文本字符偏移**"定位。渲染行内内容时同步推进
//   一个纯文本游标，把标记切进 React 元素里（**不做任何 DOM 改写**），
//   因此 `data-block` 元素的 `textContent` 与这里算出的纯文本始终逐字一致，
//   选区偏移（见 `views/Notes.tsx`）与渲染偏移用的是同一把尺子。
//
// 额外导出（契约未列，纯附加，不改冻结项）：
//   · `blockPlainTexts(md)` —— 每个块的纯文本视图，批注自愈比对用；
//   · `MdMark` / `MdProps.marks` / `MdProps.terms` / `MdProps.onMarkClick` —— 批注层与关键词高亮层。

import { Fragment, useMemo, type ReactElement, type ReactNode } from "react";
import { normalizeTerms, splitByTerms } from "./highlight";

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/** 一条要画在正文里的批注标记：偏移是**该块纯文本内**的字符偏移（与 `data-block` 元素对齐） */
export interface MdMark {
  /** 批注 id（点击高亮时回传给 `onMarkClick`） */
  id: number;
  start: number;
  end: number;
  /** 颜色名：yellow / green / blue / pink / purple（拿不到就用默认色） */
  color?: string | null;
  /** 悬停提示（一般是批注备注的摘要） */
  title?: string | null;
}

export interface MdProps {
  text: string;
  className?: string;
  onSelectBlock?: (blockIndex: number) => void;
  /** 批注层：key = 块序号，value = 该块内的标记（M3 §三 锚点） */
  marks?: Record<number, MdMark[]>;
  /** 阅读辅助的关键词高亮（不落库，复用 `lib/highlight.tsx` 的口径） */
  terms?: readonly string[] | null;
  /** 点击已有高亮（用于编辑 / 删除批注） */
  onMarkClick?: (id: number) => void;
}

// ---------------------------------------------------------------------------
// 块解析
// ---------------------------------------------------------------------------

type Align = "left" | "center" | "right";

interface ListItem {
  ordered: boolean;
  text: string;
  children: ListItem[];
}

type Block =
  | { kind: "heading"; raw: string; level: number; text: string }
  | { kind: "hr"; raw: string }
  | { kind: "code"; raw: string; lang: string; code: string }
  | { kind: "table"; raw: string; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "list"; raw: string; items: ListItem[] }
  | { kind: "quote"; raw: string; lines: string[] }
  | { kind: "para"; raw: string; text: string };

const ATX_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** 一行是否是块级起点（段落遇到它就断开） */
function startsBlock(line: string, next: string | undefined): boolean {
  if (!line.trim()) return true;
  if (FENCE_RE.test(line)) return true;
  if (ATX_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (UL_RE.test(line) || OL_RE.test(line)) return true;
  if (isTableStart(line, next)) return true;
  return false;
}

/** 表格起始：本行含 `|` 且下一行是分隔行 */
function isTableStart(line: string, next: string | undefined): boolean {
  if (!line.includes("|")) return false;
  if (!next || !next.includes("-")) return false;
  return TABLE_SEP_RE.test(next);
}

/** 拆表格行（容忍 `\|` 转义与首尾可有可无的竖线） */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/\\\|/g, "\u0000");
  const body = s.replace(/^\|/, "").replace(/\|$/, "");
  return body.split("|").map((c) => c.replace(/\u0000/g, "|").trim());
}

function parseAlign(sep: string[]): Align[] {
  return sep.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

/**
 * 把 Markdown 切成块数组（索引从 0 开始）。
 * **`splitBlocks` 与渲染共用本函数**，这是 `data-block` 与块序一致的根本保证。
 */
function parseBlocks(md: string): Block[] {
  const src = (md ?? "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ① 代码块（``` 或 ~~~ 围栏，整体一块）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const fenceChar = marker[0] === "`" ? "`" : "~";
      // 反引号 / 波浪号在正则里都不是元字符，直接拼即可
      const closer = new RegExp("^ {0,3}" + fenceChar + "{" + marker.length + ",}\\s*$");
      const body: string[] = [];
      const raw: string[] = [line];
      i += 1;
      while (i < lines.length) {
        if (closer.test(lines[i])) {
          raw.push(lines[i]);
          i += 1;
          break;
        }
        body.push(lines[i]);
        raw.push(lines[i]);
        i += 1;
      }
      // 未闭合的围栏：原样收到文末（不假装它是普通段落）
      blocks.push({ kind: "code", raw: raw.join("\n"), lang: fence[2] ?? "", code: body.join("\n") });
      continue;
    }

    // ② ATX 标题（单个标题一块）
    const atx = ATX_RE.exec(line);
    if (atx) {
      blocks.push({
        kind: "heading",
        raw: line,
        level: atx[1].length,
        text: stripClosingHashes(atx[2] ?? ""),
      });
      i += 1;
      continue;
    }

    // ③ 水平线（`---`，单块；必须排在列表之前，否则 `- - -` 会被当成列表）
    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr", raw: line });
      i += 1;
      continue;
    }

    // ④ 表格（表头 + 分隔行 + 连续数据行，整体一块）
    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line);
      const align = parseAlign(splitRow(lines[i + 1]));
      const raw = [line, lines[i + 1]];
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        const fixed: string[] = [];
        for (let c = 0; c < header.length; c += 1) fixed.push(cells[c] ?? "");
        rows.push(fixed);
        raw.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "table", raw: raw.join("\n"), header, align, rows });
      continue;
    }

    // ⑤ 列表（连续列表项一块，含一层嵌套）
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const items: ListItem[] = [];
      const raw: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = UL_RE.exec(cur) ?? OL_RE.exec(cur);
        if (!m) break;
        const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
        const ordered = UL_RE.test(cur) ? false : true;
        const text = m[3] ?? "";
        raw.push(cur);
        const item: ListItem = { ordered, text, children: [] };
        if (indent >= 2 && items.length > 0) items[items.length - 1].children.push(item);
        else items.push(item);
        i += 1;
      }
      blocks.push({ kind: "list", raw: raw.join("\n"), items });
      continue;
    }

    // ⑥ 引用（连续 `>` 行一块）
    if (QUOTE_RE.test(line)) {
      const quotes: string[] = [];
      const raw: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i]);
        if (!m) break;
        quotes.push(m[1] ?? "");
        raw.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "quote", raw: raw.join("\n"), lines: quotes });
      continue;
    }

    // ⑦ 段落（连续非空、且不是其他块起点的行；软换行按空格拼接）
    const para: string[] = [];
    const raw: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim());
      raw.push(lines[i]);
      i += 1;
    }
    if (para.length === 0) {
      // 兜底：本行是某个块起点却没被上面接住（理论上不会发生）→ 按单行段落收掉，绝不丢内容
      para.push(line.trim());
      raw.push(line);
      i += 1;
    }
    blocks.push({ kind: "para", raw: raw.join("\n"), text: para.join(" ") });
  }

  return blocks;
}

/** `# 标题 ###` → `标题`（仅当收尾 `#` 前有空白） */
function stripClosingHashes(s: string): string {
  return s.replace(/\s+#+\s*$/, "").trim();
}

/**
 * 供批注锚点与 Rust 侧块序保持一致的块数组（契约 §一）。
 * 返回的是**块的原始 Markdown 文本**（不是纯文本）。
 */
export function splitBlocks(md: string): string[] {
  return parseBlocks(md).map((b) => b.raw);
}

/**
 * 每个块的**纯文本**视图（契约未列，附加导出）。
 * 口径 = 渲染后 `[data-block]` 元素的 `textContent`：
 *   · 行内标记（`**` `*` `` ` `` 链接语法）被去掉；
 *   · 引用多行用 `<br>` 分隔，`<br>` 不产生文本 → 直接首尾相接；
 *   · 表格按 thead → tbody 的 DOM 顺序拼接单元格文本。
 */
export function blockPlainTexts(md: string): string[] {
  return parseBlocks(md).map(blockPlainText);
}

function blockPlainText(b: Block): string {
  switch (b.kind) {
    case "heading":
      return plainInline(b.text);
    case "para":
      return plainInline(b.text);
    case "quote":
      return b.lines.map(plainInline).join("");
    case "code":
      return b.code;
    case "list":
      return listPlainText(b.items);
    case "table":
      return b.header.map(plainInline).join("") + b.rows.map((r) => r.map(plainInline).join("")).join("");
    case "hr":
      return "";
  }
}

function listPlainText(items: ListItem[]): string {
  let s = "";
  for (const it of items) s += plainInline(it.text) + listPlainText(it.children);
  return s;
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

type Tok =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; label: string; href: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "strongem"; v: string };

/** 每次新建正则，避免 `lastIndex` 跨调用泄漏 */
function inlineRe(): RegExp {
  return new RegExp(
    [
      "(`+)([\\s\\S]*?)\\1", // 1,2 行内代码
      "\\[([^\\]\\n]*)\\]\\(([^()\\s]*)\\)", // 3,4 链接
      "\\*\\*\\*([\\s\\S]+?)\\*\\*\\*", // 5   粗 + 斜
      "___([\\s\\S]+?)___", // 6
      "\\*\\*([\\s\\S]+?)\\*\\*", // 7   粗体
      "__([\\s\\S]+?)__", // 8
      "\\*([^*\\n]+?)\\*", // 9   斜体
      "_([^_\\n]+?)_", // 10
    ].join("|"),
    "g",
  );
}

/**
 * 链接协议白名单（契约 §一 安全红线）：
 * 只放行 `http:` / `https:` / `mailto:`；其余（`javascript:` / `data:` / 相对路径 …）
 * 一律返回 null，由调用方**降级为纯文本**。
 */
export function safeHref(raw: string): string | null {
  const u = (raw ?? "").trim();
  if (!u) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(u)) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return u;
  return null;
}

function tokenizeInline(text: string): Tok[] {
  const out: Tok[] = [];
  const re = inlineRe();
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: "text", v: text.slice(last, idx) });
    last = idx + m[0].length;
    if (m[1] !== undefined) {
      out.push({ t: "code", v: m[2] ?? "" });
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4] ?? "");
      // 不安全 / 不支持的协议 → 整段按纯文本渲染（不生成 <a>）
      if (href) out.push({ t: "link", label: m[3], href });
      else out.push({ t: "text", v: m[0] });
    } else if (m[5] !== undefined) {
      out.push({ t: "strongem", v: m[5] });
    } else if (m[6] !== undefined) {
      out.push({ t: "strongem", v: m[6] });
    } else if (m[7] !== undefined) {
      out.push({ t: "strong", v: m[7] });
    } else if (m[8] !== undefined) {
      out.push({ t: "strong", v: m[8] });
    } else if (m[9] !== undefined) {
      out.push({ t: "em", v: m[9] });
    } else if (m[10] !== undefined) {
      out.push({ t: "em", v: m[10] });
    } else {
      out.push({ t: "text", v: m[0] });
    }
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** 行内内容的纯文本（与渲染出来的 `textContent` 逐字一致） */
function plainInline(text: string): string {
  let s = "";
  for (const tok of tokenizeInline(text)) {
    if (tok.t === "text" || tok.t === "code") s += tok.v;
    else if (tok.t === "link") s += plainInline(tok.label);
    else s += plainInline(tok.v);
  }
  return s;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

interface RenderCtx {
  off: number;
  marks: MdMark[];
  terms: string[];
  onMarkClick?: (id: number) => void;
  key: number;
}

const MARK_COLORS = new Set(["yellow", "green", "blue", "pink", "purple"]);

function markColor(c: string | null | undefined): string {
  const v = (c ?? "").trim().toLowerCase();
  return MARK_COLORS.has(v) ? v : "yellow";
}

/** 纯文本片段 → React 节点数组：先切批注标记，再在未标记处套关键词高亮 */
function emitText(text: string, ctx: RenderCtx): ReactNode[] {
  const base = ctx.off;
  const end = base + text.length;
  ctx.off = end;
  if (text.length === 0) return [];

  const cuts = new Set<number>([base, end]);
  for (const mk of ctx.marks) {
    if (mk.end <= base || mk.start >= end) continue;
    cuts.add(Math.max(mk.start, base));
    cuts.add(Math.min(mk.end, end));
  }
  const points = Array.from(cuts).sort((a, b) => a - b);

  const nodes: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    if (e <= s) continue;
    const piece = text.slice(s - base, e - base);
    const covering = ctx.marks
      .filter((mk) => mk.start <= s && mk.end >= e)
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    if (covering.length === 0) {
      nodes.push(...emitTerms(piece, ctx));
      continue;
    }
    // 覆盖该片段的批注（多重批注→由外到内嵌套，不静默丢任何一条）
    let node: ReactNode = piece;
    for (let k = covering.length - 1; k >= 0; k -= 1) {
      const mk = covering[k];
      node = (
        <mark
          key={`mk${ctx.key++}`}
          className={`md-mark md-mark-${markColor(mk.color)}`}
          data-anno-id={mk.id}
          title={mk.title ? String(mk.title) : undefined}
          onClick={
            ctx.onMarkClick
              ? (ev) => {
                  ev.stopPropagation();
                  ctx.onMarkClick?.(mk.id);
                }
              : undefined
          }
        >
          {node}
        </mark>
      );
    }
    nodes.push(node);
  }
  return nodes;
}

/** 阅读辅助：关键词命中处套 `<mark class="hl-mark">`（复用 `lib/highlight.tsx` 的切分口径） */
function emitTerms(text: string, ctx: RenderCtx): ReactNode[] {
  if (ctx.terms.length === 0 || !text) return [text];
  return splitByTerms(text, ctx.terms).map((seg, i) =>
    seg.hit ? (
      <mark key={`hl${ctx.key++}-${i}`} className="hl-mark">
        {seg.text}
      </mark>
    ) : (
      seg.text
    ),
  );
}

function renderInline(text: string, ctx: RenderCtx): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const tok of tokenizeInline(text)) {
    if (tok.t === "text") {
      nodes.push(...emitText(tok.v, ctx));
    } else if (tok.t === "code") {
      nodes.push(
        <code key={`c${ctx.key++}`} className="md-inline-code">
          {emitText(tok.v, ctx)}
        </code>,
      );
    } else if (tok.t === "link") {
      nodes.push(
        <a
          key={`a${ctx.key++}`}
          className="md-link"
          href={tok.href}
          target="_blank"
          rel="noreferrer"
        >
          {renderInline(tok.label, ctx)}
        </a>,
      );
    } else if (tok.t === "strong") {
      nodes.push(<strong key={`s${ctx.key++}`}>{renderInline(tok.v, ctx)}</strong>);
    } else if (tok.t === "em") {
      nodes.push(<em key={`e${ctx.key++}`}>{renderInline(tok.v, ctx)}</em>);
    } else {
      nodes.push(
        <strong key={`b${ctx.key++}`}>
          <em>{renderInline(tok.v, ctx)}</em>
        </strong>,
      );
    }
  }
  return nodes;
}

function renderList(items: ListItem[], ctx: RenderCtx): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const ordered = items[i].ordered;
    const run: ListItem[] = [];
    while (i < items.length && items[i].ordered === ordered) {
      run.push(items[i]);
      i += 1;
    }
    const Tag = ordered ? "ol" : "ul";
    nodes.push(
      <Tag key={`l${ctx.key++}`} className="md-list">
        {run.map((it) => (
          <li key={`i${ctx.key++}`}>
            {renderInline(it.text, ctx)}
            {it.children.length > 0 ? renderList(it.children, ctx) : null}
          </li>
        ))}
      </Tag>,
    );
  }
  return nodes;
}

function renderBlock(
  b: Block,
  index: number,
  marks: MdMark[],
  terms: string[],
  onMarkClick?: (id: number) => void,
): ReactElement {
  const ctx: RenderCtx = { off: 0, marks, terms, onMarkClick, key: 0 };

  switch (b.kind) {
    case "heading": {
      const Tag = (`h${Math.min(6, Math.max(1, b.level))}` as "h1");
      return (
        <Tag className={`md-heading md-h${b.level}`} data-block={index}>
          {renderInline(b.text, ctx)}
        </Tag>
      );
    }
    case "hr":
      return <hr className="md-hr" data-block={index} />;
    case "code":
      return (
        <pre className="md-pre" data-block={index} data-lang={b.lang || undefined}>
          <code>{emitText(b.code, ctx)}</code>
        </pre>
      );
    case "table":
      return (
        <div className="md-table-wrap" data-block={index}>
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((cell, ci) => (
                  <th key={`th${ci}`} style={{ textAlign: b.align[ci] ?? "left" }}>
                    {renderInline(cell, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={`tr${ri}`}>
                  {b.header.map((_, ci) => (
                    <td key={`td${ci}`} style={{ textAlign: b.align[ci] ?? "left" }}>
                      {renderInline(row[ci] ?? "", ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return (
        <div className="md-list-wrap" data-block={index}>
          {renderList(b.items, ctx)}
        </div>
      );
    case "quote":
      return (
        <blockquote className="md-quote" data-block={index}>
          <p>
            {b.lines.map((ln, li) => (
              <span key={`q${li}`}>
                {li > 0 ? <br /> : null}
                {renderInline(ln, ctx)}
              </span>
            ))}
          </p>
        </blockquote>
      );
    case "para":
      return (
        <p className="md-p" data-block={index}>
          {renderInline(b.text, ctx)}
        </p>
      );
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export default function Markdown({
  text,
  className,
  onSelectBlock,
  marks,
  terms,
  onMarkClick,
}: MdProps): ReactElement {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const termList = useMemo(() => normalizeTerms(terms), [terms]);

  const pick = onSelectBlock
    ? () => {
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0) return;
        const start = sel.getRangeAt(0).startContainer;
        const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
        const holder = el?.closest("[data-block]");
        if (!holder || !(holder instanceof HTMLElement)) return;
        const idx = Number(holder.dataset.block);
        if (Number.isFinite(idx)) onSelectBlock(idx);
      }
    : undefined;

  return (
    <div
      className={className ? `md-body ${className}` : "md-body"}
      onMouseUp={pick}
      onKeyUp={pick}
    >
      {/* `key` 必须给：`renderBlock` 返回的元素本身不带 key，直接放进数组会让 React 每次渲染
          都报 “Each child in a list should have a unique key prop”（控制台报错会被 UI 冒烟的
          「页面无 console 报错」断言抓到）。Fragment 不产生 DOM 节点，块级结构完全不变。 */}
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i, marks?.[i] ?? [], termList, onMarkClick)}</Fragment>
      ))}
    </div>
  );
}
