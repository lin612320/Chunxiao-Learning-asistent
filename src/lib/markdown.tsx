// M3 · T2：最小 Markdown → React 渲染器（**零依赖**）。
// M4：在 M3 基础上**附加**数学公式（行内 `$…$` / 块级 `$$…$$`，交给 `lib/math.tsx` 的 KaTeX 渲染）。
//
// 契约：`docs/07-M3契约.md` §一
//   · 支持：ATX 标题 / 无序·有序列表（含一层嵌套）/ ``` 代码块 / 行内代码 /
//     **粗体**·*斜体* / `>` 引用 / `---` 水平线 / 表格 / 链接 / 段落；
//     **M4 新增**：行内 `$…$` 与块级 `$$…$$` 数学公式；
//   · 安全红线：**禁止** `dangerouslySetInnerHTML`、**禁止**拼接 HTML 字符串，
//     一切走 React 元素；链接只允许 `http:` / `https:` / `mailto:`，
//     其余（含 `javascript:`）**降级为纯文本**；代码块内容原样作为文本节点渲染。
//     数学渲染同样守这条线：用 KaTeX 的命令式 `katex.render(tex, dom, opts)`，
//     **不用**返回 HTML 字符串的 `renderToString()`（详见 `lib/math.tsx`）。
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
// M4 数学的尺子（**二者仍共用同一把尺子**）：
//   · 公式对纯文本游标的**贡献 = 它出现在原文里的那段字符**，行内 `$E=mc^2$`（含定界符）
//     算 8 个字符，块级 `$$\n…\n$$` 算整段原文 —— `plainInline()` 与渲染侧
//     `renderInline()` 都按同一段原文长度推进，所以偏移在两侧**逐位对齐**。
//   · ⚠ **已知且真实的局限，不假装不变量在全场景成立**：KaTeX 画出来的 DOM 里是**真字符**
//     （`.katex-mathml` 的 MathML 文本 + `.katex-html` 里拼出来的字形），
//     所以"含公式的块"其 `[data-block]` 元素的 `textContent` 会**长于** `blockPlainTexts()`
//     —— 即 `textContent === blockPlainTexts()` 这条不变量在含公式的块上**不再逐字成立**。
//     不做 Shadow DOM 就无法两全（要么丢公式的可见文本，要么破坏偏移尺子），
//     本次选择"尺子优先"：保偏移定位，宁可让 textContent 更长。
//     · 影响面：只有**恰好含行内公式**的那些块，批注高亮的边界可能整体偏移几个字符；
//     · 安全网：`lib/notes.ts` 的批注自愈（按原文片段重新定位，找不到就进「已失效的批注」）
//       会把对不上的批注挑出来，**不会静默丢数据**；
//     · 可检测：`hasInlineMath(md)` / `blockHasInlineMath(md)` 让调用方先知道
//       "这一段里有公式"，再决定是否相信块内偏移（也可以直接放弃对这些块做偏移锚定）。
//
// 额外导出（契约未列，纯附加，不改冻结项）：
//   · `blockPlainTexts(md)` —— 每个块的纯文本视图，批注自愈比对用；
//   · `MdMark` / `MdProps.marks` / `MdProps.terms` / `MdProps.onMarkClick` —— 批注层与关键词高亮层；
//   · `hasInlineMath(md)` / `blockHasInlineMath(md)` —— M4 附加：探测行内公式（见上"已知局限"）。

import { Fragment, useMemo, type ReactElement, type ReactNode } from "react";
import { normalizeTerms, splitByTerms } from "./highlight";
// 刻意别名叫 `MdMath`：本文件里到处在用全局 `Math.min` / `Math.max`（标题层级钳位），
// 直接 `import Math from "./math"` 会**遮蔽全局 `Math`**，`Math.min` 当场变成属性访问错误。
import MdMath from "./math";

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
  // M4：块级公式 `$$…$$`（单行或跨行）。`raw` 是含定界符的原文，
  // `tex` 是剥掉定界符的公式体，交给 `<Math display />`。
  | { kind: "math"; raw: string; tex: string }
  | { kind: "para"; raw: string; text: string };

const ATX_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * M4 · 块级公式的**起始行**：一行（去空白后）**恰好以 `$$` 开头**。
 * 允许"`$$` 单独一行"和"`$$E=mc^2$$` 单行写完"两种写法，
 * 结束位置在 `parseBlocks()` 里继续扫（见那里的 `$$` 块分支）。
 * 行内公式靠行内分词器识别，不走这里。
 */
const MATH_FENCE_RE = /^\s*\$\$/;

/**
 * M4 · 行内公式 `$…$` 的识别规则（pandoc 口径，**刻意保守**，避免把钱当公式）：
 *   · 开定界符 `$` **后面不能是空白**（`$ 100` / `$ x$` 不算公式）；
 *   · 公式体**非空**、**不含 `$` 与换行**，且用**懒惰量词**（`+?`）取到**第一个合格的闭合 `$`**；
 *   · 闭定界符 `$` **后面不能是数字**（`$20,000 and $30,000`、`$5 and $10` 这类金额不会被误判）；
 *     —— 因为取的是第一个合格闭合符，`US$5 and US$10` 里第一个 `$` 的候选闭合符是 `$10` 的 `$`，
 *     被 `(?!\d)` 否决后引擎会继续往后找，最终找不到 → 整体不算公式；
 *   · 定界符之间**不处理转义**（TeX 里 `\$` 本来就有意义），一律原样交给 KaTeX；
 *   · `\$5 and \$10` 里两个 `$` 都凑不出"闭合符后面不是数字"的组合，因此转义美元不会被当公式起点。
 *
 * ⚠ 实测踩过的坑，别再改回去：开定界符那条"前面不能是数字"**不能用后行断言实现**。
 *   写 `(?<![\d$])` 时，V8 会让整条正则在 `$E=mc^2$` 这种完全正常的公式上**一个都匹配不到**
 *   （已用 6 个变体逐个对照确认：只有带这个断言的两版全灭，去掉后立刻正常）。
 *   所以这里走"闭定界符 + 懒惰量词"这条等价且可靠的路线，规则更少、行为可预测。
 *
 * 注意：本常量带 `g` 供内部使用，`new RegExp(INLINE_MATH_SRC, "g")` 时必须**克隆**再用
 * （同一个正则对象的 `lastIndex` 跨调用会串）。
 */
const INLINE_MATH_SRC = "\\$(?!\\s)([^$\\n]+?)\\$(?!\\d)";

/** 一行是否是块级起点（段落遇到它就断开） */
function startsBlock(line: string, next: string | undefined): boolean {
  if (!line.trim()) return true;
  if (FENCE_RE.test(line)) return true;
  // M4：`$$` 独占一行 → 段落必须在此断开，否则公式会被卷进上一段的软换行里。
  // 必须排在 HR_RE 之前：`$$` 单行写法本质是"行首 `$$`"，先判公式语义更直白。
  if (MATH_FENCE_RE.test(line)) return true;
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

    // ①′ M4 块级公式 `$$…$$`（整体一块；跨行时一直读到闭定界符）
    //    · 必须排在代码块之后（``` 围栏里的 `$$` 是字面量，绝不能被当公式）；
    //    · 必须排在水平线之前（`$$` 不该被 `---` 那一套规则抢先）；
    //    · 未闭合 / 行尾只剩一个 `$$` → 按单行公式收掉，**不假装它是普通段落**（诚实取舍）。
    if (MATH_FENCE_RE.test(line)) {
      const t = line.trim();
      const single = /^\$\$[\s\S]*\$\$$/.test(t);
      if (single) {
        // `$$E=mc^2$$`：首尾各 2 个字符是定界符
        blocks.push({ kind: "math", raw: line, tex: t.slice(2, -2) });
        i += 1;
        continue;
      }
      // `$$` 起、跨行扫到下一个"恰好是 `$$`"的行
      const raw: string[] = [line];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        if (lines[i].trim() === "$$") {
          raw.push(lines[i]);
          i += 1;
          break;
        }
        body.push(lines[i]);
        raw.push(lines[i]);
        i += 1;
      }
      // 正文整体 trim：`$$` 行的换行与 KaTeX 无关，去掉后 tex 更干净（偏移尺子仍按 raw 走）
      blocks.push({ kind: "math", raw: raw.join("\n"), tex: body.join("\n").trim() });
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
 *   · 表格按 thead → tbody 的 DOM 顺序拼接单元格文本；
 *   · M4 公式：**贡献原文本身**（行内含 `$` 定界符，块级含 `$$…$$`），
 *     与渲染侧游标用同一段原文长度推进 —— 但 KaTeX 渲染出的 DOM 另有真字符，
 *     含公式的块上本函数与真实 `textContent` 会不一致，**这是已知局限**（见文件头 M4 段）。
 */
export function blockPlainTexts(md: string): string[] {
  return parseBlocks(md).map(blockPlainText);
}

/**
 * M4 附加导出：这一段 Markdown 里**有没有行内公式**。
 * 用途：调用方（如批注锚定）可以先问一句"这里有公式吗"，再决定要不要相信块内字符偏移
 * —— 含公式的块上 `textContent` 会比 `blockPlainTexts()` 更长（KaTeX 画出来的是真字符）。
 * 口径与 `blockHasInlineMath()` **刻意保持一致**（避免"整体说有、却没有一块说有的"自相矛盾）：
 *   · 代码块（``` / ~~~ 围栏、缩进 4 空格的行）里的 `$` 是字面量，**不算**公式；
 *   · 块级 `$$…$$` **不算**行内公式（它有自己的块类型，本来就不是"行内"）；
 *   · 其余正文（含引用行、表格行、列表项、标题）与块级判定共用同一套 `INLINE_MATH_SRC`。
 * 即 `hasInlineMath(md) === blockHasInlineMath(md).some(Boolean)`。
 */
export function hasInlineMath(md: string): boolean {
  return inlineMathTexts(md).some((t) => mathSpansIn(t).length > 0);
}

/**
 * `md` 里所有**会走行内分词**的文本行：跳过 ``` / ~~~ 围栏与缩进代码行、跳过块级公式行。
 * 只做"行级"过滤（不做块级重建）是本函数的取舍：它要回答的是"整篇里有没有行内公式"，
 * 而"逐个块精确回答"已经由 `blockHasInlineMath()` 负责（那边直接复用 `parseBlocks()` 的结果）。
 */
function inlineMathTexts(md: string): string[] {
  const src = (md ?? "").replace(/\r\n?/g, "\n");
  const out: string[] = [];
  let inFence: string | null = null;
  for (const line of src.split("\n")) {
    const fence = FENCE_RE.exec(line);
    if (inFence) {
      // 闭合围栏：与 parseBlocks 的 closer 同构（同种字符、长度不短于起始）
      if (fence && fence[1][0] === inFence[0] && fence[1].length >= inFence.length) inFence = null;
      continue;
    }
    if (fence) {
      inFence = fence[1];
      continue;
    }
    // 缩进 4 空格 / Tab 的整行 = 缩进代码块，不参与行内分词
    if (/^(?: {4,}|\t)/.test(line)) continue;
    // 块级公式行整体跳过：`$$` 不是行内公式
    if (MATH_FENCE_RE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * M4 附加导出：**逐块**给出"这个块里有没有行内公式"，下标与 `splitBlocks()` / `[data-block]` 一一对应。
 * 块级公式（`kind: "math"`）**不算**行内公式，仍报 `false`；
 * 代码块永远报 `false`（``` 围栏里的 `$` 是字面量，本来就不参与行内分词）。
 */
export function blockHasInlineMath(md: string): boolean[] {
  return parseBlocks(md).map((b) => mathSpansIn(blockInlineTexts(b)).length > 0);
}

/** 一个块里所有**会走行内分词**的原文片段（代码块 / 水平线 / 块级公式没有） */
function blockInlineTexts(b: Block): string[] {
  switch (b.kind) {
    case "heading":
    case "para":
      return [b.text];
    case "quote":
      return b.lines;
    case "table":
      return [...b.header, ...b.rows.flat()];
    case "list":
      return listInlineTexts(b.items);
    case "code":
    case "hr":
    case "math":
      return [];
  }
}

function listInlineTexts(items: ListItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    out.push(it.text, ...listInlineTexts(it.children));
  }
  return out;
}

/**
 * 文本里行内公式的原文片段（切片保留 `$…$` 定界符，长度 = 它在原文里占的字符数）。
 * 允许传数组：调用方手上经常是"一个块的若干段行内原文"（`blockInlineTexts()` 的产物），
 * 合并扫描一遍即可，不必先 join（join 会凭空造出跨段边界，反而可能凑出假公式）。
 */
function mathSpansIn(text: string | readonly string[]): string[] {
  const out: string[] = [];
  const mathRe = new RegExp(INLINE_MATH_SRC, "g");
  const parts = typeof text === "string" ? [text] : text;
  for (const part of parts) {
    mathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = mathRe.exec(part)) !== null) {
      out.push(m[0]);
      if (m[0].length === 0) mathRe.lastIndex += 1;
    }
  }
  return out;
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
    // M4：块级公式的纯文本 = 整段原文（含 `$$` 定界符）。
    // 注意与渲染侧的差别：渲染时公式体由 KaTeX 画成真字符，这里仍是源码，
    // 所以含块级公式的块同样落在"textContent 更长"的已知局限里（见文件头）。
    case "math":
      return b.raw;
  }
}

function listPlainText(items: ListItem[]): string {
  let s = "";
  // 与渲染侧 `renderList` 同序：列表项文本 → 嵌套子项文本
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
  | { t: "strongem"; v: string }
  // M4：行内公式。`v` 是**含 `$` 定界符的原文**（偏移尺子要的就是它），`tex` 是剥好的公式体。
  | { t: "math"; v: string; tex: string }
  // R12：图片。`src` 已经过 `safeImageSrc()` 过滤（只放行图片型 dataURL 与 http/https）。
  | { t: "image"; alt: string; src: string };

/** 行内强调 / 代码 / 链接规则（每次新建正则，避免 `lastIndex` 跨调用泄漏） */
function emphasisRe(): RegExp {
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
      // R12：图片。**放在最后**是安全的：本规则只能从 `!` 起匹配，而上面的规则
      // 都不可能从 `!` 起匹配 —— 正则取最左匹配，所以在 `![…](…)` 上仍然是它赢，
      // 同时又不必把上面 10 个分组全部重新编号（那是纯粹的自找麻烦）。
      "!\\[([^\\]\\n]*)\\]\\(([^()\\s]*)\\)", // 11,12 图片（alt, src）
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

/** 图片专用地址白名单（与链接白名单**刻意不同**，见 `safeImageSrc` 注释） */
const IMG_DATA_SRC_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i;

/**
 * 图片地址白名单（R12）。
 *
 * 为什么不能直接用 `safeHref`：笔记里的图片是**用户自己粘贴的 dataURL**（契约见 `docs/23`），
 * 而 `safeHref` 为了挡住 `javascript:` 之类，把 `data:` 一并拒了 —— 直接复用会导致
 * 「图片存进了正文，预览里却什么都看不到」（本轮的冒烟断言正是这么抓到这个缺口的）。
 *
 * 所以这里**只对图片**开一个更窄的口子：
 *   · 放行 `data:image/{png,jpeg,jpg,webp,gif};base64,…` —— 这几个正是
 *     `lib/images.ts`（canvas → `toDataURL`）唯一会产出的类型；
 *   · **刻意排除 `image/svg+xml`**：SVG 是可执行文档类型，将来只要有人把同一段
 *     地址放进非 `<img>` 的上下文（`<object>` / 直接导航），它就是一个脚本注入面。
 *     排除它**不会挡住任何真实用法** —— 图片管线根本产不出 SVG；
 *   · 仍然放行 `http(s):` 的普通图片地址（用户从网上粘的图）；
 *   · 其余（`javascript:` / `file:` / `data:text/html` …）→ 返回 null，
 *     由调用方**整段降级为纯文本**，绝不生成 `<img>`。
 */
export function safeImageSrc(raw: string): string | null {
  const u = (raw ?? "").trim();
  if (!u) return null;
  if (IMG_DATA_SRC_RE.test(u)) return u;
  const h = safeHref(u);
  return h && /^https?:/i.test(h) ? h : null;
}

/**
 * 行内分词：**先切公式，其余再走强调规则**。
 *
 * 顺序是硬要求 —— 公式必须能"整段吃掉"内部字符，否则 `$a_1 * b_2$` 里的 `_`/`*`
 * 会先被强调规则抢走，公式就被切碎了。所以这里先用 `INLINE_MATH_SRC` 把公式整体摘出来，
 * 剩下的片段才交给 `tokenizeEmphasis()`（它用的 `emphasisRe()` 里**不含**公式规则）。
 *
 * 为什么不是把公式塞进同一个大正则：`*$a$*` 这种"强调里套公式"的写法，
 * 单趟大正则只能命中其中一条（命中了 `*…*` 就吃不到里面的 `$…$`，反之亦然）。
 * 分开处理后 `*$a$*` → `<em>` 里套公式，而 `$a_1 * b_2$` 整段是一个 math token，
 * `_`/`*` 一个字都不会被动。
 *
 * `\$` 转义：`\$5 and \$10` 里两个 `$` 都不满足成对定界规则（开定界符后面是数字、
 * 闭定界符后面也是数字都会被否决），因此转义美元不会被误认成公式（详见 `INLINE_MATH_SRC`）。
 */
function tokenizeInline(text: string): Tok[] {
  const out: Tok[] = [];
  const mathRe = new RegExp(INLINE_MATH_SRC, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = mathRe.exec(text)) !== null) {
    const idx = m.index;
    if (idx > last) out.push(...tokenizeEmphasis(text.slice(last, idx)));
    out.push({ t: "math", v: m[0], tex: m[1] ?? "" });
    last = idx + m[0].length;
    // 空匹配防御：正则不允许空匹配，但真出现也不会死循环
    if (m[0].length === 0) mathRe.lastIndex += 1;
  }
  if (last < text.length) out.push(...tokenizeEmphasis(text.slice(last)));
  return out;
}

/** 强调 / 代码 / 链接分词（公式已在上一步切走，这里不会再遇到 `$…$`） */
function tokenizeEmphasis(text: string): Tok[] {
  const out: Tok[] = [];
  if (!text) return out;
  for (const m of text.matchAll(emphasisRe())) {
    const idx = m.index ?? 0;
    if (idx > 0) out.push({ t: "text", v: text.slice(0, idx) });
    text = text.slice(idx + m[0].length);
    if (m[1] !== undefined) {
      out.push({ t: "code", v: m[2] ?? "" });
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4] ?? "");
      // 不安全 / 不支持的协议 → 整段按纯文本渲染（不生成 <a>）
      if (href) out.push({ t: "link", label: m[3], href });
      else out.push({ t: "text", v: m[0] });
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push({ t: "strongem", v: m[5] ?? m[6] ?? "" });
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push({ t: "strong", v: m[7] ?? m[8] ?? "" });
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out.push({ t: "em", v: m[9] ?? m[10] ?? "" });
    } else if (m[11] !== undefined) {
      const src = safeImageSrc(m[12] ?? "");
      // 不安全的图片地址 → 整段按纯文本渲染（与链接同口径，绝不生成 <img>）
      if (src) out.push({ t: "image", alt: m[11], src });
      else out.push({ t: "text", v: m[0] });
    } else {
      out.push({ t: "text", v: m[0] });
    }
  }
  if (text) out.push({ t: "text", v: text });
  return out;
}

/**
 * 行内内容的纯文本（与渲染出来的 `textContent` 逐字一致）。
 * M4：公式贡献**含定界符的原文**（`tok.v`），与渲染侧 `renderInline` 推进的长度完全相同 ——
 * 所以批注偏移这把尺子在"有公式"和"没公式"的块上都是同一套算法。
 */
function plainInline(text: string): string {
  let s = "";
  for (const tok of tokenizeInline(text)) {
    if (tok.t === "text" || tok.t === "code") s += tok.v;
    else if (tok.t === "link") s += plainInline(tok.label);
    // 关键：math 用 `v`（`$E=mc^2$` 全长），**不是** `tex`（`E=mc^2`）—— 尺子必须按原文走
    else if (tok.t === "math") s += tok.v;
    // 图片：`<img>` 在 DOM 里**不产生任何文本**，所以这里也必须贡献 0 个字符，
    // 否则"块纯文本 === 块 textContent"这条不变量会在有图的块上被破坏。
    else if (tok.t === "image") s += "";
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
    switch (tok.t) {
      case "text":
        nodes.push(...emitText(tok.v, ctx));
        break;
      case "code":
        nodes.push(
          <code key={`c${ctx.key++}`} className="md-inline-code">
            {emitText(tok.v, ctx)}
          </code>,
        );
        break;
      case "link":
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
        break;
      case "image":
        // ⚠ **不要**给这个元素任何文本子节点：`plainInline()` 把图片算作 0 个字符，
        //    `<img>` 的 textContent 也确实是空的 —— 两边必须继续保持一致（批注偏移尺子）。
        //   `loading="lazy"`：一篇笔记里可能有很多张大图，别一次性全解码。
        nodes.push(
          <img
            key={`i${ctx.key++}`}
            className="md-img"
            src={tok.src}
            alt={tok.alt}
            loading="lazy"
          />,
        );
        break;
      case "strong":
        nodes.push(<strong key={`s${ctx.key++}`}>{renderInline(tok.v, ctx)}</strong>);
        break;
      case "em":
        nodes.push(<em key={`e${ctx.key++}`}>{renderInline(tok.v, ctx)}</em>);
        break;
      case "strongem":
        nodes.push(
          <strong key={`b${ctx.key++}`}>
            <em>{renderInline(tok.v, ctx)}</em>
          </strong>,
        );
        break;
      // M4 · 行内公式：先把**含定界符的原文**推给纯文本游标（尺子），再让 <Math> 命令式画公式。
      // 顺序不能反：`emitText` 会按 `tok.v.length` 推进 `ctx.off`，批注切分依赖这个位置。
      case "math":
        nodes.push(
          <Fragment key={`m${ctx.key++}`}>
            <span className="md-math-src" aria-hidden="true">
              {emitText(tok.v, ctx)}
            </span>
            <MdMath tex={tok.tex} />
          </Fragment>,
        );
        break;
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

/**
 * M4：该块渲染出来的 `[data-block]` 元素上要不要打 `data-block-math="true"`。
 * 判据与 `blockHasInlineMath()` **同源同序**：都走 `blockInlineTexts()` + `mathSpansIn()`，
 * 所以"导出的探测结果"与"DOM 上的标记"不可能互相打架。
 * 块级公式也打这个标记（它同样是"这个块里有公式"的诚实提示）。
 */
function blockHasInlineMathAt(b: Block): boolean {
  if (b.kind === "math") return true;
  return mathSpansIn(blockInlineTexts(b)).length > 0;
}

function renderBlock(
  b: Block,
  index: number,
  marks: MdMark[],
  terms: string[],
  onMarkClick?: (id: number) => void,
): ReactElement {
  const ctx: RenderCtx = { off: 0, marks, terms, onMarkClick, key: 0 };
  const mathFlag = blockHasInlineMathAt(b) ? "true" : undefined;

  switch (b.kind) {
    case "heading": {
      const Tag = (`h${Math.min(6, Math.max(1, b.level))}` as "h1");
      return (
        <Tag className={`md-heading md-h${b.level}`} data-block={index} data-block-math={mathFlag}>
          {renderInline(b.text, ctx)}
        </Tag>
      );
    }
    case "hr":
      return <hr className="md-hr" data-block={index} data-block-math={mathFlag} />;
    case "code":
      return (
        <pre className="md-pre" data-block={index} data-lang={b.lang || undefined} data-block-math={mathFlag}>
          <code>{emitText(b.code, ctx)}</code>
        </pre>
      );
    case "table":
      return (
        <div className="md-table-wrap" data-block={index} data-block-math={mathFlag}>
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
        <div className="md-list-wrap" data-block={index} data-block-math={mathFlag}>
          {renderList(b.items, ctx)}
        </div>
      );
    case "quote":
      return (
        <blockquote className="md-quote" data-block={index} data-block-math={mathFlag}>
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
    // M4 · 块级公式：`<div data-block>` 直接裹 `<Math display />`，不再套 `<p>`。
    // 为什么不套 `<p>`：行内公式那层已经能保证 `data-block` 落在元素自身，
    // 这里直接把 index 给 div，批注选区命中 `[data-block]` 的行为与其他块完全一致。
    case "math":
      return (
        <div className="md-math-block" data-block={index} data-block-math={mathFlag}>
          <MdMath tex={b.tex} display />
        </div>
      );
    case "para":
      return (
        <p className="md-p" data-block={index} data-block-math={mathFlag}>
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
