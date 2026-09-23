// M4 题库数据层：桌面走 Rust(SQLite knowledge_points / questions / attempts)，
// 浏览器预览（`!isTauri()`）降级到 `data/sample.ts` 的预览数据（增删改写 localStorage）。
//
// 契约：`docs/10-M4契约.md` §二 / §3.4；字段口径见 `docs/01-M0骨架契约.md` §四.1
//   · 命令**参数 camelCase**、DB 行**字段 snake_case**、空结果 `[]`；
//   · 写入类操作全走 `lib/questions.ts` 的 `invokeStrict` 封装 → 失败会抛，
//     本层接住并写进 `error` 交给界面展示，**绝不静默**（读操作同样用严格模式，
//     否则"读失败"会被谎报成"暂无记录"）；
//   · 预览模式的 `practice_pick` 用 `lib/questions.ts::orderPracticeQuestions` 复刻
//     Rust 的「未作答优先 → 知识点掌握度升序 → id 稳定」排序，便于两边对照。

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri, invokeStrict } from "../lib/tauri";
import {
  attemptRecord,
  attemptsList,
  bit,
  isWrongAttempt,
  kpList,
  kpSyncFromPrior,
  orderPracticeQuestions,
  practicePick,
  questionDelete,
  questionGet,
  questionsList,
  questionsSaveBatch,
  questionUpdate,
  type AttemptRecordInput,
  type KpSyncResult,
  type QType,
  type QuestionSaveInput,
  type QuestionUpdatePatch,
  type WeaknessKey,
} from "../lib/questions";
import {
  allocId,
  loadSampleDb,
  saveSampleDb,
  type AttemptItem,
  type KnowledgePointItem,
  type PriorItem,
  type QuestionItem,
} from "../data/sample";

/** 列表一次最多取多少条（前端筛选；到上限时界面会如实说明） */
export const QUESTIONS_LIST_LIMIT = 500;

/** 错题本一次最多取多少条 */
export const ATTEMPTS_LIST_LIMIT = 300;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 浏览器预览：把预览库拼成与 Rust 返回形状一致的"行"
// ---------------------------------------------------------------------------

/** 预览库的题目 + 本机统计（attempts / last_correct / kp_name），与 `questions_list` 对齐 */
function sampleQuestionRows(): QuestionItem[] {
  const db = loadSampleDb();
  const kpName = new Map<number, string>(db.knowledge_points.map((k) => [k.id, k.name]));
  return db.questions.map((q) => {
    const mine = db.attempts.filter((a) => a.question_id === q.id);
    const last = mine.length > 0 ? mine[mine.length - 1] : null;
    return {
      ...q,
      kp_name: q.kp_name ?? (q.kp_id != null ? (kpName.get(q.kp_id) ?? null) : null),
      attempts: mine.length,
      last_correct: last ? (bit(last.correct) ?? bit(last.self_eval)) : null,
    };
  });
}

/** 预览库的知识点 + 本机统计（与 `knowledge_points_list` 对齐，统计实时算，不写死） */
function sampleKnowledgePoints(courseId: number): KnowledgePointItem[] {
  const db = loadSampleDb();
  return db.knowledge_points
    .filter((k) => k.course_id === courseId)
    .map((k) => {
      const mine = db.questions.filter((q) => q.kp_id === k.id);
      const ids = new Set(mine.map((q) => q.id));
      const at = db.attempts.filter((a) => ids.has(a.question_id));
      return {
        ...k,
        question_count: mine.length,
        attempts: at.length,
        correct: at.filter((a) => bit(a.correct) === 1).length,
      };
    });
}

/** 某个知识点的弱项统计（预览模式的练习排序用） */
function sampleWeaknessOf(kpId: number | null | undefined): WeaknessKey {
  if (kpId == null) return { attempts: null, correct: null };
  const db = loadSampleDb();
  const ids = new Set(db.questions.filter((q) => q.kp_id === kpId).map((q) => q.id));
  const at = db.attempts.filter((a) => ids.has(a.question_id));
  return { attempts: at.length, correct: at.filter((a) => bit(a.correct) === 1).length };
}

/** 预览模式的 `knowledge_points_sync_from_prior`：先建父项、再建子项，同 `prior_id` 幂等 */
function sampleSyncFromPrior(courseId: number): KpSyncResult {
  const db = loadSampleDb();
  const priors = db.prior.filter((p) => p.course_id === courseId);
  const existing = new Map<number, number>(); // prior_id → kp id
  for (const k of db.knowledge_points) {
    if (k.course_id === courseId && k.prior_id != null) existing.set(k.prior_id, k.id);
  }

  const byId = new Map<number, PriorItem>(priors.map((p) => [p.id, p]));
  // 父项在前：先按先验知识的父子关系做一次稳定的拓扑排序
  const ordered: PriorItem[] = [];
  const seen = new Set<number>();
  const visit = (p: PriorItem, guard: number) => {
    if (seen.has(p.id) || guard > 50) return;
    const parent = p.parent_id != null ? byId.get(p.parent_id) : undefined;
    if (parent) visit(parent, guard + 1);
    if (seen.has(p.id)) return;
    seen.add(p.id);
    ordered.push(p);
  };
  for (const p of priors) visit(p, 0);

  let created = 0;
  for (const p of ordered) {
    if (existing.has(p.id)) continue;
    const id = allocId(db);
    const parentKpId = p.parent_id != null ? (existing.get(p.parent_id) ?? null) : null;
    db.knowledge_points.push({
      id,
      course_id: courseId,
      prior_id: p.id,
      name: p.topic,
      parent_id: parentKpId,
      question_count: 0,
      attempts: 0,
      correct: 0,
      created_at: nowStr(),
    });
    existing.set(p.id, id);
    created += 1;
  }
  saveSampleDb(db);
  return { created, total: db.knowledge_points.filter((k) => k.course_id === courseId).length };
}

/** 预览模式的 `attempts_list`：把题目原文 join 进来（错题本要直接展示） */
function sampleAttempts(args: {
  courseId: number | null;
  kpId: number | null;
  onlyWrong: boolean;
  limit: number;
}): AttemptItem[] {
  const db = loadSampleDb();
  const qById = new Map<number, QuestionItem>(sampleQuestionRows().map((q) => [q.id, q]));
  const rows = db.attempts
    .map((a) => {
      const q = qById.get(a.question_id);
      return {
        ...a,
        course_id: a.course_id ?? q?.course_id ?? null,
        kp_id: a.kp_id ?? q?.kp_id ?? null,
        kp_name: a.kp_name ?? q?.kp_name ?? null,
        stem: q?.stem ?? a.stem ?? null,
        qtype: q?.qtype ?? a.qtype ?? null,
        options: q?.options ?? a.options ?? null,
        answer: q?.answer ?? a.answer ?? null,
        explain: q?.explain ?? a.explain ?? null,
      } as AttemptItem;
    })
    .filter((a) => (args.courseId == null ? true : a.course_id === args.courseId))
    .filter((a) => (args.kpId == null ? true : a.kp_id === args.kpId))
    .filter((a) => (args.onlyWrong ? isWrongAttempt(a) : true));
  return rows.slice(0, Math.max(1, args.limit));
}

// ---------------------------------------------------------------------------
// 知识点
// ---------------------------------------------------------------------------

export interface UseKnowledgePoints {
  list: KnowledgePointItem[];
  loading: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => Promise<void>;
  /** 「从先验知识同步知识点」：返回 `{created, total}` 供界面**如实提示** */
  syncFromPrior: () => Promise<KpSyncResult | null>;
}

export function useKnowledgePoints(courseId: number | null): UseKnowledgePoints {
  const [list, setList] = useState<KnowledgePointItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (courseId == null) {
      setList([]);
      return;
    }
    setLoading(true);
    try {
      const rows = isTauri() ? await kpList(courseId) : sampleKnowledgePoints(courseId);
      setList(rows);
      setError(null);
    } catch (e) {
      setList([]);
      setError(`读取知识点失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const syncFromPrior = useCallback(async (): Promise<KpSyncResult | null> => {
    if (courseId == null) return null;
    try {
      const r = isTauri() ? await kpSyncFromPrior(courseId) : sampleSyncFromPrior(courseId);
      await reload();
      setError(null);
      return r;
    } catch (e) {
      setError(`同步知识点失败：${errText(e)}`);
      return null;
    }
  }, [courseId, reload]);

  return { list, loading, error, setError, reload, syncFromPrior };
}

// ---------------------------------------------------------------------------
// 题目列表（按知识点 / 题型 / 是否标记有问题筛选 + 人工校正 + 删除）
// ---------------------------------------------------------------------------

/**
 * 筛选口径说明：`questions_list` 只有 `courseId / kpId / limit` 三个参数，
 * 且 `kpId` 传 null 的含义（"不过滤"还是"未归类"）在契约里没有定义 ——
 * 所以这里**只按课程取一次（≤500 条），知识点 / 题型 / flawed 全部在前端筛**，
 * 结果可预期，也不会因为参数含义歧义而筛出空列表。
 */
export interface QuestionListFilter {
  courseId: number | null;
  /** 具体知识点；`unassigned` 为 true 时忽略它 */
  kpId: number | null;
  /** true = 只看「未归类到知识点」的题 */
  unassigned: boolean;
  qtype: QType | null;
  flawedOnly: boolean;
}

export interface UseQuestionList {
  /** 已筛选的行 */
  rows: QuestionItem[];
  /** 未筛选的行数（界面显示"共 N 道"） */
  loaded: number;
  /** 取到的行数已达上限（界面如实说明"只显示最近的 N 道"） */
  limitHit: boolean;
  /** 列表接口一条都没带 `flawed` 字段 → 「只看有问题」筛选不可用（界面如实说明） */
  flawedFieldMissing: boolean;
  loading: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => Promise<void>;
  /** 人工校正（`question_update`）：只提交要改的字段 */
  updateQuestion: (id: number, patch: QuestionUpdatePatch) => Promise<boolean>;
  /** 批量入库（`questions_save_batch`）：必须在用户点「确认入库」后调用 */
  saveBatch: (items: QuestionSaveInput[]) => Promise<number>;
  /** 删除（Rust 侧级联删 attempts） */
  removeQuestion: (id: number) => Promise<boolean>;
}

export function useQuestionList(filter: QuestionListFilter): UseQuestionList {
  const { courseId, kpId, unassigned, qtype, flawedOnly } = filter;
  const [all, setAll] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (courseId == null) {
      setAll([]);
      return;
    }
    setLoading(true);
    try {
      const rows = isTauri()
        ? await questionsList({ courseId, limit: QUESTIONS_LIST_LIMIT })
        : sampleQuestionRows().filter((q) => q.course_id === courseId);
      setAll(rows);
      setError(null);
    } catch (e) {
      setAll([]);
      setError(`读取题目失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo(
    () =>
      all.filter((q) => {
        if (unassigned) {
          if (q.kp_id != null) return false;
        } else if (kpId != null && q.kp_id !== kpId) {
          return false;
        }
        if (qtype != null && q.qtype !== qtype) return false;
        if (flawedOnly && bit(q.flawed) !== 1) return false;
        return true;
      }),
    [all, kpId, unassigned, qtype, flawedOnly],
  );

  const flawedFieldMissing = useMemo(
    () => all.length > 0 && all.every((q) => q.flawed === undefined),
    [all],
  );

  const updateQuestion = useCallback(
    async (id: number, patch: QuestionUpdatePatch): Promise<boolean> => {
      try {
        if (isTauri()) {
          await questionUpdate(id, patch);
        } else {
          const db = loadSampleDb();
          db.questions = db.questions.map((q) =>
            q.id === id
              ? {
                  ...q,
                  ...(patch.stem !== undefined ? { stem: patch.stem } : {}),
                  ...(patch.options !== undefined ? { options: patch.options } : {}),
                  ...(patch.answer !== undefined ? { answer: patch.answer } : {}),
                  ...(patch.explain !== undefined ? { explain: patch.explain } : {}),
                  ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
                  ...(patch.flawed !== undefined ? { flawed: patch.flawed ? 1 : 0 } : {}),
                }
              : q,
          );
          saveSampleDb(db);
        }
        await reload();
        setError(null);
        return true;
      } catch (e) {
        setError(`保存题目失败：${errText(e)}`);
        return false;
      }
    },
    [reload],
  );

  const saveBatch = useCallback(
    async (items: QuestionSaveInput[]): Promise<number> => {
      if (courseId == null) throw new Error("还没有选择课程。");
      if (items.length === 0) return 0;
      try {
        if (isTauri()) {
          const ids = await questionsSaveBatch(courseId, items);
          await reload();
          setError(null);
          return ids.length > 0 ? ids.length : items.length;
        }
        const db = loadSampleDb();
        for (const it of items) {
          db.questions.push({
            id: allocId(db),
            course_id: courseId,
            kp_id: it.kpId ?? null,
            kp_name: null,
            qtype: it.qtype,
            stem: it.stem,
            options: it.options ?? null,
            answer: it.answer,
            explain: it.explain ?? null,
            difficulty: it.difficulty ?? null,
            flawed: 0,
            source: it.source,
            source_ref: it.sourceRef ?? null,
            created_at: nowStr(),
            attempts: 0,
            last_correct: null,
          });
        }
        saveSampleDb(db);
        await reload();
        setError(null);
        return items.length;
      } catch (e) {
        setError(`入库失败：${errText(e)}`);
        throw e;
      }
    },
    [courseId, reload],
  );

  const removeQuestion = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        if (isTauri()) {
          await questionDelete(id);
        } else {
          const db = loadSampleDb();
          db.questions = db.questions.filter((q) => q.id !== id);
          // Rust 侧是级联删除；预览模式手动保持一致
          db.attempts = db.attempts.filter((a) => a.question_id !== id);
          saveSampleDb(db);
        }
        await reload();
        setError(null);
        return true;
      } catch (e) {
        setError(`删除题目失败：${errText(e)}`);
        return false;
      }
    },
    [reload],
  );

  return {
    rows,
    loaded: all.length,
    limitHit: all.length >= QUESTIONS_LIST_LIMIT,
    flawedFieldMissing,
    loading,
    error,
    setError,
    reload,
    updateQuestion,
    saveBatch,
    removeQuestion,
  };
}

// ---------------------------------------------------------------------------
// 错题本（attempts_list(onlyWrong: true)）
// ---------------------------------------------------------------------------

export interface AttemptListFilter {
  courseId: number | null;
  kpId: number | null;
  onlyWrong: boolean;
  limit?: number;
}

export interface UseAttemptList {
  rows: AttemptItem[];
  loading: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  reload: () => Promise<void>;
}

export function useAttemptList(filter: AttemptListFilter): UseAttemptList {
  const { courseId, kpId, onlyWrong } = filter;
  const limit = filter.limit ?? ATTEMPTS_LIST_LIMIT;
  const [rows, setRows] = useState<AttemptItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (courseId == null) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const list = isTauri()
        ? await attemptsList({ courseId, kpId, onlyWrong, limit })
        : sampleAttempts({ courseId, kpId, onlyWrong, limit });
      setRows(list);
      setError(null);
    } catch (e) {
      setRows([]);
      setError(`读取作答记录失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, [courseId, kpId, onlyWrong, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, setError, reload };
}

// ---------------------------------------------------------------------------
// 一次性动作（不构成 hook）：取全字段 / 取先验知识 / 选题 / 记录作答
// ---------------------------------------------------------------------------

/** `question_get(id)` 的全字段（人工校正面板用：列表接口不一定带 options 全文） */
export async function loadQuestionFull(id: number): Promise<QuestionItem> {
  if (isTauri()) return await questionGet(id);
  const row = sampleQuestionRows().find((q) => q.id === id);
  if (!row) throw new Error("这道题在预览数据里找不到了（可能已被删除）。");
  return row;
}

/** 读某门课的先验知识（出题时作为知识点摘要喂给模型）；读失败会抛，调用方要如实提示 */
export async function loadPriorList(courseId: number): Promise<PriorItem[]> {
  if (isTauri()) {
    const list = await invokeStrict<PriorItem[]>("prior_list", { courseId });
    return Array.isArray(list) ? list : [];
  }
  return loadSampleDb().prior.filter((p) => p.course_id === courseId);
}

export interface PickPracticeArgs {
  courseId: number;
  kpId?: number | null;
  count?: number;
}

/**
 * 取练习题。
 * 桌面版由 Rust `practice_pick` 排序（未作答优先 → 知识点掌握度升序 → id）；
 * 预览模式用同一个纯函数复刻该排序，保证两边行为可对照。
 */
export async function pickPracticeQuestions(args: PickPracticeArgs): Promise<QuestionItem[]> {
  const count = Math.max(1, Math.min(Math.round(args.count ?? 5), 50));
  if (isTauri()) {
    return await practicePick({ courseId: args.courseId, kpId: args.kpId ?? null, count });
  }
  let pool = sampleQuestionRows().filter((q) => q.course_id === args.courseId);
  if (args.kpId != null) pool = pool.filter((q) => q.kp_id === args.kpId);
  return orderPracticeQuestions(pool, (q) => sampleWeaknessOf(q.kp_id)).slice(0, count);
}

/**
 * 按题目 id 取回完整题目（「重练错题」用：错题记录里只有题干，选择题还需要 options）。
 * 先一次性取该课程的题目列表再在本地匹配 —— 不给后端添 N 次 IPC。
 */
export async function loadQuestionsByIds(
  courseId: number | null,
  ids: number[],
): Promise<{ rows: QuestionItem[]; missing: number }> {
  const wanted = Array.from(new Set(ids.filter((n) => Number.isFinite(n))));
  if (wanted.length === 0) return { rows: [], missing: 0 };
  const pool = isTauri()
    ? await questionsList({
        courseId: courseId ?? null,
        limit: Math.max(QUESTIONS_LIST_LIMIT, wanted.length),
      })
    : sampleQuestionRows();
  const byId = new Map<number, QuestionItem>(pool.map((q) => [q.id, q]));
  const rows: QuestionItem[] = [];
  let missing = 0;
  for (const id of wanted) {
    const q = byId.get(id);
    if (q) rows.push(q);
    else missing += 1;
  }
  return { rows, missing };
}

/** 记录一次作答（客观题带 `correct`；主观题带 `selfEval`） */
export async function recordAttempt(input: AttemptRecordInput): Promise<number> {
  if (isTauri()) return await attemptRecord(input);
  const db = loadSampleDb();
  const q = db.questions.find((x) => x.id === input.questionId);
  const id = allocId(db);
  db.attempts.push({
    id,
    question_id: input.questionId,
    course_id: q?.course_id ?? null,
    kp_id: q?.kp_id ?? null,
    user_answer: input.userAnswer ?? null,
    correct: input.correct == null ? null : input.correct ? 1 : 0,
    self_eval: input.selfEval ?? null,
    duration_ms: input.durationMs ?? null,
    confidence: input.confidence ?? null,
    created_at: nowStr(),
  });
  saveSampleDb(db);
  return id;
}
