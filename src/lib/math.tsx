// M4 · 数学公式渲染：LaTeX（KaTeX）行内 / 块级渲染。
//
// 契约：本文件是 `lib/markdown.tsx` 的**从属件** —— 它只负责"把一段 TeX 画成 DOM"，
//   "$…$" / "$$…$$" 的**识别与切分**（语法规则）一律在 `lib/markdown.tsx` 里，
//   因为块的划分与纯文本游标都在那边，两侧必须用同一把尺子（见 markdown.tsx 头部注释）。
//
// 安全红线（继承 `lib/markdown.tsx` §头）：
//   **禁止** `dangerouslySetInnerHTML`、**禁止**拼接 HTML 字符串。
//   因此这里**刻意不用** KaTeX 的 `renderToString()`（它返回 HTML 字符串，只能靠
//   innerHTML 塞进页面），而是用命令式 API `katex.render(tex, domElement, options)`
//   —— 它直接在真实 DOM 上建节点，全程不经过任何 HTML 字符串。
//
// 诚实降级：
//   · `throwOnError: false` —— 语法错误的公式不抛异常、不白屏，KaTeX 自己会把原始 TeX
//     包成 `.katex-error`（红色）显示出来，这正是本项目"宁可显示原文也不崩"的口径；
//   · 拿不到 ref（理论上不该发生）→ 直接跳过，什么都不做，绝不抛。

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
// KaTeX 的排版样式与字体（fonts/*）。**只在这里 import 一次**：整个应用只有本文件依赖 katex，
// 谁先用到 <Math> 谁就把这份 CSS 带进产物，不会重复引入。
import "katex/dist/katex.min.css";
// @ts-expect-error TS7016 —— katex@0.16.11 的 npm 包里没有 `.d.ts`，仓库也没装 `@types/katex`。
// 本次约束①"不许再装任何东西"、②"只许改 markdown.tsx / math.tsx 两个文件"，
// 因此不能靠 `npm i -D @types/katex`、也不能新增 `src/lib/katex.d.ts` 环境声明来补类型。
// 这里就地点名抑制这一行的 TS7016，紧接着用下面的 `KatexRender` 把它**收窄成有类型的用法**：
// 只有 `render(tex, el, opts)` 一处被使用，其余 API（尤其是 `renderToString`，见文件头红线）拿不到。
// 用 `@ts-expect-error` 而非 `@ts-ignore` 是有意的：将来一旦补上类型声明，
// 这行会立刻报"未使用的 expect-error"，逼着后续维护者把抑制删掉，而不是留一句永久静默的 ignore。
import * as katexMod from "katex";

// ---------------------------------------------------------------------------
// KaTeX 的最小类型声明与载入
// ---------------------------------------------------------------------------
//
// 现实约束（诚实记录，别当成笔误）：
//   · katex@0.16.11 的 npm 包里**没有** `.d.ts`；
//   · 仓库**没有装** `@types/katex`，而本次任务的硬约束是"不许再装任何东西"；
//   · 本次只允许改 `markdown.tsx` / `math.tsx` **两个文件**，所以也不能新增
//     `src/lib/katex.d.ts` 那种"环境声明文件"来补类型；
//   · 在 `.tsx`（模块文件）里写 `declare module "katex" { … }` 也不行 —— TS 会报
//     TS2665「Invalid module name in augmentation…cannot be augmented」，
//     因为 `katex` 解析到的是**无类型模块**，只能被"环境声明"覆盖，不能被"模块增强"补。
//
// 于是走命名空间导入 + **就地收窄**：把 `render` 一个成员按 KaTeX 官方文档的形状
// 声明出来，其余成员一概不要。这样既不新增文件，也不留下 `any` 满天飞。

interface KatexOptions {
  /** 行内（false，默认）还是独立公式块（true） */
  displayMode?: boolean;
  /** 公式语法错误时：true 抛异常，false 把原文以 `.katex-error` 红色回显（本项目取 false） */
  throwOnError?: boolean;
  /** 错误回显的颜色 */
  errorColor?: string;
  /** `\htmlId` / `\htmlClass` 之类命令的输出限制；`false` 表示放宽 */
  strict?: boolean | string | ((errorCode: string, errorMsg: string) => string | boolean);
}

/**
 * 命令式渲染：把 `tex` 画进 `element`，**直接建真实 DOM 节点**，不返回 HTML 字符串。
 * 这是本文件唯一用到的 KaTeX 能力（`renderToString()` 会返回 HTML 字符串 —— 违反安全红线，禁用）。
 */
type KatexRender = (tex: string, element: HTMLElement, options?: KatexOptions) => void;

/**
 * 取出 `render`。用鸭子类型判断而不是断言"一定是函数"：
 * 万一 KaTeX 的产物形状变了（或被打包器换成了 CJS 命名空间），
 * 这里返回 null，组件降级成"原样显示 TeX 源码"，而不是整个应用崩掉。
 */
function resolveKatexRender(): KatexRender | null {
  const mod = katexMod as unknown as { render?: unknown; default?: { render?: unknown } };
  const fn = typeof mod.render === "function" ? mod.render : mod.default?.render;
  return typeof fn === "function" ? (fn as KatexRender) : null;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface MathProps {
  /** 公式源码（**不含** `$` 定界符：调用方已剥掉） */
  tex: string;
  /** true = 独立公式块（display mode），false/缺省 = 行内公式 */
  display?: boolean;
  /** 额外类名（默认给 `md-math`） */
  className?: string;
}

/**
 * `<Math tex="$…$" />` 的渲染件。
 *
 * 实现要点（别改，改了就会和 React 抢 DOM）：
 *   · 元素由 React **建成空的**（`<span ref={ref} />`，不传 children）；
 *   · 公式内容全部由 `useEffect` 里的 `katex.render()` 命令式写入；
 *   · `tex` / `display` 变化时**先清空再重画**，反复渲染不会累积旧节点。
 */
export default function Math({ tex, display, className }: MathProps): ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    // 拿不到 ref（元素还没挂上 / 已被卸载）→ 本次什么都不做；清空动作留给下一次 render 或卸载
    if (!el) return;

    // 安全：React 绝不能往这个元素里写 children，否则两边的 DOM 会互相覆盖。
    // 拿不到 children 属性就认为没问题（JSX 不传 children 时该 key 通常不存在）。
    const kids = (el as unknown as { props?: { children?: ReactNode } }).props?.children;
    if (kids !== undefined && kids !== null && kids !== false) {
      console.error("[md-math] <Math> 的元素被写入了 children，React 与 KaTeX 会互相覆盖 DOM。");
      return;
    }

    // 先清空：同一元素换公式（或从行内换块级）时不留残渣
    el.textContent = "";
    const render = resolveKatexRender();
    if (!render) {
      // KaTeX 产物形状不符预期（打包器换了模块形状等）→ 原样显示 TeX 源码，绝不抛
      console.warn("[md-math] 取不到 KaTeX 的 render()，已退化为显示公式源码。");
      el.textContent = tex;
      return;
    }
    try {
      render(tex, el, {
        displayMode: display === true,
        // 语法错误不抛异常 → KaTeX 自己用红色回显原始 TeX（诚实降级，不让整页崩）
        throwOnError: false,
      });
    } catch (err) {
      // 兜底：`throwOnError:false` 后基本不会走到这里；真走到了也只退化成纯文本，绝不冒泡炸掉渲染
      el.textContent = tex;
      console.warn("[md-math] KaTeX 渲染失败，已退化为纯文本：", err);
    }
    // 卸载时清干净（React 会移除元素本身，这里主要是让 DOM 立刻不再挂着公式节点）
    return () => {
      if (ref.current) ref.current.textContent = "";
    };
  }, [tex, display]);

  return <span ref={ref} className={className ?? "md-math"} data-tex={tex} />;
}

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

// `.md-math-src` 是 `markdown.tsx` 渲染行内公式时推**纯文本游标**用的"原文占位"
// （里面就是 `$E=mc^2$` 这段源码，长度必须真实存在，批注偏移才对得上）。
// 它是给"尺子"用的，不是给人看的 —— 公式本身已经由 <Math> 画在旁边了，
// 留着就会在屏幕上重复出现一遍 `$…$`。所以这里把它**收起来**：
//   · `display:none`：不参与排版、不占宽度，也不会出现"源码 + 公式"两遍；
//   · 元素仍在 DOM 里，`textContent` 照样包含这段原文（尺子成立）；
//   · 再叠一层 `aria-hidden`（由 markdown.tsx 写在元素上），屏幕阅读器也不会念两遍。
// 诚实记录：正因为公式在 DOM 里既有"原文占位"又有"KaTeX 真字符"，
// 含公式的块其 `textContent` 一定**长于** `blockPlainTexts()` —— 这是已知局限，
// 用 `hasInlineMath()` / `blockHasInlineMath()` 可提前探测（详见 markdown.tsx 文件头）。
const MATH_STYLE_ID = "md-math-style";
if (typeof document !== "undefined" && !document.getElementById(MATH_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = MATH_STYLE_ID;
  style.textContent =
    ".md-math-src{display:none}" +
    ".md-math-block{margin:.6em 0;text-align:center;overflow-x:auto;overflow-y:hidden}";
  document.head.appendChild(style);
}
