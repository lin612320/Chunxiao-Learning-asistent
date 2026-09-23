// 课程数据层：桌面走 Rust(SQLite courses 表)，浏览器预览降级到 data/sample.ts。
//
// 写入类操作（create / archive / delete）一律走 invokeStrict：
// 失败会抛出，由本层接住并放进 `error` 交给界面展示，绝不静默。

import { useCallback, useEffect, useState } from "react";
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

export function useCourses() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isTauri()) {
      const list = await callRust<Course[]>("courses_list");
      setCourses(Array.isArray(list) ? list : []);
    } else {
      setCourses(loadSampleDb().courses);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 新建课程：名称必填，学期/教师/简介选填（返回新课程 id；失败返回 null 并写 error） */
  const create = useCallback(
    async (input: CourseInput): Promise<number | null> => {
      const name = input.name.trim();
      if (!name) {
        setError("课程名称不能为空。");
        return null;
      }
      const term = input.term?.trim() ? input.term.trim() : null;
      const teacher = input.teacher?.trim() ? input.teacher.trim() : null;
      const intro = input.intro?.trim() ? input.intro.trim() : null;
      try {
        let id: number;
        if (isTauri()) {
          id = await invokeStrict<number>("course_create", { name, term, teacher, intro });
          await refresh();
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
          setCourses(db.courses);
        }
        setError(null);
        return id;
      } catch (e) {
        setError(`新建课程失败：${errText(e)}`);
        return null;
      }
    },
    [refresh],
  );

  /** 归档 / 取消归档 */
  const archive = useCallback(
    async (id: number, archived: boolean): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("course_archive", { id, archived });
          await refresh();
        } else {
          const db = loadSampleDb();
          db.courses = db.courses.map((c) => (c.id === id ? { ...c, archived: archived ? 1 : 0 } : c));
          saveSampleDb(db);
          setCourses(db.courses);
        }
        setError(null);
        return true;
      } catch (e) {
        setError(`归档操作失败：${errText(e)}`);
        return false;
      }
    },
    [refresh],
  );

  /** 删除课程（会连带删除该课程的先验知识与材料，界面上必须二次确认） */
  const remove = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("course_delete", { id });
          await refresh();
        } else {
          const db = loadSampleDb();
          db.courses = db.courses.filter((c) => c.id !== id);
          db.prior = db.prior.filter((p) => p.course_id !== id);
          db.materials = db.materials.filter((m) => m.course_id !== id);
          saveSampleDb(db);
          setCourses(db.courses);
        }
        setError(null);
        return true;
      } catch (e) {
        setError(`删除课程失败：${errText(e)}`);
        return false;
      }
    },
    [refresh],
  );

  /** 按 id 取单门课程（课程详情页用；数据来自列表，避免多写一个命令） */
  const findById = useCallback(
    (id: number): Course | undefined => courses.find((c) => c.id === id),
    [courses],
  );

  return { courses, loading, error, setError, refresh, create, archive, remove, findById };
}
