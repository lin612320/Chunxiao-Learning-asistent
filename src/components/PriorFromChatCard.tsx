// R1 · 「从本课对话提炼先验知识」卡片
//
// 流程（契约 §3.4 / §一）：本机问答记录 → 素材（24000 字预算，从最新往前）
//   → 模型产出严格 JSON 数组（两级树）→ **可勾选 / 可编辑预览** → 用户点「确认入库」才写库。
//
// 口径红线（逐条对应契约 §一）：
//   · 未配 Key → 按钮禁用并引导去「数据设置」，**不用模板冒充 AI 生成**；
//   · 无问答记录 → 如实提示，**不生成、不造数据**；
//   · 截断 → 界面写明本次用了多少条、共多少条、有没有截断（未截断就明说未截断）；
//   · 素材含【春晓】自己的 AI 回答 → 提示词里显式声明「未经核实」，入库标注「从对话提炼 · 待核对」
//     且置信度 0.4（低于 M2 纯生成的 0.5，已拍板口径）；
//   · 浏览器预览模式读不到本机问答记录 → 如实提示，不假造素材、不假装提炼成功；
//   · 渲染一律用 React 元素（不拼 HTML 字符串、不用 dangerouslySetInnerHTML）。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { invokeStrict, isTauri } from "../lib/tauri";
import { useSettings } from "../hooks/useSettings";
import Icon from "./Icon";
import {
  buildPriorAddTreeItems,
  buildPriorFromChatMaterial,
  describeChatMaterial,
  describeReparentedWarning,
  describeSkippedWarning,
  generatePriorFromChat,
  normalizeChatCourseMessages,
  orderPriorFromChatRows,
  PRIOR_FROM_CHAT_CHANGED,
  PRIOR_FROM_CHAT_CONFIDENCE,
  PRIOR_FROM_CHAT_FETCH_LIMIT,
  PRIOR_FROM_CHAT_SOURCE,
  PRIOR_FROM_CHAT_SOURCE_REF,
  withSourceCounts,
  type ChatMaterialStats,
  type PriorFromChatRow,
} from "../lib/priorfromchat";
import "./PriorFromChat.css";

export interface PriorFromChatCardProps {
  courseId: number;
  courseName: string;
}

/**
 * 把警告句子按 `strong` 切一刀，只加粗强调片段。
 * 全程是 React 文本节点（不拼 HTML 字符串、不用 dangerouslySetInnerHTML）。
 */
function WarningText({ text, strong }: { text: string; strong: string }) {
  const i = text.indexOf(strong);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b>{strong}</b>
      {text.slice(i + strong.length)}
    </>
  );
}

export default function PriorFromChatCard({ courseId, courseName }: PriorFromChatCardProps) {
  const { s, hasKey } = useSettings();

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noRecords, setNoRecords] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [stats, setStats] = useState<ChatMaterialStats | null>(null);
  const [rows, setRows] = useState<PriorFromChatRow[] | null>(null);
  const [committing, setCommitting] = useState(false);

  const ready = Number.isFinite(courseId) && courseId > 0;
  const previewMode = !isTauri();
  const chatHref = `/assistant?course=${courseId}`;

  // -------------------------------------------------------------------------
  // 读取本机问答记录 → 构建素材 → 请模型提炼（**不写库**）
  // -------------------------------------------------------------------------

  async function handleExtract() {
    if (!ready) {
      setErr("课程 id 不合法，无法读取本课问答记录。");
      return;
    }
    if (!hasKey) {
      setErr("尚未配置 API Key：请先到「数据设置」配置后再提炼（不会用模板假造一份知识骨架）。");
      return;
    }
    if (previewMode) {
      setErr("预览模式下无法读取本机问答记录：该功能只在桌面版可用（不会假造素材，也不会假装提炼成功）。");
      return;
    }

    setBusy(true);
    setErr(null);
    setNotice(null);
    setNoRecords(false);
    setRows(null);
    setRaw(null);
    setStats(null);
    setMsg("正在读取本机问答记录…");
    try {
      const res = normalizeChatCourseMessages(
        await invokeStrict<unknown>("chat_course_messages", {
          courseId,
          limit: PRIOR_FROM_CHAT_FETCH_LIMIT,
        }),
      );

      if (res.messages.length === 0) {
        setMsg(null);
        setNoRecords(true);
        setErr(
          res.session_count > 0
            ? `这门课还没有问答记录，先去对话页问几个问题（本机读到 ${res.session_count} 个对话，但其中没有可选的消息：只有系统消息或空内容）——春晓不会凭空生成，也不会用模板冒充 AI 提炼结果。`
            : "这门课还没有问答记录，先去对话页问几个问题——春晓不会凭空生成，也不会用模板冒充 AI 提炼结果。",
        );
        return;
      }

      const material = withSourceCounts(buildPriorFromChatMaterial(res.messages), res);
      setStats(material.stats);
      setMsg(
        `已读到本机问答记录，正在请模型提炼…（本次素材 ${material.stats.usedCount} 条 / 约 ${material.stats.usedChars} 字）`,
      );

      const r = await generatePriorFromChat(s.ai, {
        courseName,
        material,
        onProgress: (n) => setMsg(`正在请模型提炼…已收到 ${n} 字`),
      });
      setRaw(r.raw.trim() ? r.raw : null);
      if (!r.ok) {
        setMsg(null);
        setErr(`AI 提炼失败：${r.error}`);
        return;
      }
      setRows(r.items.map((it, i) => ({ ...it, key: `c${i}`, checked: true })));
      setMsg(
        `已提炼出 ${r.items.length} 条：请逐条核对（名称 / 说明 / 详情都能改，可取消勾选）后点「确认保存」——不点确认就不会存下来。`,
      );
    } catch (e) {
      setMsg(null);
      setErr(`读取本机问答记录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // 预览：勾选 / 编辑
  // -------------------------------------------------------------------------

  function patchRow(key: string, patch: Partial<PriorFromChatRow>) {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev));
  }

  /** 勾子项 → 自动勾上它所属的顶层章节（契约 §3.4：父子联动） */
  function toggleRow(key: string, checked: boolean) {
    setRows((prev) => {
      if (!prev) return prev;
      const self = prev.find((r) => r.key === key);
      if (!self) return prev;
      return prev.map((r) => {
        if (r.key === key) return { ...r, checked };
        const isParent = !r.parent_topic && !!self.parent_topic && r.topic === self.parent_topic;
        if (checked && isParent) return { ...r, checked: true };
        return r;
      });
    });
  }

  // -------------------------------------------------------------------------
  // 确认入库（整批一次 IPC；失败整批回滚，预览保留可重试）
  // -------------------------------------------------------------------------

  async function handleCommit() {
    // 用渲染期算好的同一份结果（预览里的警告就是按它显示的，两处口径必然一致）
    const built = tree;
    if (!rows || !built) return;
    if (built.items.length === 0) {
      setErr("没有勾选任何有效条目（知识点名称不能为空），未写入任何内容。");
      return;
    }
    setCommitting(true);
    setErr(null);
    setNotice(null);
    try {
      const ids = await invokeStrict<number[]>("prior_add_tree", {
        courseId,
        // items 的元素字段与 PriorDraft 逐字一致（snake_case，零字段转换）
        items: built.items,
        source: PRIOR_FROM_CHAT_SOURCE,
        sourceRef: PRIOR_FROM_CHAT_SOURCE_REF,
        confidence: PRIOR_FROM_CHAT_CONFIDENCE,
      });
      const added = Array.isArray(ids) ? ids.length : built.items.length;
      setRows(null);
      setRaw(null);
      setMsg(null);
      setNoRecords(false);
      setNotice(
        `已写入 ${added} 条，标记为『${PRIOR_FROM_CHAT_SOURCE_REF}』，请逐条核对。` +
          (built.reparented.length > 0
            ? ` 其中 ${built.reparented.length} 条的子项所属章节没被勾选或名称已被改，已作为顶层条目写入。`
            : "") +
          (built.skipped > 0 ? ` 另有 ${built.skipped} 条因为知识点名称为空被跳过。` : "") +
          " 只追加，未删除既有条目。",
      );
      try {
        window.dispatchEvent(
          new CustomEvent(PRIOR_FROM_CHAT_CHANGED, { detail: { courseId, count: added } }),
        );
      } catch {
        /* 该事件只是给宿主页（Course.tsx）的可选刷新钩子，广播失败不影响入库结果 */
      }
    } catch (e) {
      setErr(
        `保存失败：${e instanceof Error ? e.message : String(e)}（这一批是整体一起写的：本机报错时不会只存一半；没存进去的条目仍在预览里，可以重试）`,
      );
    } finally {
      setCommitting(false);
    }
  }

  function cancelDrafts() {
    setRows(null);
    setRaw(null);
    setMsg(null);
  }

  const ordered = rows ? orderPriorFromChatRows(rows) : [];
  const selectedCount = rows ? rows.filter((r) => r.checked).length : 0;

  /**
   * 入库映射**在渲染期**就算一遍：让用户在点「确认入库」**之前**看到
   * 「哪些子项会因为所属章节没勾选 / 名称被改而变成顶层」——而不是入库之后才被告知。
   * 复用与入库同一个 `buildPriorAddTreeItems`（不另写一套口径），
   * 开销 O(条数)，条数上限 `PRIOR_MAX_ITEMS = 40`，且只在 `rows` 变化时重算。
   */
  const tree = useMemo(() => (rows ? buildPriorAddTreeItems(rows) : null), [rows]);

  // 入库前的「结构会变化」警告文案（与上面同一份结果，先于点击就显示）
  const reparentWarn = useMemo(() => describeReparentedWarning(tree?.reparented ?? []), [tree]);
  const skipWarn = useMemo(() => describeSkippedWarning(tree?.skipped ?? 0), [tree]);

  return (
    <section className="card prior-chat-card">
      <div className="prior-chat-head">
        <h3>从本课对话提炼先验知识</h3>
        <span className="src-badge src-ai">{PRIOR_FROM_CHAT_SOURCE_REF}</span>
      </div>

      <p className="muted prior-chat-note">
        从《{courseName}》的问答记录里提炼一份两层清单（章节 + 知识点）。生成结果
        <b>不会自动保存</b>，要你逐条勾选 / 修改后点「确认保存」才会存下来。素材里含【春晓】自己的回答，
        那些同样是 AI 生成的、<b>未经核实</b>，保存后会标注「{PRIOR_FROM_CHAT_SOURCE_REF}」。
      </p>

      <div className="prior-chat-bar">
        <button
          className="primary small"
          disabled={!hasKey || !ready || busy || committing}
          title={
            !ready
              ? "课程编号不对，无法读取这门的问答记录"
              : hasKey
                ? "读取本课的问答记录并请模型提炼成知识骨架；生成后需要你勾选确认才会保存"
                : "还没填模型 Key，没法让模型提炼"
          }
          onClick={() => void handleExtract()}
        >
          {busy ? (
            "提炼中…"
          ) : (
            <>
              <Icon name="sparkles" />
              从本课对话提炼先验知识
            </>
          )}
        </button>
        <span className="muted prior-chat-tip">
          {hasKey
            ? "只发送这门课的问答记录，不发送材料全文。"
            : "还没填模型 Key，暂时不能提炼（我们不会用模板假造一份冒充 AI 提炼的结果）。"}
        </span>
        {!hasKey && (
          <Link to="/settings" className="ghost-btn" style={{ textDecoration: "none" }}>
            去「数据设置」配置 →
          </Link>
        )}
      </div>

      {previewMode && (
        <p className="prior-chat-warn">
          当前是浏览器预览模式：读不到本机的问答记录（这个功能只在桌面版可用）。
          这里不会假造素材，也不会假装提炼成功。
        </p>
      )}

      {msg && <div className="prior-chat-msg">{msg}</div>}
      {stats && <div className="prior-chat-stats">{describeChatMaterial(stats)}</div>}

      {err && (
        <div className="settings-msg err" onClick={() => setErr(null)}>
          {err}
        </div>
      )}
      {noRecords && (
        <p className="prior-chat-links">
          <Link to={chatHref} className="ghost-btn" style={{ textDecoration: "none" }}>
            去本课对话页提问 →
          </Link>
        </p>
      )}
      {notice && (
        <div className="settings-msg ok" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {raw && (
        <details className="prior-raw">
          <summary>查看模型原始输出（AI 提炼、未核对；解析失败时用来排障）</summary>
          <pre>{raw}</pre>
        </details>
      )}

      {rows && (
        <div className="prior-drafts">
          <div className="prior-drafts-head">
            <b>提炼结果预览（还没保存）</b>
            <span className="src-badge src-ai">{PRIOR_FROM_CHAT_SOURCE_REF}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              共 {rows.length} 条 · 已选 {selectedCount} 条
            </span>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
            名称 / 一句话说明 / 详情都可以直接改；勾选子项会自动勾上它所属的章节。保存只会<b>往后加</b>
            ，不会删掉已有的条目；没勾选的不会存下来。
          </p>
          <ul className="prior-draft-list">
            {ordered.map(({ row, depth, parentMissing }) => (
              <li
                key={row.key}
                className={"prior-draft-item" + (depth > 0 ? " child" : "") + (row.checked ? "" : " off")}
              >
                <label className="prior-draft-check">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    onChange={(e) => toggleRow(row.key, e.target.checked)}
                  />
                </label>
                <div className="prior-draft-body">
                  <div className="prior-draft-head">
                    <span className="tag">{depth > 0 ? "子项" : "章节"}</span>
                    {depth > 0 && row.parent_topic && (
                      <span className="tag">所属：{row.parent_topic}</span>
                    )}
                    {parentMissing && (
                      <span className="tag tag-warn">所属章节未勾选 → 会作为顶层章节保存</span>
                    )}
                  </div>
                  <input
                    className="prior-draft-input"
                    value={row.topic}
                    placeholder="知识点名称（必填）"
                    onChange={(e) => patchRow(row.key, { topic: e.target.value })}
                  />
                  <textarea
                    className="prior-draft-input"
                    rows={2}
                    value={row.summary}
                    placeholder="一句话说明"
                    onChange={(e) => patchRow(row.key, { summary: e.target.value })}
                  />
                  <textarea
                    className="prior-draft-input"
                    rows={3}
                    value={row.detail}
                    placeholder="详情（可留空）"
                    onChange={(e) => patchRow(row.key, { detail: e.target.value })}
                  />
                </div>
              </li>
            ))}
          </ul>
          {/* 事前知情：点「确认入库」**之前**就说明结构会怎么变（不静默改变用户看到的内容） */}
          {reparentWarn && (
            <div className="prior-chat-warn">
              <WarningText text={reparentWarn.text} strong={reparentWarn.strong} />
            </div>
          )}
          {skipWarn && (
            <div className="prior-chat-warn">
              <WarningText text={skipWarn.text} strong={skipWarn.strong} />
            </div>
          )}
          <div className="prior-gen-actions">
            <button
              className="ghost-btn"
              disabled={committing}
              onClick={() => setRows((prev) => (prev ? prev.map((r) => ({ ...r, checked: true })) : prev))}
            >
              全选
            </button>
            <button
              className="ghost-btn"
              disabled={committing}
              onClick={() => setRows((prev) => (prev ? prev.map((r) => ({ ...r, checked: false })) : prev))}
            >
              全不选
            </button>
            <button
              className="primary small"
              disabled={committing || !tree || tree.items.length === 0}
              onClick={() => void handleCommit()}
            >
              {/* 括号里写**实际会写入**的条数（勾选数里名称为空的会被跳过，见上面的警告） */}
              {committing ? "保存中…" : `确认保存（${tree ? tree.items.length : 0} 条）`}
            </button>
            <button className="ghost-btn" disabled={committing} onClick={cancelDrafts}>
              取消
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              保存后标注：来源「{PRIOR_FROM_CHAT_SOURCE_REF}」· 可信度{" "}
              {Math.round(PRIOR_FROM_CHAT_CONFIDENCE * 100)}% · 待核对。
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
