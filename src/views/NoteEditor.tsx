// R12 · 笔记**沉浸式编辑器**（多模态：文字 + 图片 + 公式 + 代码块）
//
// 用户诉求（原话）：「点笔记有一个单独文件窗口，这个文件窗口支持文本输入、粘贴图片等，
// 还要有简单的格式渲染（比如代码块、字体大小、主副标题、公式等）」。
// 落地口径（三处已拍板）：
//   ① 形态 = **应用内沉浸式编辑页**（`/note/:id`，`Layout` 走 `editor-shell` 无干扰外壳）；
//   ② 公式 = 内置 **KaTeX**（见 `lib/math.tsx`；这是本项目第一个第三方前端依赖，
//      与 `components/Icon.tsx` 里「不新增第三方依赖」的旧约定**冲突**，已如实登记进 `docs/23`）；
//   ③ 图片 = **内联 dataURL** 写进 `content_md`（与 R4 聊天图片同一套口径，`lib/images.ts` 直接复用）。
//
// 几条刻意的设计决定：
//   · **编辑区是 `<textarea>`，不是 contentEditable** —— contentEditable 在中文输入法下的
//     组合事件、选区与撤销栈都极易出问题；textarea 的原生撤销/重做（Ctrl+Z/Y）与输入法支持
//     是白拿的。代价是"所见即所得"改成"左写右看"，这与 Typora 之外的多数笔记软件一致。
//   · **图片超过上限如实说明被拒原因**，绝不静默丢弃（复用 `collectImages` 的既有语义）。
//   · **未保存就离开要拦一下**（返回按钮 + 关窗），不给"悄悄丢掉你写的东西"这种结果。
//   · 不写"提示性描述"（R9 用户明确要求界面别解释自己）：说明一律放 `title` 悬停提示。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import Icon, { type IconName } from "../components/Icon";
import { useCourses } from "../hooks/useCourses";
import { useNoteDetail } from "../hooks/useNotes";
import Markdown from "../lib/markdown";
import { collectImages, humanBytes, imagesFromClipboard, MAX_TOTAL_BYTES } from "../lib/images";
import { noteSourceInfo } from "../lib/notes";
import "./NoteEditor.css";

// ---------------------------------------------------------------------------
// 纯函数：对「正文 + 选区」做一次编辑，返回新正文与新选区
// ---------------------------------------------------------------------------

interface Edit {
  text: string;
  selStart: number;
  selEnd: number;
}

/** 在 [start,end) 两侧包一层标记（粗体 / 斜体 / 行内代码 / 行内公式） */
function wrapSelection(text: string, start: number, end: number, before: string, after = before): Edit {
  const sel = text.slice(start, end);
  const next = text.slice(0, start) + before + sel + after + text.slice(end);
  return {
    text: next,
    selStart: start + before.length,
    selEnd: start + before.length + sel.length,
  };
}

/** 取 [start,end) 所覆盖的整行范围（用于逐行加前缀） */
function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const idx = text.indexOf("\n", end);
  return [from, idx === -1 ? text.length : idx];
}

/**
 * 给选中的每一行加 / 去前缀（列表、引用）。
 * 已经**全部**带该前缀 → 视为"再点一次取消"，去掉前缀（按钮因此是开关）。
 */
function togglePrefix(text: string, start: number, end: number, prefix: string, ordered: boolean): Edit {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const all = lines.length > 0 && lines.every((l) => l.startsWith(prefix));
  const out = lines
    .map((l, i) => {
      if (all) return l.slice(prefix.length);
      return (ordered ? `${i + 1}. ` : prefix) + l;
    })
    .join("\n");
  return { text: text.slice(0, from) + out + text.slice(to), selStart: from, selEnd: from + out.length };
}

/**
 * 设置标题级别：`level = 0` 表示去掉标题。
 * 先剥掉已有的 `#{1,6} ` 再写新的，所以 H2 → H3 是**替换**而不是越点越长（`## ## 标题`）。
 */
function setHeading(text: string, start: number, end: number, level: number): Edit {
  const [from, to] = lineRange(text, start, end);
  const out = text
    .slice(from, to)
    .split("\n")
    .map((l) => {
      const bare = l.replace(/^ {0,3}#{1,6}\s+/, "");
      return level > 0 ? `${"#".repeat(level)} ${bare}` : bare;
    })
    .join("\n");
  return { text: text.slice(0, from) + out + text.slice(to), selStart: from, selEnd: from + out.length };
}

/**
 * 在 [start,end) 处插入一段片段，并选中其中的占位内容（`select` 是相对插入点的偏移）。
 * 不传 `select` → 光标落在片段之后。
 */
function insertSnippet(
  text: string,
  start: number,
  end: number,
  snippet: string,
  select?: [number, number],
): Edit {
  const next = text.slice(0, start) + snippet + text.slice(end);
  const at = start + snippet.length;
  if (!select) return { text: next, selStart: at, selEnd: at };
  return { text: next, selStart: start + select[0], selEnd: start + select[1] };
}

/** 正文里已经内联的图片 dataURL（用于图片**总量**上限判定） */
export function inlineImageDataUrls(content: string): string[] {
  return Array.from(content.matchAll(/!\[[^\]]*\]\((data:image\/[^)\s]+)\)/g)).map((m) => m[1]);
}

/** 字符数（中文按字，英文按字符 —— 与笔记列表页的 `content_len` 同一口径） */
function countChars(s: string): number {
  return s.length;
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

type ViewMode = "edit" | "split" | "preview";

const VIEW_LABEL: Record<ViewMode, string> = { edit: "编辑", split: "分栏", preview: "预览" };

export default function NoteEditor() {
  const { id } = useParams<{ id: string }>();
  const noteId = Number(id);
  const nav = useNavigate();
  const { courses } = useCourses();
  const { note, loading, busy, error, setError, updateNote } = useNoteDetail(
    Number.isFinite(noteId) ? noteId : null,
  );

  // —— 本地可编辑副本 ——
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  /** 已经同步过本地副本的笔记 id：换笔记才重灌，避免覆盖用户正在写的字 */
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [mode, setMode] = useState<ViewMode>("split");
  const [notice, setNotice] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 工具按钮会抢走焦点，所以在 textarea 里持续记录最后一次选区 */
  const selRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  /** 视图模式（用 ref 供 `apply` 读取，避免把 mode 塞进 useCallback 依赖里） */
  const modeRef = useRef<ViewMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // 载入（或换笔记）时灌入本地副本
  useEffect(() => {
    if (!note) return;
    if (loadedId !== note.id) {
      setTitle(note.title);
      setContent(note.content_md);
      setLoadedId(note.id);
      setNotice(null);
      setSavedAt(null);
    }
  }, [note, loadedId]);

  const dirty = note != null && (title !== note.title || content !== note.content_md);

  /** 未保存就关窗要拦一下（浏览器/Tauri WebView 都吃 `beforeunload`） */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const courseName = useMemo(() => {
    if (!note) return "";
    return courses.find((c) => c.id === note.course_id)?.name ?? `课程 #${note.course_id}`;
  }, [courses, note]);

  /** 把一次编辑落到正文与选区 */
  const apply = useCallback((edit: Edit) => {
    // 「预览」模式下编辑区是不渲染的：此时点工具按钮必须**切回分栏**，
    // 否则改动落在看不见的 textarea 上 —— 用户会以为"点了没反应"。
    if (modeRef.current === "preview") setMode("split");
    setContent(edit.text);
    selRef.current = { start: edit.selStart, end: edit.selEnd };
    // 等 React 把新值写进 textarea 之后再设选区，否则会被受控组件的重渲染覆盖
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(edit.selStart, edit.selEnd);
    });
  }, []);

  /** 当前选区（工具按钮点击时 textarea 已失焦，所以读缓存的 selRef） */
  const sel = useCallback((): [number, number] => {
    const ta = taRef.current;
    if (ta && document.activeElement === ta) return [ta.selectionStart, ta.selectionEnd];
    return [selRef.current.start, selRef.current.end];
  }, []);

  const rememberSel = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    selRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  // —— 工具栏动作 ——
  const act = useMemo(
    () => ({
      heading: (level: number) => apply(setHeading(content, ...sel(), level)),
      bold: () => apply(wrapSelection(content, ...sel(), "**")),
      italic: () => apply(wrapSelection(content, ...sel(), "*")),
      code: () => apply(wrapSelection(content, ...sel(), "`")),
      quote: () => apply(togglePrefix(content, ...sel(), "> ", false)),
      ul: () => apply(togglePrefix(content, ...sel(), "- ", false)),
      ol: () => apply(togglePrefix(content, ...sel(), "1. ", true)),
      divider: () => {
        const [s, e] = sel();
        apply(insertSnippet(content, s, e, "\n\n---\n\n"));
      },
      codeBlock: () => {
        const [s, e] = sel();
        const body = content.slice(s, e);
        // 片段形如 "\n\n```\n<body>\n```\n\n" → 正文从索引 6 开始
        const snippet = `\n\n\`\`\`\n${body}\n\`\`\`\n\n`;
        apply(insertSnippet(content, s, e, snippet, [6, 6 + body.length]));
      },
      table: () => {
        const [s, e] = sel();
        // "\n\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n\n" → 首个表头单元格 "列 1" 在 4..7
        const snippet = "\n\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n\n";
        apply(insertSnippet(content, s, e, snippet, [4, 7]));
      },
      link: () => {
        const [s, e] = sel();
        const label = content.slice(s, e) || "链接文字";
        const snippet = `[${label}](https://)`;
        apply(insertSnippet(content, s, e, snippet, [label.length + 3, label.length + 11]));
      },
      /** 行内公式 `$...$`：有选中内容就用它，没有就给一段能立刻看出效果的示例并选中 */
      mathInline: () => {
        const [s, e] = sel();
        const body = content.slice(s, e);
        if (body) {
          // "$" + body + "$" → 选中中间那段
          apply(insertSnippet(content, s, e, `$${body}$`, [1, 1 + body.length]));
          return;
        }
        const demo = "a^2+b^2=c^2";
        apply(insertSnippet(content, s, e, `$${demo}$`, [1, 1 + demo.length]));
      },
      /** 块级公式 `$$...$$`（单独成行，渲染为居中大公式） */
      mathBlock: () => {
        const [s, e] = sel();
        const snippet = "\n\n$$\nE = mc^2\n$$\n\n";
        apply(insertSnippet(content, s, e, snippet, [5, 5 + "E = mc^2".length]));
      },
      image: () => fileRef.current?.click(),
    }),
    [apply, content, sel],
  );

  // —— 图片：粘贴 / 拖入 / 选择文件，三条入口共用同一段逻辑 ——
  const [imgBusy, setImgBusy] = useState(false);

  const addImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setImgBusy(true);
      try {
        const res = await collectImages(files, inlineImageDataUrls(content));
        if (res.images.length > 0) {
          const md = res.images
            .map((d, i) => `![图片 ${i + 1}](${d})`)
            .join("\n\n");
          const [s, e] = sel();
          const snippet = `\n\n${md}\n\n`;
          apply(insertSnippet(content, s, e, snippet));
        }
        // 被拒的原因**逐条如实**摆出来，不静默丢
        setNotice(
          res.rejected.length > 0
            ? res.rejected.join("\n")
            : res.images.length > 0
              ? `已插入 ${res.images.length} 张图片（存在本机笔记里，单条上限 ${humanBytes(MAX_TOTAL_BYTES)}）。`
              : null,
        );
      } finally {
        setImgBusy(false);
      }
    },
    [apply, content, sel],
  );

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = imagesFromClipboard(e.nativeEvent);
      // 没有图片就交给 textarea 的默认纯文本粘贴
      if (files.length === 0) return;
      e.preventDefault();
      void addImages(files);
    },
    [addImages],
  );

  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      void addImages(files);
    },
    [addImages],
  );

  const onPickFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = ""; // 允许连续两次选同一个文件
      void addImages(files);
    },
    [addImages],
  );

  // —— 保存 ——
  const save = useCallback(async (): Promise<boolean> => {
    if (!note) return false;
    const t = title.trim();
    if (!t) {
      setNotice("标题不能为空。");
      return false;
    }
    if (!content.trim()) {
      setNotice("正文不能为空。");
      return false;
    }
    const ok = await updateNote({ title: t, contentMd: content });
    if (ok) {
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      setNotice("已保存到本机。");
    }
    return ok;
  }, [content, note, title, updateNote]);

  /** 返回列表（有未保存改动先问一句，不悄悄丢） */
  const goBack = useCallback(() => {
    if (dirty && !window.confirm("这条笔记有未保存的修改，确定离开吗？\n选择「取消」可以回去继续写，或先点保存。")) {
      return;
    }
    const cid = note?.course_id;
    nav(cid != null ? `/notes?course=${cid}` : "/notes");
  }, [dirty, nav, note]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        apply(wrapSelection(content, ...sel(), "**"));
        return;
      }
      if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        apply(wrapSelection(content, ...sel(), "*"));
        return;
      }
      // Tab 插入两个空格（不抢走焦点：笔记里 Tab 缩进比切控件更常用）
      if (e.key === "Tab") {
        e.preventDefault();
        const [s] = sel();
        apply(insertSnippet(content, s, s, "  "));
        return;
      }
      // 回车自动延续列表（- / * / 1. ）；在**空条目**上回车则结束列表（与主流笔记软件一致）
      if (e.key === "Enter" && !e.shiftKey && !mod) {
        const [s] = sel();
        const [from, to] = lineRange(content, s, s);
        // 只在行尾接管：光标在行中间时回车必须按默认行为**断开这一行**，否则会打断行内编辑
        if (s !== to) return;
        const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(content.slice(from, to));
        if (!m) return;
        const [, indent, marker, body] = m;
        e.preventDefault();
        if (body.trim() === "") {
          // 空条目 → 去掉标记并退出列表
          apply(insertSnippet(content, from, to, ""));
          return;
        }
        const nextMarker = /^\d/.test(marker) ? `${Number.parseInt(marker, 10) + 1}.` : marker;
        apply(insertSnippet(content, to, to, `\n${indent}${nextMarker} `));
      }
    },
    [apply, content, save, sel],
  );

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  if (!Number.isFinite(noteId)) {
    return (
      <div className="editor-shell-inner">
        <p className="empty">笔记地址不对。请从笔记列表里点开一条。</p>
      </div>
    );
  }

  const src = note ? noteSourceInfo(note.source) : null;
  const tb: Array<{ icon: IconName; title: string; on: () => void }> = [
    { icon: "bold", title: "加粗（Ctrl+B）", on: act.bold },
    { icon: "italic", title: "斜体（Ctrl+I）", on: act.italic },
    { icon: "code", title: "行内代码", on: act.code },
  ];

  return (
    <div className="editor-shell-inner notes-page" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      {/* ---------------- 顶部栏 ---------------- */}
      <header className="editor-bar">
        <button className="ghost-btn" onClick={goBack} title="返回笔记列表">
          <Icon name="chevron-right" className="editor-back" />
          笔记
        </button>

        <input
          className="editor-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="笔记标题"
          aria-label="笔记标题"
        />

        <div className="editor-bar-right">
          {note && (
            <>
              <span className={src!.cls}>{src!.text}</span>
              <span className="tag" title="这条笔记所属课程">
                {courseName}
              </span>
            </>
          )}
          <span className="editor-dirty" aria-live="polite">
            {busy
              ? "保存中…"
              : loading && !note
                ? "加载中…"
                : dirty
                  ? "未保存"
                  : savedAt
                    ? `已保存 ${savedAt}`
                    : "已保存"}
          </span>
          {(["edit", "split", "preview"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={"chip" + (mode === m ? " chip-active" : "")}
              onClick={() => setMode(m)}
              title={m === "edit" ? "只看编辑区" : m === "split" ? "左边写、右边看" : "只看渲染结果"}
            >
              {VIEW_LABEL[m]}
            </button>
          ))}
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()} title="保存（Ctrl+S）">
            保存
          </button>
        </div>
      </header>

      {error && (
        <div className="settings-msg err" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {notice && (
        <div className="settings-msg ok editor-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {note?.source === "ai_session" && (
        <div className="notes-ai-warn">
          这是 AI 依据当天问答记录整理的笔记，<b>尚未与教材 / 课堂核对</b>：请逐条确认后再当依据用。
        </div>
      )}

      {/* ---------------- 工具栏 ---------------- */}
      <div className="editor-toolbar">
        <div className="editor-toolgroup">
          <button className="editor-tool" title="一级标题" onClick={() => act.heading(1)}>
            H1
          </button>
          <button className="editor-tool" title="二级标题" onClick={() => act.heading(2)}>
            H2
          </button>
          <button className="editor-tool" title="三级标题" onClick={() => act.heading(3)}>
            H3
          </button>
          <button className="editor-tool" title="正文（去掉标题）" onClick={() => act.heading(0)}>
            正文
          </button>
        </div>
        <div className="editor-toolgroup">
          {tb.map((b) => (
            <button key={b.icon} className="editor-tool" title={b.title} aria-label={b.title} onClick={b.on}>
              <Icon name={b.icon} size={16} />
            </button>
          ))}
        </div>
        <div className="editor-toolgroup">
          <button className="editor-tool" title="引用" onClick={act.quote}>
            <Icon name="quote" size={16} />
          </button>
          <button className="editor-tool" title="无序列表" onClick={act.ul}>
            <Icon name="listUl" size={16} />
          </button>
          <button className="editor-tool" title="有序列表" onClick={act.ol}>
            <Icon name="listOl" size={16} />
          </button>
          <button className="editor-tool" title="代码块" onClick={act.codeBlock}>
            <span className="editor-tool-tex">{"```"}</span>
          </button>
        </div>
        <div className="editor-toolgroup">
          <button className="editor-tool" title="行内公式 $…$" onClick={act.mathInline}>
            <Icon name="sigma" size={16} />
          </button>
          <button className="editor-tool" title="块级公式 $$…$$（单独居中一行）" onClick={act.mathBlock}>
            <span className="editor-tool-tex">$$</span>
          </button>
          <button className="editor-tool" title="表格" onClick={act.table}>
            <Icon name="table" size={16} />
          </button>
          <button className="editor-tool" title="链接" onClick={act.link}>
            <Icon name="link" size={16} />
          </button>
          <button className="editor-tool" title="分隔线" onClick={act.divider}>
            <Icon name="divider" size={16} />
          </button>
        </div>
        <div className="editor-toolgroup">
          <button
            className="editor-tool"
            title={`插入图片（也可以直接 Ctrl+V 粘贴，或把图片拖进来；单条上限 ${humanBytes(MAX_TOTAL_BYTES)}）`}
            aria-label="插入图片"
            disabled={imgBusy}
            onClick={act.image}
          >
            <Icon name="image" size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPickFiles}
            aria-label="选择图片文件"
          />
        </div>
      </div>

      {/* ---------------- 正文：编辑 + 预览 ---------------- */}
      <div className={"editor-body mode-" + mode}>
        {mode !== "preview" && (
          <textarea
            ref={taRef}
            className="editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onSelect={rememberSel}
            onKeyUp={rememberSel}
            onClick={rememberSel}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
            placeholder="正文（Markdown）。粘贴图片、写 $公式$ 都可以。"
            aria-label="笔记正文"
          />
        )}
        {mode !== "edit" && (
          /* `notes-doc-body` = 与笔记页**共用同一套** Markdown 排版（标题字号 / 代码块 /
             表格 / 批注高亮），见 `views/NoteEditor.css` 头部说明。 */
          <div className="editor-preview notes-doc-body">
            {loading && !note ? (
              <p className="loading-line">加载中…</p>
            ) : content.trim() ? (
              <Markdown text={content} />
            ) : (
              <p className="empty">还没有内容。</p>
            )}
          </div>
        )}
      </div>

      {/* ---------------- 底栏 ---------------- */}
      <footer className="editor-foot">
        <span>{countChars(content)} 字</span>
        {note && <span className="muted">创建于 {note.created_at}</span>}
        <span className="muted">
          图片以 dataURL 内联存在本机笔记里；公式由内置 KaTeX 本机渲染，都不联网。
        </span>
        {note && (
          <button
            className="ghost-btn"
            onClick={() => nav(`/notes?course=${note.course_id}`)}
            title="去笔记列表看这条笔记的批注与导出"
          >
            批注与导出
          </button>
        )}
      </footer>
    </div>
  );
}
