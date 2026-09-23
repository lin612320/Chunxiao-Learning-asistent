// 学习画像数据层（M4 契约 docs/10-M4契约.md §2.4 / §3.2）。
//
// 职责边界：
//   · 读：`profile_overview` 一次拿齐（掌握度 / 弱项 / 样本不足 / 自述缺漏 / 偏好）——
//     M3 的 T20 教训是"别用 N 次 IPC 拼一页"，这里只发一次统计查询 + 一次知识点查询；
//     知识点列表（自述缺漏的勾选/录入）走 `knowledge_points_list`。
//   · 写：`profile_trait_set` / `knowledge_point_save` 一律 invokeStrict，失败抛可读中文错误，
//     由本层接住放进 `error` 交给界面展示，**绝不静默**。
//
// 口径红线（契约 §一）守在本层，不指望页面自觉：
//   1. `evidence < min_evidence` 的条目**无论后端放在哪个分组**，一律不进结论、不进弱项榜，
//      统一落进 `insufficient`（灰态）——`guardedCount` 如实记录被守卫拦下的条数；
//   2. 结论行必须成对提供 `mastery` 与 `evidence`（页面照此渲染，不额外算数）；
//   3. 预览模式（!isTauri()）读的是 lib/profile.ts 的内置示例数据，界面会明确标注；
//      写入在预览模式必然失败，错误照原样展示（"仅桌面版可用"），**不假装保存成功**。

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "../lib/tauri";
import { useCourses } from "./useCourses";
import {
  knowledgePointSave,
  knowledgePointsList,
  MIN_EVIDENCE_FALLBACK,
  profileOverview,
  profileTraitSet,
  type KnowledgePoint,
  type ProfileKpStat,
  type ProfileOverview,
  type ProfileTraitRow,
  type TraitInput,
} from "../lib/profile";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 同一个知识点的去重键：kp_id 可能为 null（未挂知识点的条目） */
function rowKey(r: ProfileKpStat): string {
  return r.kp_id != null ? `kp:${r.kp_id}` : `name:${r.kp_name}`;
}

/** 掌握度升序（null 排最后）；同一后端排序口径，用于弱项榜的稳定呈现 */
function byMasteryAsc(a: ProfileKpStat, b: ProfileKpStat): number {
  const am = a.mastery;
  const bm = b.mastery;
  if (am == null && bm == null) return a.kp_name.localeCompare(b.kp_name);
  if (am == null) return 1;
  if (bm == null) return -1;
  if (am !== bm) return am - bm;
  return a.kp_name.localeCompare(b.kp_name);
}

export interface UseProfileResult {
  /** 课程列表（画像按课程统计，必须先选课程） */
  courses: ReturnType<typeof useCourses>["courses"];
  coursesLoading: boolean;
  courseId: number | null;
  setCourseId: (id: number | null) => void;
  overview: ProfileOverview | null;
  loading: boolean;
  /** 桌面端读不到画像：与"该课程确实还没有记录"是两回事，界面必须分别措辞 */
  loadFailed: boolean;
  /** 该课程确实一条画像数据都没有（空画像，不是失败） */
  isEmpty: boolean;
  /** 样本不足阈值（来自后端 `min_evidence`，读不到时兜底 3） */
  minEvidence: number;
  /** 有效结论：每条都带 mastery 与 evidence（样本数） */
  conclusions: ProfileKpStat[];
  /** 弱项榜：mastery 升序前 10，每条必带 evidence */
  weakPoints: ProfileKpStat[];
  /** 灰态：样本不足，**不给掌握度数字** */
  insufficient: ProfileKpStat[];
  /** 前端口径守卫拦下的条数（>0 说明后端把样本不足的条目混进了结论，已移入灰态） */
  guardedCount: number;
  /** 用户自述缺漏（"你说的"，与统计结论分区展示） */
  declaredGaps: ProfileTraitRow[];
  /** 偏好与风格（本机录入） */
  preferences: ProfileTraitRow[];
  /** 该课程的知识点（自述缺漏勾选用） */
  knowledgePoints: KnowledgePoint[];
  error: string | null;
  setError: (v: string | null) => void;
  saving: boolean;
  refresh: () => Promise<void>;
  /** 写一条画像特征（自述缺漏 / 偏好 / 风格） */
  saveTrait: (input: TraitInput) => Promise<boolean>;
  /** 勾选 / 取消「我薄弱（自述）」：value=1 标记，value=0 取消 */
  markDeclared: (kpId: number, marked: boolean) => Promise<boolean>;
  /** 录入一个知识点并标记为自述薄弱（列表里没有的知识点用） */
  addDeclaredGap: (name: string) => Promise<boolean>;
}

export function useProfile(): UseProfileResult {
  const { courses, loading: coursesLoading } = useCourses();

  const [courseId, setCourseId] = useState<number | null>(null);
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [knowledgePoints, setKnowledgePoints] = useState<KnowledgePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 课程加载完后默认选第一门未归档的课程（没有未归档的就选第一门）
  useEffect(() => {
    if (courseId != null || courses.length === 0) return;
    const first = courses.find((c) => c.archived !== 1) ?? courses[0];
    setCourseId(first.id);
  }, [courses, courseId]);

  const refresh = useCallback(async () => {
    if (courseId == null) {
      setOverview(null);
      setKnowledgePoints([]);
      setLoadFailed(false);
      return;
    }
    setLoading(true);
    try {
      const ov = await profileOverview(courseId);
      const kps = await knowledgePointsList(courseId);
      setOverview(ov);
      setKnowledgePoints(kps);
      // 桌面端却拿不到画像对象 → 读取失败（区分于"该课程还没有记录"）
      setLoadFailed(isTauri() && ov === null);
    } catch (e) {
      // callRust 已吞掉命令异常；这里只兜底意料之外的错误
      setOverview(null);
      setKnowledgePoints([]);
      setLoadFailed(true);
      console.error("[profile] 读取学习画像失败：", e);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // 红线守卫：算给页面看之前，先把样本不足的条目摘出去
  // ---------------------------------------------------------------------------

  const minEvidence = overview?.min_evidence ?? MIN_EVIDENCE_FALLBACK;

  const grouped = useMemo(() => {
    const empty = {
      conclusions: [] as ProfileKpStat[],
      weakPoints: [] as ProfileKpStat[],
      insufficient: [] as ProfileKpStat[],
      guardedCount: 0,
    };
    if (!overview) return empty;

    const enough = (r: ProfileKpStat) => r.evidence >= minEvidence;
    const conclusions = overview.mastery.filter(enough);
    const weakPoints = [...overview.weak_points].filter(enough).sort(byMasteryAsc).slice(0, 10);

    // 灰态：后端给的 not_enough + 被守卫从结论/弱项里摘出来的
    const grayMap = new Map<string, ProfileKpStat>();
    for (const r of overview.not_enough) grayMap.set(rowKey(r), r);
    let guardedCount = 0;
    for (const r of [...overview.mastery, ...overview.weak_points]) {
      if (enough(r)) continue;
      guardedCount += 1;
      grayMap.set(rowKey(r), r);
    }
    return {
      conclusions,
      weakPoints,
      insufficient: [...grayMap.values()].sort((a, b) => a.attempts - b.attempts),
      guardedCount,
    };
  }, [overview, minEvidence]);

  const isEmpty =
    !loading &&
    overview !== null &&
    grouped.conclusions.length === 0 &&
    grouped.insufficient.length === 0 &&
    overview.declared_gaps.length === 0 &&
    overview.preferences.length === 0;

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  const saveTrait = useCallback(
    async (input: TraitInput): Promise<boolean> => {
      try {
        setSaving(true);
        await profileTraitSet(input);
        setError(null);
        await refresh();
        return true;
      } catch (e) {
        setError(`保存画像特征失败：${errText(e)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const markDeclared = useCallback(
    async (kpId: number, marked: boolean): Promise<boolean> => {
      // 自述缺漏没有统计样本：evidence 传 null，绝不编一个样本数出来
      return saveTrait({ kpId, trait: "weakness_self", value: marked ? 1 : 0, evidence: null });
    },
    [saveTrait],
  );

  const addDeclaredGap = useCallback(
    async (name: string): Promise<boolean> => {
      if (courseId == null) {
        setError("请先选择课程。");
        return false;
      }
      const trimmed = name.trim();
      if (!trimmed) {
        setError("请输入知识点名称。");
        return false;
      }
      try {
        setSaving(true);
        const id = await knowledgePointSave(courseId, trimmed);
        // 录入完立刻标成"我薄弱"；同名已存在时后端返回既有 id，不会重复建
        await profileTraitSet({ kpId: id, trait: "weakness_self", value: 1, evidence: null });
        setError(null);
        await refresh();
        return true;
      } catch (e) {
        setError(`录入薄弱知识点失败：${errText(e)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [courseId, refresh],
  );

  return {
    courses,
    coursesLoading,
    courseId,
    setCourseId,
    overview,
    loading,
    loadFailed,
    isEmpty,
    minEvidence,
    conclusions: grouped.conclusions,
    weakPoints: grouped.weakPoints,
    insufficient: grouped.insufficient,
    guardedCount: grouped.guardedCount,
    declaredGaps: overview?.declared_gaps ?? [],
    preferences: overview?.preferences ?? [],
    knowledgePoints,
    error,
    setError,
    saving,
    refresh,
    saveTrait,
    markDeclared,
    addDeclaredGap,
  };
}
