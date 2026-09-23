// M2 命中高亮：用 `material_search` 返回的 `terms` 高亮材料片段与引用来源里的命中词。
//
// 契约：`docs/05-M2契约.md` §4.2
//   ⚠ 必须安全渲染：材料正文与用户查询都可能含 HTML 字符，因此
//      **禁止** `dangerouslySetInnerHTML`、**禁止**拼接 HTML 字符串 ——
//      这里只把文本切成"命中 / 未命中"分段数组，用 React 元素渲染（命中段套 `<mark>`）。
//
// 降级：`terms` 缺失 / 为空 / 文本为空 / 旧数据 → 原样渲染，不抛错（预览模式与桌面模式通用）。

import type { ReactElement } from "react";

/** 规整词表：去首尾空白、丢空词、大小写不敏感去重（保序），长词在前（避免短词先吃掉长词） */
export function normalizeTerms(terms?: readonly string[] | null): string[] {
  if (!terms || terms.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const w = typeof t === "string" ? t.trim() : "";
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** 文本分段：`hit=true` 的段要套 `<mark>` */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把文本按命中词切成段数组（不生成任何 HTML 字符串） */
export function splitByTerms(text: string, terms: readonly string[]): HighlightSegment[] {
  if (!text) return [];
  if (terms.length === 0) return [{ text, hit: false }];

  const re = new RegExp(terms.map(escapeRegExp).join("|"), "gi");
  const out: HighlightSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx), hit: false });
    out.push({ text: m[0], hit: true });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

export interface HighlightProps {
  text: string;
  /** `material_search` 返回的本轮查询词；缺失/为空时退化为不高亮 */
  terms?: readonly string[] | null;
  className?: string;
}

/** 安全高亮组件：命中词用 `<mark class="hl-mark">` 包裹，其余原样渲染 */
export default function Highlight({ text, terms, className }: HighlightProps): ReactElement {
  const segs = splitByTerms(text, normalizeTerms(terms));
  return (
    <span className={className}>
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="hl-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}
