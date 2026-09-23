// M3 笔记页数据层：笔记列表 / 详情 / 批注的读取与写入。
//
// 分工（与 M0–M2 一致）：
//   · 桌面（`isTauri()`）→ 走 Rust 命令（SQLite）；
//   · 浏览器预览 → 读取降级到 `data/sample.ts` 的示例数据；
//   · **写入一律 `invokeStrict`**（`lib/notes.ts` 里做的），所以在预览模式下会抛出
//     「该操作仅桌面版可用」这类可读错误 —— 本层接住后放进 `error` 交给界面展示，**绝不静默失败**。
//
// 批注写入后**重新读库**再更新界面：不靠本地拼接假装成功（写入失败时界面必须与库一致）。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  annotationAdd,
  annotationDelete,
  annotationUpdate,
  annotationsList,
  noteDelete,
  noteGet,
  noteSave,
  notesList,
  noteUpdate,
  type AnnotationAddInput,
  type AnnotationRow,
  type NoteDetail,
  type NoteRow,
  type NoteSaveInput,
} from "../lib/notes";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 组件卸载后不再 setState（异步读取可能晚于卸载返回）。
 *
 * ⚠️ 必须在 effect 体里把 `current` 重新置回 `true`：React 18 的 StrictMode 在开发模式下会
 *    「挂载 → 卸载 → 再挂载」同一个组件实例，若只在清理函数里置 false，重新挂载后这个 ref
 *    会永远是 false，页面就再也不会更新（表现为整页空白）。
 */
function useAlive(): { readonly current: boolean } {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

export function useNotes(courseId: number | null) {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();

  const reload = useCallback(async (): Promise<NoteRow[]> => {
    setLoading(true);
    try {
      const list = await notesList(courseId);
      if (alive.current) {
        setNotes(list);
        setError(null);
      }
      return list;
    } catch (e) {
      if (alive.current) setError(`读取笔记列表失败：${errText(e)}`);
      return [];
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [alive, courseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 新建笔记（AI 整理或自己写的都走这里；来源由 `input.source` 决定，界面上必须如实标注） */
  const createNote = useCallback(
    async (input: NoteSaveInput): Promise<number | null> => {
      try {
        const id = await noteSave(input);
        await reload();
        if (alive.current) setError(null);
        return id;
      } catch (e) {
        if (alive.current) setError(`保存笔记失败：${errText(e)}`);
        return null;
      }
    },
    [alive, reload],
  );

  const removeNote = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        await noteDelete(id);
        await reload();
        if (alive.current) setError(null);
        return true;
      } catch (e) {
        if (alive.current) setError(`删除笔记失败：${errText(e)}`);
        return false;
      }
    },
    [alive, reload],
  );

  return { notes, loading, error, setError, reload, createNote, removeNote };
}

export function useNoteDetail(noteId: number | null) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useAlive();

  const reload = useCallback(async () => {
    if (noteId == null) {
      setNote(null);
      setAnnotations([]);
      return;
    }
    setLoading(true);
    try {
      const n = await noteGet(noteId);
      const a = await annotationsList(noteId);
      if (alive.current) {
        setNote(n);
        setAnnotations(a);
        setError(null);
      }
    } catch (e) {
      if (alive.current) {
        setError(`读取笔记失败：${errText(e)}`);
        setNote(null);
        setAnnotations([]);
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [alive, noteId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 重新拉批注（写入后统一走这里，保证界面与库一致） */
  const refreshAnnotations = useCallback(async () => {
    if (noteId == null) return;
    try {
      const a = await annotationsList(noteId);
      if (alive.current) setAnnotations(a);
    } catch (e) {
      if (alive.current) setError(`读取批注失败：${errText(e)}`);
    }
  }, [alive, noteId]);

  /** 新增批注（锚点三件套由界面算出：块序号 + 块内偏移 + 原文片段） */
  const addAnnotation = useCallback(
    async (input: Omit<AnnotationAddInput, "targetId">): Promise<boolean> => {
      if (noteId == null) return false;
      setBusy(true);
      try {
        await annotationAdd({ ...input, targetId: noteId });
        await refreshAnnotations();
        if (alive.current) setError(null);
        return true;
      } catch (e) {
        if (alive.current) setError(`保存批注失败：${errText(e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [alive, noteId, refreshAnnotations],
  );

  const editAnnotation = useCallback(
    async (id: number, patch: { color?: string; comment?: string }): Promise<boolean> => {
      setBusy(true);
      try {
        await annotationUpdate(id, patch);
        await refreshAnnotations();
        if (alive.current) setError(null);
        return true;
      } catch (e) {
        if (alive.current) setError(`修改批注失败：${errText(e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [alive, refreshAnnotations],
  );

  const removeAnnotation = useCallback(
    async (id: number): Promise<boolean> => {
      setBusy(true);
      try {
        await annotationDelete(id);
        await refreshAnnotations();
        if (alive.current) setError(null);
        return true;
      } catch (e) {
        if (alive.current) setError(`删除批注失败：${errText(e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [alive, refreshAnnotations],
  );

  /** 改标题 / 正文（`note_update` 刻意不允许改 source 与导出记录） */
  const updateNote = useCallback(
    async (patch: { title?: string; contentMd?: string }): Promise<boolean> => {
      if (noteId == null) return false;
      setBusy(true);
      try {
        await noteUpdate(noteId, patch);
        await reload();
        if (alive.current) setError(null);
        return true;
      } catch (e) {
        if (alive.current) setError(`保存笔记失败：${errText(e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [alive, noteId, reload],
  );

  return {
    note,
    annotations,
    loading,
    busy,
    error,
    setError,
    reload,
    addAnnotation,
    editAnnotation,
    removeAnnotation,
    updateNote,
  };
}
