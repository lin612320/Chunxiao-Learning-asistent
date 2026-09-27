// M3 · 笔记页（契约 `docs/07-M3契约.md` §4.1 / §三）
//
// 四件事：
//   ① 列表：按课程筛选，显示标题 / 日期 / 来源徽标 / 已导出标记；
//   ② 生成：选课程 + 日期 → 收集该课程**当天**的问答记录 → 模型整理成 Markdown
//      → **可编辑预览** → 用户点「保存到笔记」才入库（source = ai_session）；
//      没有当天记录时如实提示，**不用模板冒充 AI 整理**；未配 Key 时按钮禁用并引导去数据设置；
//   ③ 详情：`lib/markdown.tsx` 渲染正文 + 批注层（含契约 §三 的**自愈**：位置对不上就重新定位并
//      标「位置已自动修正」，全文找不到就归入「已失效的批注」，**绝不假装它还在原位**）；
//   ④ 导出三件套：Markdown（浏览器下载）/ .docx（Rust 本机生成）/ PDF（浏览器打印 → 另存为 PDF）。
//
// 只改本文件、`Notes.css`、`lib/notes.ts`、`hooks/useNotes.ts`、`data/sample.ts`；
// 不碰 styles.css 的设计令牌，本页样式全部写在 `Notes.css` 里。

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useCourses } from "../hooks/useCourses";
import { useSettings } from "../hooks/useSettings";
import { useNoteDetail, useNotes } from "../hooks/useNotes";
import { parseCourseParam } from "../lib/courseScope";
import Markdown, { blockHasInlineMath } from "../lib/markdown";
import Highlight, { normalizeTerms } from "../lib/highlight";
import { isTauri } from "../lib/tauri";
import Icon from "../components/Icon";
import {
  ANNOTATION_COLORS,
  COLOR_LABEL,
  PDF_HINT,
  collectDayMessages,
  downloadMarkdown,
  generateNoteMarkdown,
  marksFrom,
  noteExportDocx,
  noteSourceInfo,
  readExportDir,
  rememberExportDir,
  resolveNoteAnnotations,
  safeFileName,
  splitResolved,
  todayStr,
  type NoteRow,
  type ResolvedAnnotation,
} from "../lib/notes";

// ---------------------------------------------------------------------------
// 选区 → 块内偏移（契约 §三：偏移必须是**在该块纯文本内**的字符偏移）
// ---------------------------------------------------------------------------

/** 选区端点所在的 `[data-block]` 元素（渲染时每个块都带这个属性） */
function blockElOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const holder = el?.closest("[data-block]");
  return holder instanceof HTMLElement ? holder : null;
}

/**
 * 块内纯文本偏移。
 * 用 `Range.toString()` 数「从块首到该端点」的文本长度——它能正确跨越 `<strong>` / `<code>` /
 * `<mark>` / `<a>` 等行内标签，也能处理端点落在元素节点（而非文本节点）上的情况；
 * 而 `lib/markdown.tsx` 的 `blockPlainTexts()` 与渲染出来的 `[data-block]` 元素 `textContent`
 * 用的是同一把尺子，所以这里算出的偏移可以直接交给 `<Markdown marks={...} />`。
 */
function offsetInBlock(block: HTMLElement, node: Node, offset: number): number | null {
  if (node !== block && !block.contains(node)) return null;
  try {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch {
    return null;
  }
}

interface SelectionInfo {
  blockIndex: number;
  start: number;
  end: number;
  quote: string;
  /** true = 选区跨了多个块，已退化为「起始块整块」（界面上会如实说明） */
  cross: boolean;
  x: number;
  y: number;
}

interface DraftState {
  title: string;
  content: string;
  /** false = 模型没给一级标题，标题是本地按「课程 + 日期」拼的 */
  titleFromModel: boolean;
  sessionId: number | null;
  messageCount: number;
  sessionCount: number;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function courseNameOf(courses: Array<{ id: number; name: string }>, id: number): string {
  return courses.find((c) => c.id === id)?.name ?? `课程 #${id}`;
}

export default function Notes() {
  const { courses } = useCourses();
  const { s, hasKey } = useSettings();
  /**
   * R6：URL 上的 `?course=N` = **本页被锁定到这门课**（侧栏按课程进入时带的）。
   * 锁定时：不再显示「按课程筛选」（侧栏已经选过课了），列表也只列这门课的笔记。
   */
  const { search } = useLocation();
  const nav = useNavigate();
  const lockedCourseId = parseCourseParam(search);

  // —— 列表 ——
  const [courseFilter, setCourseFilter] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** 生效的课程范围：URL 锁定优先，其次页面内筛选 */
  const scopeCourseId = lockedCourseId ?? courseFilter;
  const { notes, loading, error: listError, setError: setListError, reload, createNote, removeNote } =
    useNotes(scopeCourseId);
  const detail = useNoteDetail(selectedId);

  /**
   * R9：**按天分组**（用户要求「按天整理」）。
   *
   * - 自己写的（`source='user'`）与 AI 从对话整理的（`source='ai_session'`）**混在同一组里**，
   *   靠来源徽标区分 —— 用户要的是"按天看笔记"，不是"按来源分两个列表"；
   * - 日期倒序（最近的在前）；
   * - 没有日期的（老数据 / 手动写且没填日期）归到最后的「未标日期」组，**不猜日期**。
   */
  const notesByDay = useMemo(() => {
    const groups = new Map<string, NoteRow[]>();
    for (const n of notes) {
      const key = n.date && n.date.trim() ? n.date.trim() : "未标日期";
      const bucket = groups.get(key);
      if (bucket) bucket.push(n);
      else groups.set(key, [n]);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === "未标日期") return 1;
      if (b[0] === "未标日期") return -1;
      return b[0].localeCompare(a[0]);
    });
  }, [notes]);

  // —— 提示 ——
  const [notice, setNotice] = useState<string | null>(null);
  const error = listError ?? detail.error;
  const clearError = useCallback(() => {
    setListError(null);
    detail.setError(null);
  }, [detail, setListError]);

  // —— 生成 ——
  const [genCourseId, setGenCourseId] = useState<number | null>(null);
  const [genDate, setGenDate] = useState<string>(todayStr());
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [genRaw, setGenRaw] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  /** 保存后要选中的笔记 id（等列表刷新完再选中，避免被"自动选第一条"抢走） */
  const pendingSelect = useRef<number | null>(null);

  // —— 手动写笔记（R6：用户要求「笔记需要支持随时手动写入」）——
  // ⚠ 不复用"先建一条空笔记"的路子：Rust 侧**标题与正文都不许为空**（诚实口径），
  //   所以这里先打开编辑区，用户写好了再入库 —— 与"生成草稿 → 确认才保存"同一套纪律。
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualErr, setManualErr] = useState<string | null>(null);

  /** 手动写入的归属课程：锁定的课程优先，否则用生成区选的那门，最后兜底第一门未归档课程 */
  const manualCourseId =
    lockedCourseId ?? genCourseId ?? courses.find((c) => !c.archived)?.id ?? courses[0]?.id ?? null;

  async function handleSaveManual() {
    if (manualCourseId == null) {
      setManualErr("请先选一门课程：笔记必须归属到某门课。");
      return;
    }
    const title = manualTitle.trim();
    const content = manualContent.trim();
    if (!title) {
      setManualErr("请填笔记标题。");
      return;
    }
    if (!content) {
      setManualErr("请写点内容再保存（空笔记不落库）。");
      return;
    }
    setManualBusy(true);
    setManualErr(null);
    const id = await createNote({
      courseId: manualCourseId,
      title,
      contentMd: content,
      date: todayStr(),
      source: "user",
    });
    setManualBusy(false);
    if (id != null) {
      pendingSelect.current = id;
      setManualOpen(false);
      setManualTitle("");
      setManualContent("");
      setNotice("已保存这条笔记（来源标「自己写的」）。");
    }
  }

  // —— 导出 / 打印 ——
  const [exportDir, setExportDir] = useState<string>(() => readExportDir());
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [printMsg, setPrintMsg] = useState<string | null>(null);

  // —— 阅读辅助（关键词高亮，不落库）——
  const [termText, setTermText] = useState("");
  const terms = useMemo(() => normalizeTerms(termText.split(/[\s,，、;；]+/)), [termText]);

  // —— 批注：新选中的 / 正在编辑的 ——
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const [annoColor, setAnnoColor] = useState<string>("yellow");
  const [annoComment, setAnnoComment] = useState("");
  const [annoSaving, setAnnoSaving] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editColor, setEditColor] = useState<string>("yellow");
  const [editComment, setEditComment] = useState("");

  // —— 编辑正文 ——
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  // 默认选中第一门未归档课程
  useEffect(() => {
    if (genCourseId != null || courses.length === 0) return;
    const active = courses.find((c) => !c.archived) ?? courses[0];
    setGenCourseId(active.id);
  }, [courses, genCourseId]);

  // 列表变化时保持选中合法；刚保存的笔记优先被选中
  useEffect(() => {
    if (loading) return;
    const want = pendingSelect.current;
    if (want != null) {
      if (notes.some((n) => n.id === want)) {
        pendingSelect.current = null;
        setSelectedId(want);
      }
      return;
    }
    if (notes.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId == null || !notes.some((n) => n.id === selectedId)) setSelectedId(notes[0].id);
  }, [notes, loading, selectedId]);

  // 换笔记时关掉选区面板与编辑器
  useEffect(() => {
    setSel(null);
    setEditId(null);
    setEditing(false);
    setExportMsg(null);
    setPrintMsg(null);
  }, [selectedId]);

  // -------------------------------------------------------------------------
  // 生成（生成 → 可编辑预览 → 保存才入库）
  // -------------------------------------------------------------------------

  async function handleGenerate() {
    if (genCourseId == null) {
      setGenErr("请先选择要整理哪门课的问答记录。");
      return;
    }
    const courseName = courseNameOf(courses, genCourseId);
    setDraft(null);
    setGenRaw(null);
    setGenErr(null);
    setNotice(null);
    setGenBusy(true);
    setGenMsg("正在读取这一天的问答记录…");
    try {
      const day = await collectDayMessages(genCourseId, genDate);
      if (day.messages.length === 0) {
        setGenMsg(null);
        setGenErr(
          day.totalSessions === 0
            ? `${courseName}还没有任何问答记录：先到「问答」页问几个问题，之后再来整理笔记。春晓不会凭空生成笔记。`
            : `${genDate} 这一天没有问答记录${
                day.otherDates.length > 0 ? `（这门课有记录的日期：${day.otherDates.join("、")}）` : ""
              }。请换一个日期，或先去「问答」页聊几句——春晓不会凭空生成笔记。`,
        );
        return;
      }
      setGenMsg(`已读到 ${day.messages.length} 条消息（来自 ${day.sessionCount} 个会话），正在请模型整理…`);
      const r = await generateNoteMarkdown(s.ai, {
        courseName,
        date: genDate,
        messages: day.messages,
        onProgress: (n) => setGenMsg(`正在整理…已收到 ${n} 字`),
      });
      setGenRaw(r.raw.trim() ? r.raw : null);
      if (!r.ok) {
        setGenMsg(null);
        setGenErr(`AI 整理失败：${r.error}`);
        return;
      }
      const ids = Array.from(new Set(day.messages.map((m) => m.session_id)));
      setDraft({
        title: r.title,
        content: r.content,
        titleFromModel: r.titleFromModel,
        sessionId: ids.length === 1 ? ids[0] : null,
        messageCount: day.messages.length,
        sessionCount: day.sessionCount,
      });
      setGenMsg(`已生成草稿（${r.content.length} 字）：请核对后点「保存到笔记」——不点保存就只是草稿。`);
    } catch (e) {
      setGenMsg(null);
      setGenErr(`读取问答记录失败：${errText(e)}`);
    } finally {
      setGenBusy(false);
    }
  }

  async function handleSaveDraft() {
    if (!draft || genCourseId == null) return;
    setSavingDraft(true);
    const id = await createNote({
      courseId: genCourseId,
      sessionId: draft.sessionId,
      title: draft.title,
      contentMd: draft.content,
      date: genDate,
      source: "ai_session",
    });
    setSavingDraft(false);
    if (id != null) {
      pendingSelect.current = id;
      setDraft(null);
      setGenRaw(null);
      setGenMsg(null);
      setCourseFilter(genCourseId);
      setSelectedId(id);
      setNotice(
        "已保存为笔记（来源「AI 整理 · 待核对」）：请对照课堂与材料逐条核对后再当依据用，标「待确认」的地方尤其需要确认。",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 批注
  // -------------------------------------------------------------------------

  const resolved = useMemo(
    () => (detail.note ? resolveNoteAnnotations(detail.note.content_md, detail.annotations) : []),
    [detail.note, detail.annotations],
  );
  const { placed, invalid } = useMemo(() => splitResolved(resolved), [resolved]);
  const marks = useMemo(() => marksFrom(placed), [placed]);
  const healedCount = placed.filter((r) => r.healed).length;

  const handleDocMouseUp = useCallback((_ev: ReactMouseEvent<HTMLDivElement>) => {
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSel(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const startEl = blockElOf(range.startContainer);
    const endEl = blockElOf(range.endContainer);
    if (!startEl) {
      setSel(null);
      return;
    }
    const blockIndex = Number(startEl.dataset.block);
    if (!Number.isFinite(blockIndex)) {
      setSel(null);
      return;
    }

    const blockText = startEl.textContent ?? "";
    let start: number;
    let end: number;
    // 跨块（或端点落在别的块）时无法用「单块内连续区间」表达 → 退化为起始块整块，
    // 并在面板上如实说明（契约只允许一个 blockIndex + 一对块内偏移）。
    const cross = endEl !== startEl;
    if (!cross) {
      const sOff = offsetInBlock(startEl, range.startContainer, range.startOffset);
      const eOff = offsetInBlock(startEl, range.endContainer, range.endOffset);
      if (sOff == null || eOff == null || eOff <= sOff) {
        setSel(null);
        return;
      }
      start = sOff;
      end = eOff;
    } else {
      start = 0;
      end = blockText.length;
    }

    const quote = blockText.slice(start, end);
    if (!quote.trim()) {
      setSel(null);
      return;
    }

    // R12：**含行内公式的块不建新批注**。
    // 公式在 DOM 里既有原文占位（`.md-math-src`）又有 KaTeX 画出来的真字符，于是
    // `Range.toString()` 数出来的长度比 `blockPlainTexts()` 长（详见 `docs/23` §五）。
    // 与其存一条**位置注定错**的批注（用户看到的高亮会偏），不如如实说一句不建。
    // 已有批注不受影响：它们仍然按「原文片段」自动校验与修正，找不回的进「已失效的批注」。
    if (blockHasInlineMath(detail.note?.content_md ?? "")[blockIndex]) {
      setSel(null);
      setNotice(
        "这一段里有公式：公式在页面上的字符数与纯文本长度对不上，所以**这一段暂不支持新建批注**。已有的批注仍会按原文片段自动校验与修正。",
      );
      return;
    }

    const rect = range.getBoundingClientRect();
    const halfW = 175;
    const x = Math.min(Math.max(rect.left + rect.width / 2, halfW + 8), Math.max(halfW + 8, window.innerWidth - halfW - 8));
    const y = Math.min(rect.bottom + 8, Math.max(120, window.innerHeight - 240));
    setSel({ blockIndex, start, end, quote, cross, x, y });
    setAnnoColor("yellow");
    setAnnoComment("");
  }, [detail.note]);

  async function handleAddAnnotation() {
    if (!sel) return;
    setAnnoSaving(true);
    const ok = await detail.addAnnotation({
      blockIndex: sel.blockIndex,
      quote: sel.quote,
      startOff: sel.start,
      endOff: sel.end,
      color: annoColor,
      comment: annoComment.trim() ? annoComment.trim() : null,
    });
    setAnnoSaving(false);
    if (ok) {
      const { blockIndex, start, end, cross } = sel;
      setSel(null);
      window.getSelection()?.removeAllRanges();
      setNotice(
        `批注已保存：锚点 = 第 ${blockIndex} 块 · 第 ${start}–${end} 字${
          cross ? "（你选中的文字跨了多个块，已按起始块整块记录）" : ""
        }。正文改动后锚点会按原文片段自动校验并修正。`,
      );
    }
  }

  function startEditAnno(id: number) {
    const row = placed.find((r) => r.row.id === id) ?? invalid.find((r) => r.row.id === id);
    if (!row) return;
    setEditId(id);
    setEditColor(row.row.color ?? "yellow");
    setEditComment(row.row.comment ?? "");
    // 点正文里的高亮时，编辑器在下方批注列表里 —— 滚过去，否则用户看不到反馈
    window.setTimeout(() => {
      document.getElementById(`notes-anno-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
  }

  async function handleSaveAnnoEdit() {
    if (editId == null) return;
    const ok = await detail.editAnnotation(editId, {
      color: editColor,
      comment: editComment.trim() ? editComment.trim() : "",
    });
    if (ok) {
      setEditId(null);
      setNotice("批注已更新（锚点不变：改位置等于重新划一次）。");
    }
  }

  async function handleDeleteAnno(id: number) {
    const ok = await detail.removeAnnotation(id);
    if (ok) {
      setEditId(null);
      setNotice("批注已删除。");
    }
  }

  // -------------------------------------------------------------------------
  // 笔记编辑 / 删除
  // -------------------------------------------------------------------------

  function startEditNote() {
    const n = detail.note;
    if (!n) return;
    setEditTitle(n.title);
    setEditContent(n.content_md);
    setEditing(true);
  }

  async function handleSaveNoteEdit() {
    const ok = await detail.updateNote({ title: editTitle, contentMd: editContent });
    if (ok) {
      setEditing(false);
      setNotice(
        "笔记已更新。正文改动后，旧批注会按「原文片段」重新校验位置：能找回的自动修正，找不回的归入「已失效的批注」。",
      );
    }
  }

  async function handleDeleteNote(n: NoteRow) {
    if (
      !window.confirm(
        `确定删除笔记「${n.title}」吗？\n它的批注会一起删除；已经导出到磁盘的文件不会被删除。`,
      )
    ) {
      return;
    }
    const ok = await removeNote(n.id);
    if (ok) setNotice(`已删除笔记「${n.title}」。`);
  }

  // -------------------------------------------------------------------------
  // 导出三件套
  // -------------------------------------------------------------------------

  function handleExportMd() {
    const n = detail.note;
    if (!n) return;
    const name = safeFileName(n.title);
    downloadMarkdown(name, n.content_md);
    setExportMsg({
      type: "ok",
      text: `已下载 ${name}.md（浏览器直接下载，不经过本机数据）。`,
    });
  }

  async function handleExportDocx() {
    const n = detail.note;
    if (!n) return;
    setExporting(true);
    setExportMsg(null);
    const dir = exportDir.trim();
    try {
      const path = await noteExportDocx(n.id, dir);
      rememberExportDir(dir);
      setExportMsg({ type: "ok", text: `已导出 Word：${path}` });
      await detail.reload();
      await reload();
    } catch (e) {
      const raw = errText(e);
      setExportMsg({
        type: "err",
        text: dir
          ? `导出 Word 失败：${raw}（.docx 由本机 Rust 生成，需要这个目录存在且可写）`
          : `导出 Word 失败：${raw} .docx 需要先指定一个导出目录——请在上面「Word 导出目录」里填一个本机文件夹（例如 D:\\课程\\笔记），再点一次导出。`,
      });
    } finally {
      setExporting(false);
    }
  }

  /**
   * PDF：用浏览器打印 → 另存为 PDF。
   * 打印前给 `<body>` 挂 `notes-printing`，`Notes.css` 里的打印样式据此**只输出正文区**，
   * 避免把侧栏、列表、批注面板一起打进 PDF。
   */
  function handlePrint() {
    setPrintMsg(`${PDF_HINT}：浏览器打印对话框里把目标选成「另存为 PDF」即可；打印样式只输出下面这页正文。`);
    document.body.classList.add("notes-printing");
    const cleanup = () => {
      document.body.classList.remove("notes-printing");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.setTimeout(() => window.print(), 50);
    // 兜底：个别环境不派发 afterprint，避免类名一直挂着
    window.setTimeout(cleanup, 120_000);
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  const src = detail.note ? noteSourceInfo(detail.note.source) : null;

  function renderAnnoActions(r: ResolvedAnnotation) {
    const isEditing = editId === r.row.id;
    if (!isEditing) {
      return (
        <div className="notes-anno-meta">
          {r.healed ? (
            <span className="tag tag-warn">位置已自动修正</span>
          ) : (
            <span className="tag">
              锚点：第 {r.blockIndex} 块 · 第 {r.start}–{r.end} 字
            </span>
          )}
          <button className="ghost-btn" onClick={() => startEditAnno(r.row.id)}>
            改颜色 / 备注
          </button>
          <button className="danger-btn" disabled={detail.busy} onClick={() => void handleDeleteAnno(r.row.id)}>
            删除
          </button>
        </div>
      );
    }
    return (
      <div className="notes-anno-editor">
        <div className="notes-color-row">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`notes-color-btn color-${c}${editColor === c ? " active" : ""}`}
              title={COLOR_LABEL[c]}
              onClick={() => setEditColor(c)}
            />
          ))}
        </div>
        <textarea
          className="notes-textarea"
          rows={3}
          value={editComment}
          placeholder="备注（选填）"
          onChange={(e) => setEditComment(e.target.value)}
        />
        <div className="notes-anno-actions">
          <button className="primary small" disabled={detail.busy} onClick={() => void handleSaveAnnoEdit()}>
            保存修改
          </button>
          <button className="ghost-btn" onClick={() => setEditId(null)}>
            取消
          </button>
          <button className="danger-btn" disabled={detail.busy} onClick={() => void handleDeleteAnno(r.row.id)}>
            删除这条批注
          </button>
        </div>
      </div>
    );
  }

  function renderAnnoBody(r: ResolvedAnnotation) {
    const invalidOne = r.blockIndex < 0;
    return (
      <div className="notes-anno-body">
        <div className="notes-anno-quote">
          <Highlight text={r.row.quote ?? "（没有记录原文片段）"} terms={terms} />
        </div>
        {editId === r.row.id ? (
          renderAnnoActions(r)
        ) : (
          <>
            <div className="notes-anno-comment">
              {(r.row.comment ?? "").trim() ? r.row.comment : <span className="muted">（没有写备注）</span>}
            </div>
            {renderAnnoActions(r)}
            {invalidOne && (
              <div className="notes-anno-dead">这条批注的原文片段在现在的正文里已经找不到了。</div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="notes-page page-stack">
      {!isTauri() && (
        <div className="demo-banner">
          <span>
            <b>当前是浏览器预览模式</b>：下面展示的是<b>示例笔记与示例批注</b>（用于调试界面）。
            读取走预览数据，<b>保存 / 删除 / 导出 .docx 等写入类操作仅桌面版可用</b>，点了会给出明确提示，
            不会假装成功。
          </span>
        </div>
      )}

      {error && (
        <div className="settings-msg err" onClick={clearError}>
          {error}
        </div>
      )}
      {notice && (
        <div className="settings-msg ok" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {/* ---------------- 手动写笔记（R6） ---------------- */}
      <section className="card no-print">
        {!manualOpen ? (
          <div className="notes-list-head" style={{ marginBottom: 0 }}>
            <h3 style={{ margin: 0 }}>自己写一条</h3>
            <button
              className="primary small"
              disabled={manualCourseId == null}
              title={
                manualCourseId == null
                  ? "还没有课程：先在「课程」页新建一门"
                  : "直接写一条笔记（来源标「自己写的」）"
              }
              onClick={() => {
                setManualOpen(true);
                setManualErr(null);
                setManualTitle("");
                setManualContent("");
              }}
            >
              <Icon name="plus" size={15} /> 新建笔记
            </button>
          </div>
        ) : (
          <>
            <div className="notes-field" style={{ marginBottom: 8 }}>
              <span>标题</span>
              <input
                autoFocus
                value={manualTitle}
                placeholder="例如：第 3 讲 · 摊还分析"
                onChange={(e) => setManualTitle(e.target.value)}
              />
            </div>
            <div className="notes-field" style={{ marginBottom: 8 }}>
              <span>正文（Markdown）</span>
              <textarea
                rows={8}
                value={manualContent}
                placeholder={"直接写就行，支持 Markdown：\n\n## 要点\n- 第一条\n- 第二条\n\n> 存疑的地方先记下来"}
                onChange={(e) => setManualContent(e.target.value)}
              />
            </div>
            {manualErr && <div className="settings-msg err">{manualErr}</div>}
            <div className="notes-gen-bar">
              <button className="primary small" disabled={manualBusy} onClick={() => void handleSaveManual()}>
                {manualBusy ? "保存中…" : "保存笔记"}
              </button>
              <button className="ghost-btn" onClick={() => setManualOpen(false)}>
                取消
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                归属：{manualCourseId == null ? "（还没有课程）" : courseNameOf(courses, manualCourseId)} ·
                来源会标「自己写的」
              </span>
            </div>
          </>
        )}
      </section>

      {/* ---------------- 生成笔记 ---------------- */}
      <section className="card notes-gen-card no-print">
        <h3>从当天对话整理</h3>
        <div className="notes-gen-bar">
          <label className="notes-field">
            <span>课程</span>
            <select
              value={genCourseId ?? ""}
              onChange={(e) => setGenCourseId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">（请选择课程）</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archived ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="notes-field">
            <span>日期</span>
            <input type="date" value={genDate} onChange={(e) => setGenDate(e.target.value)} />
          </label>
          <button
            className="primary small"
            disabled={!hasKey || genBusy || savingDraft}
            title={hasKey ? "按这一天的问答记录整理成草稿" : "未配置模型 API Key，无法调用模型整理"}
            onClick={() => void handleGenerate()}
          >
            {genBusy ? (
              "整理中…"
            ) : (
              <>
                <Icon name="sparkles" />
                生成笔记（AI 整理）
              </>
            )}
          </button>
          {!hasKey && (
            <Link to="/settings" className="ghost-btn" style={{ textDecoration: "none" }}>
              去「数据设置」配置 →
            </Link>
          )}
        </div>
        {genMsg && <div className="notes-gen-msg">{genMsg}</div>}
        {genErr && (
          <div className="settings-msg err" onClick={() => setGenErr(null)}>
            {genErr}
          </div>
        )}
        {genRaw && (
          <details className="notes-raw">
            <summary>查看模型原始输出（AI 整理、未核对；解析有问题时用来排障）</summary>
            <pre>{genRaw}</pre>
          </details>
        )}

        {draft && (
          <div className="notes-draft">
            <div className="notes-draft-head">
              <b>草稿预览（还没保存）</b>
              <span className="src-badge src-ai">AI 整理 · 待核对</span>
              <span className="muted" style={{ fontSize: 12 }}>
                来自 {draft.messageCount} 条消息 / {draft.sessionCount} 个会话 · 正文 {draft.content.length} 字
              </span>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
              标题与正文都能直接改；点「保存到笔记」才会存下来。
              {draft.titleFromModel
                ? ""
                : "（标题是本地按「课程 + 日期」拼的，请自行确认。）"}
            </p>
            <input
              className="notes-input"
              value={draft.title}
              placeholder="笔记标题（必填）"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              className="notes-textarea"
              rows={14}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
            <div className="notes-draft-actions">
              <button
                className="primary small"
                disabled={savingDraft || !draft.title.trim() || !draft.content.trim()}
                onClick={() => void handleSaveDraft()}
              >
                {savingDraft ? "保存中…" : "保存到笔记"}
              </button>
              <button
                className="ghost-btn"
                disabled={savingDraft}
                onClick={() => {
                  setDraft(null);
                  setGenRaw(null);
                  setGenMsg(null);
                }}
              >
                取消
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                保存后仍可编辑；标「待确认」的小节请逐条核对。
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="notes-split">
        {/* ---------------- 列表 ---------------- */}
        <section className="card notes-list-card no-print">
          <div className="notes-list-head">
            <h3 style={{ margin: 0 }}>
              {lockedCourseId != null
                ? `本课笔记（${notes.length}）`
                : `全部笔记（${notes.length}）`}
            </h3>
            {/* R6：侧栏已经选过课程时不显示筛选器 —— 当前范围由顶栏的课程胶囊说明 */}
            {lockedCourseId == null && (
              <label className="notes-field">
                <span>按课程筛选</span>
                <select
                  value={courseFilter ?? ""}
                  onChange={(e) => setCourseFilter(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">全部课程</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.archived ? "（已归档）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {loading ? (
            <p className="loading-line">加载中…</p>
          ) : notes.length === 0 ? (
            <p className="empty">这里还没有笔记。</p>
          ) : (
            /* R9：**按天分组**（用户要求"按天整理"）。
               自己写的（`source='user'`）与 AI 从对话整理的（`source='ai_session'`）**同列在一起**，
               靠来源徽标区分；日期倒序，排在最后的是"未标日期"那一组。 */
            notesByDay.map(([day, items]) => (
              <div className="notes-day" key={day}>
                <div className="notes-day-head">
                  <span className="notes-day-label">{day}</span>
                  <span className="notes-day-count">{items.length} 条</span>
                </div>
                <ul className="notes-list">
                  {items.map((n) => {
                    const info = noteSourceInfo(n.source);
                    return (
                      <li key={n.id} className={"notes-item" + (n.id === selectedId ? " active" : "")}>
                        {/* R12：**点笔记 = 打开沉浸式编辑页**（用户要求「点笔记有一个单独文件窗口」）。
                            原来点一下只是在本页右侧预览；批注与导出仍然在那一侧，
                            所以右下的「阅读」按钮保留原行为，两条路都不丢。 */}
                        <button
                          type="button"
                          className="notes-item-main"
                          onClick={() => nav(`/note/${n.id}`)}
                          title="打开编辑器（写正文、贴图片、写公式）"
                        >
                          <span className="notes-item-title">{n.title}</span>
                          <span className="notes-item-meta">
                            <span className={info.cls}>{info.text}</span>
                            {n.exported ? <span className="tag notes-tag-ok">已导出</span> : null}
                            <span className="tag">{n.content_len} 字</span>
                            <span className="muted">{courseNameOf(courses, n.course_id)}</span>
                          </span>
                        </button>
                        <button
                          className="ghost-btn"
                          onClick={() => setSelectedId(n.id)}
                          title="在本页阅读这条笔记（看批注 / 导出）"
                        >
                          阅读
                        </button>
                        <button
                          className="danger-btn"
                          disabled={detail.busy}
                          onClick={() => void handleDeleteNote(n)}
                        >
                          删除
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>

        {/* ---------------- 详情 ---------------- */}
        <section className="card notes-detail-card">
          {detail.loading ? (
            <p className="loading-line">加载中…</p>
          ) : !detail.note || !src ? (
            <p className="empty">从左边选一条笔记。</p>
          ) : (
            <>
              <div className="notes-toolbar no-print">
                <span className="muted" style={{ fontSize: 12 }}>
                  导出：
                </span>
                <button className="ghost-btn" onClick={handleExportMd}>
                  Markdown（.md）
                </button>
                <button className="ghost-btn" disabled={exporting} onClick={() => void handleExportDocx()}>
                  {exporting ? "导出中…" : "Word（.docx）"}
                </button>
                <button className="ghost-btn" onClick={handlePrint}>
                  打印为 PDF
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {PDF_HINT}（打印样式只输出正文，不含列表与批注面板）
                </span>
                <button className="ghost-btn" onClick={editing ? () => setEditing(false) : startEditNote}>
                  {editing ? "退出编辑" : "编辑标题 / 正文"}
                </button>
              </div>

              <div className="notes-export-dir no-print">
                <label className="notes-field">
                  <span>Word 导出目录（选填，填过就记在本机）</span>
                  <input
                    value={exportDir}
                    placeholder="例如 D:\\课程\\笔记（留空会导出失败并提示你填）"
                    onChange={(e) => setExportDir(e.target.value)}
                  />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  .docx 由本机生成（不联网）；目录需要已存在或能被创建。
                  这里填一次，之后会自动记住。
                </span>
              </div>

              {exportMsg && (
                <div
                  className={"settings-msg " + (exportMsg.type === "ok" ? "ok" : "err")}
                  onClick={() => setExportMsg(null)}
                >
                  {exportMsg.text}
                </div>
              )}
              {printMsg && (
                <div className="settings-msg ok" onClick={() => setPrintMsg(null)}>
                  {printMsg}
                </div>
              )}

              <div className="notes-read-tools no-print">
                <label className="notes-field">
                  <span>关键词高亮（只是阅读时的标记，不会改动笔记）</span>
                  <input
                    value={termText}
                    placeholder="空格分隔多个词，例如：均摊 红黑树"
                    onChange={(e) => setTermText(e.target.value)}
                  />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  在正文里<b>选中文字</b>即可加批注；点已有高亮可以改备注或删除。
                </span>
              </div>

              {editing && (
                <div className="notes-editor no-print">
                  <input
                    className="notes-input"
                    value={editTitle}
                    placeholder="笔记标题（必填）"
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <textarea
                    className="notes-textarea"
                    rows={16}
                    value={editContent}
                    placeholder="Markdown 正文"
                    onChange={(e) => setEditContent(e.target.value)}
                  />
                  <div className="notes-draft-actions">
                    <button
                      className="primary small"
                      disabled={detail.busy || !editTitle.trim()}
                      onClick={() => void handleSaveNoteEdit()}
                    >
                      {detail.busy ? "保存中…" : "保存修改"}
                    </button>
                    <button className="ghost-btn" disabled={detail.busy} onClick={() => setEditing(false)}>
                      取消
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      修改正文会让旧批注按原文片段重新定位；找不回的会进「已失效的批注」。
                    </span>
                  </div>
                </div>
              )}

              {/* 正文（打印时只输出这一块） */}
              <article className="notes-doc">
                <div className="notes-doc-head">
                  <h2 className="notes-doc-title">{detail.note.title}</h2>
                  <div className="notes-doc-meta">
                    <span className={src.cls}>{src.text}</span>
                    <span className="tag">{detail.note.date || "未标日期"}</span>
                    {detail.note.exported ? <span className="tag notes-tag-ok">已导出</span> : null}
                    <span className="muted">
                      {courseNameOf(courses, detail.note.course_id)} · {detail.note.content_len} 字 ·{" "}
                      {detail.note.created_at}
                    </span>
                  </div>
                  {src.ai && (
                    <div className="notes-ai-warn">
                      这是 AI 依据当天问答记录整理的笔记，<b>尚未与教材 / 课堂核对</b>
                      ：请逐条确认后再当依据用；标「待确认」的小节是模型自己也没把握的地方。
                    </div>
                  )}
                </div>
                <div className="notes-doc-body" onMouseUp={handleDocMouseUp}>
                  <Markdown
                    text={detail.note.content_md}
                    marks={marks}
                    terms={terms}
                    onMarkClick={(id) => startEditAnno(id)}
                  />
                </div>
              </article>

              {/* 已定位的批注 */}
              <div className="notes-anno-block no-print">
                <h3>这条笔记的批注（{placed.length}）</h3>
                <p className="muted" style={{ fontSize: 12 }}>
                  每条批注的锚点 = 块序号 + 块内字符偏移 + 原文片段。正文改动后会先按原位置取文本与原文片段比对，
                  对不上就自动重新定位。
                  {healedCount > 0 ? ` 其中 ${healedCount} 条的位置已自动修正（下面有标记）。` : ""}
                </p>
                {placed.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12 }}>
                    还没有批注。在上面的正文里选中一段文字，就会弹出「加批注」小面板。
                  </p>
                ) : (
                  <ul className="notes-anno-list">
                    {placed.map((r) => (
                      <li key={r.row.id} id={`notes-anno-${r.row.id}`} className="notes-anno-item">
                        <span
                          className={`notes-anno-dot color-${r.row.color ?? "yellow"}`}
                          title={`颜色：${COLOR_LABEL[r.row.color ?? "yellow"] ?? "黄"}`}
                        />
                        {renderAnnoBody(r)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 失效的批注：单独成列，不假装还在正文里 */}
              <div className="notes-anno-block notes-anno-dead-block no-print">
                <h3>已失效的批注（{invalid.length}）</h3>
                <p className="muted" style={{ fontSize: 12 }}>
                  这些批注的原文片段在<b>现在的正文里已经找不到</b>
                  了（笔记被重新整理或改过），所以不会画在正文上。可以在这里查看内容或删除；
                  若还想要这条批注，请在正文里重新选一次文字。
                </p>
                {invalid.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12 }}>
                    没有失效的批注。
                  </p>
                ) : (
                  <ul className="notes-anno-list">
                    {invalid.map((r) => (
                      <li key={r.row.id} id={`notes-anno-${r.row.id}`} className="notes-anno-item is-dead">
                        <span
                          className={`notes-anno-dot color-${r.row.color ?? "yellow"}`}
                          title={`颜色：${COLOR_LABEL[r.row.color ?? "yellow"] ?? "黄"}`}
                        />
                        {renderAnnoBody(r)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 选中文字后的「加批注」小面板 */}
      {sel && (
        <div className="notes-sel-panel no-print" style={{ left: sel.x, top: sel.y }}>
          <div className="notes-sel-head">
            <b>加批注</b>
            <span className="muted">
              第 {sel.blockIndex} 块 · 第 {sel.start}–{sel.end} 字
            </span>
          </div>
          <div className="notes-sel-quote">
            「{sel.quote.length > 80 ? `${sel.quote.slice(0, 80)}…` : sel.quote}」
          </div>
          {sel.cross && (
            <div className="notes-sel-warn">
              你选中的文字<b>跨了多个内容块</b>。一条批注只记录「一个块 + 块内偏移」，所以这里
              <b>按起始块整块</b>记录。想要精确标注，请只在一个块（一个段落 / 列表 / 表格）内选。
            </div>
          )}
          <div className="notes-color-row">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`notes-color-btn color-${c}${annoColor === c ? " active" : ""}`}
                title={COLOR_LABEL[c]}
                onClick={() => setAnnoColor(c)}
              />
            ))}
          </div>
          <textarea
            className="notes-textarea"
            rows={2}
            value={annoComment}
            placeholder="备注（选填）"
            onChange={(e) => setAnnoComment(e.target.value)}
          />
          <div className="notes-sel-actions">
            <button className="primary small" disabled={annoSaving} onClick={() => void handleAddAnnotation()}>
              {annoSaving ? "保存中…" : "保存批注"}
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                setSel(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
