// 课程数据层：桌面走 Rust(SQLite courses 表)，浏览器预览降级到 data/sample.ts。
//
// 写入类操作（create / archive / delete）一律走 invokeStrict：
// 失败会抛出，由本层接住并放进 `error` 交给界面展示，绝不静默。
//
// ---------------------------------------------------------------------------
// R12：课程列表改成**全应用唯一的共享存储**（修「建课后课程选择不更新」）
// ---------------------------------------------------------------------------
// 缺陷现场：本文件原来是一个**普通 hook**，内部 `useState` 持有课程数组。
// 于是每一处 `useCourses()` 调用都会拿到**自己那一份独立副本**，各自 mount 时拉一次：
//   `Sidebar` / `Topbar` / `useChat` / `useProfile` / `Assistant` / `Course` /
//   `Courses` / `Notes` / `Questions` —— 共 **10 份副本**。
// 在课程列表页新建课程时，只有**发起写入的那一份**会 `refresh()`；
// `Sidebar` 的课程选择器与 `Topbar` 的当前课程胶囊是常驻组件（`Layout` 不重挂载），
// 它们的副本**到下次整页刷新前永远不会更新** —— 用户看到的现象就是
// 「建完课，左上角的课程选择里没有这门课」。
//
// 这与 R9 修过的「同一个课程上下文被四个页面各写一遍」是**同一类错误**：
// 把"唯一事实来源"写进契约 ≠ 它真的唯一（见 `docs/20` §2）。处置不是"以后注意"，
// 而是**从数据结构上让它不可能再分叉**：模块级单例 + `useSyncExternalStore` 订阅。
// 副作用是启动时的 IPC 调用从 10 次降到 1 次。

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { callRust, invokeStrict, isTauri } from "../lib/tauri";
import { allocId, loadSampleDb, saveSampleDb, type Course } from "../data/sample";

export interface CourseInput {
  name: string;
  term?: string;
  teacher?: string;
  intro?: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 模块级存储（单例）
// ---------------------------------------------------------------------------

interface CoursesSnapshot {
  courses: Course[];
  loading: boolean;
  error: string | null;
}

/**
 * `useSyncExternalStore` 要求 `getSnapshot` 返回**引用稳定**的值：
 * 每次 render 返回新对象会被判定为"变了"，从而无限重渲染。
 * 所以这里只维护**一个** snapshot 对象，仅在真正改变时替换。
 */
let snapshot: CoursesSnapshot = { courses: [], loading: true, error: null };

const listeners = new Set<() => void>();

function emit(next: Partial<CoursesSnapshot>): void {
  const merged = { ...snapshot, ...next };
  // 三个字段都没变就不通知，避免无意义的重渲染
  if (
    merged.courses === snapshot.courses &&
    merged.loading === snapshot.loading &&
    merged.error === snapshot.error
  ) {
    return;
  }
  snapshot = merged;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CoursesSnapshot {
  return snapshot;
}

/** 正在进行的加载（并发去重：10 个组件同时挂载也只会发一次 IPC） */
let inflight: Promise<void> | null = null;

/** 请求序号：迟到的旧请求不许覆盖新结果（"最新一次说了算"） */
let seq = 0;

async function load(): Promise<void> {
  const my = ++seq;
  let result: Course[] | null = null;
  if (isTauri()) {
    // ⚠ `callRust` 失败时返回 null（它吞错误，见 lib/tauri.ts）。
    // 单例存储下必须**区分「真的空列表」与「这次没取到」**：
    // 原来每个组件各存一份时，一次失败只影响自己；现在若把 null 也当成空数组，
    // 一次瞬时 IPC 失败就会把全应用的课程列表抹成空。取到数组才替换。
    const list = await callRust<Course[]>("courses_list");
    if (Array.isArray(list)) result = list;
  } else {
    result = loadSampleDb().courses;
  }
  // 期间又发了新请求 → 这次的结果已经过时，直接丢弃
  if (my !== seq) return;
  if (result) emit({ courses: result });
  emit({ loading: false });
}

/**
 * 拉取课程列表。
 * @param force 写入之后调用：**必然**读到写入后的状态 —— 不能复用可能在写入前就已发出的
 *              在途请求（否则「刚建的课」会被那次旧读取的结果盖掉，就是本轮要修的那个坑）。
 */
export function refreshCourses(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  const p = load().finally(() => {
    // 只有"自己仍是最新的那次"才清空句柄，避免把后来者的句柄清掉
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

// ---------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------

/**
 * 读取课程列表。**所有调用方共享同一份数据**，任一处写入后全应用同步可见。
 *
 * 返回值与改造前保持一致（`courses / loading / error / setError / refresh /
 * create / archive / remove / findById`），所以调用方无需改动。
 */
export function useCourses() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { courses, loading, error } = snap;

  // 挂载即拉一次（并发去重：同一时刻多处挂载只发一次 IPC）；
  // 数据本身是共享的，所以这里的作用是"保持新鲜"，不再需要每个组件各存一份。
  useEffect(() => {
    void refreshCourses();
  }, []);

  /** 新建课程：名称必填，学期/教师/简介选填（返回新课程 id；失败返回 null 并写 error） */
  const create = useCallback(
    async (input: CourseInput): Promise<number | null> => {
      const name = input.name.trim();
      if (!name) {
        emit({ error: "课程名称不能为空。" });
        return null;
      }
      const term = input.term?.trim() ? input.term.trim() : null;
      const teacher = input.teacher?.trim() ? input.teacher.trim() : null;
      const intro = input.intro?.trim() ? input.intro.trim() : null;
      try {
        let id: number;
        if (isTauri()) {
          id = await invokeStrict<number>("course_create", { name, term, teacher, intro });
          await refreshCourses(true);
        } else {
          const db = loadSampleDb();
          id = allocId(db);
          db.courses.unshift({
            id,
            name,
            term,
            teacher,
            intro,
            cover: null,
            archived: 0,
            created_at: nowStr(),
          });
          saveSampleDb(db);
          emit({ courses: db.courses });
        }
        emit({ error: null });
        return id;
      } catch (e) {
        emit({ error: `新建课程失败：${errText(e)}` });
        return null;
      }
    },
    [],
  );

  /** 归档 / 取消归档 */
  const archive = useCallback(
    async (id: number, archived: boolean): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("course_archive", { id, archived });
          await refreshCourses(true);
        } else {
          const db = loadSampleDb();
          db.courses = db.courses.map((c) => (c.id === id ? { ...c, archived: archived ? 1 : 0 } : c));
          saveSampleDb(db);
          emit({ courses: db.courses });
        }
        emit({ error: null });
        return true;
      } catch (e) {
        emit({ error: `归档操作失败：${errText(e)}` });
        return false;
      }
    },
    [],
  );

  /** 删除课程（会连带删除该课程的先验知识与材料，界面上必须二次确认） */
  const remove = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("course_delete", { id });
          await refreshCourses(true);
        } else {
          const db = loadSampleDb();
          db.courses = db.courses.filter((c) => c.id !== id);
          db.prior = db.prior.filter((p) => p.course_id !== id);
          db.materials = db.materials.filter((m) => m.course_id !== id);
          saveSampleDb(db);
          emit({ courses: db.courses });
        }
        emit({ error: null });
        return true;
      } catch (e) {
        emit({ error: `删除课程失败：${errText(e)}` });
        return false;
      }
    },
    [],
  );

  /**
   * 清空 / 设置错误（课程列表页的提示条点击后调 `setError(null)`）。
   * 契约保持：签名接受 `string | null`。
   */
  const setError = useCallback((text: string | null) => {
    emit({ error: text });
  }, []);

  /** 按 id 取单门课程（课程详情页用；数据来自列表，避免多写一个命令） */
  const findById = useCallback(
    (id: number): Course | undefined => courses.find((c) => c.id === id),
    [courses],
  );

  return {
    courses,
    loading,
    error,
    setError,
    refresh: refreshCourses,
    create,
    archive,
    remove,
    findById,
  };
}
