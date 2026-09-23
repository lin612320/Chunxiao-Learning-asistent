// 对话的**课程上下文**口径（契约 `docs/11-R1对话课程归属与先验知识提炼契约.md` §3.1 / §3.2）。
//
// 三条红线（§一）在这里落地成可复用的纯函数 + 常量，供对话页（`views/Assistant.tsx`）
// 与课程页共用：
//   1. 归属是用户的**显式选择**：`/assistant?course=N` 才是课程上下文；
//      `/assistant` 无参数**就是不限定课程**。最近使用的课程只用于一条**可选**提示条，
//      **绝不自动改变检索范围**（§一 第 3 条）。
//   2. **检索范围必须与界面所写一致**：界面显示的范围（`scopeTextOf`）与实际送给
//      `material_search` 的范围（`useChat.send` 里的 `effectiveScope`）**同源**，
//      不允许"界面写全库、实际按某课检索"。
//   3. 失败不静默：本文件不做写入，写库失败由 `useChat` 的 `error` 状态呈现。
//
// 本文件只有纯函数与常量：不调 Rust、不读 React state。
// 唯一的副作用是 `localStorage` 偏好读写（沿用既有约定 `chunxiao:focus`、
// `chunxiao:notes-export-dir`，见 `lib/focus.ts` / `lib/notes.ts`）。

/** 最近一次**显式选择**的课程上下文（契约 §3.1 固定为 `chunxiao:last-course-id`） */
export const LS_LAST_COURSE = "chunxiao:last-course-id";

/** 对话页路径与查询参数名（`?course=N` / `?float=1`） */
export const ASSISTANT_PATH = "/assistant";
export const COURSE_PARAM = "course";
export const FLOAT_PARAM = "float";

/** 两个选择器里「不限定课程」的选项文案（共用一处，避免两处措辞漂移） */
export const NO_COURSE_LABEL = "不限定课程";

/**
 * 没有任何课程上下文时**必须照旧写明**的检索范围文案（契约 §一 第 2 条 / §3.2）。
 * 逐字保留既有诚实口径，不许弱化：界面写全库，检索就必须是**本机全库**。
 */
export const SCOPE_ALL_TEXT = "检索范围：全部课程材料（本机全库）";

/** 课程的最小结构（`data/sample.ts` 的 `Course` 结构上兼容，这里不反向依赖它） */
export interface CourseRef {
  id: number;
  name: string;
  /** 0 | 1：归档课程**也要**能出现在选择器里（契约 §3.2） */
  archived?: number;
}

/** 检索范围的来源：`session` = 当前会话归属；`url` = URL 课程上下文；`null` = 都没有（全库） */
export type ScopeOrigin = "session" | "url" | null;

/**
 * 把任意输入收敛成合法的课程 id：只接受**十进制正整数**（课程 id 从 1 开始，Rust 自增主键）。
 * `0` / 负数 / 小数 / `"abc"` / 空串 / null / undefined 一律 → null。
 * **不做**"猜一个接近的 id"这种兜底：那会让界面写 A 课、实际查 B 课（§一 第 2 条）。
 */
function normalizeCourseId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 解析 URL search 里的 `course`：合法 → 课程 id；缺省 / 非法 → `null`（= 不限定课程）。
 * 容错到"返回 null"这一种结果，不抛异常（`useLocation().search` 可能为空串）。
 */
export function parseCourseParam(search: string): number | null {
  try {
    return normalizeCourseId(new URLSearchParams(search).get(COURSE_PARAM));
  } catch {
    return null;
  }
}

/** `?float=1` 判定（既有冻结行为：只认字面 `"1"`，其它一律 false） */
export function parseFloatParam(search: string): boolean {
  try {
    return new URLSearchParams(search).get(FLOAT_PARAM) === "1";
  } catch {
    return false;
  }
}

/**
 * 构造对话页路径：有课程 → `/assistant?course=N`；无课程 → `/assistant`（不限定课程）。
 * `opts.float = true` 时**保留** `?float=1`（契约 §五 第 1 条：既有冻结行为，即使当前无调用方）。
 * 只输出这两个参数：不把其它查询串带进对话页路由，避免 URL 上出现"说不清含义"的残留。
 */
export function assistantPath(courseId: number | null, opts: { float?: boolean } = {}): string {
  const qs = new URLSearchParams();
  const id = normalizeCourseId(courseId);
  if (id != null) qs.set(COURSE_PARAM, String(id));
  if (opts.float) qs.set(FLOAT_PARAM, "1");
  const q = qs.toString();
  return q ? `${ASSISTANT_PATH}?${q}` : ASSISTANT_PATH;
}

/**
 * 读「最近一次显式选择的课程」。
 * 缺省 / 损坏 / 非法值一律 null —— 拿不准就当没有，**绝不**用近似值顶替。
 */
export function readLastCourseId(): number | null {
  try {
    return normalizeCourseId(localStorage.getItem(LS_LAST_COURSE));
  } catch {
    return null;
  }
}

/**
 * 记「最近一次显式选择的课程」。
 * - `id = null`（用户显式选了「不限定课程」）→ **清掉**该键：最近课程只记"课程"，
 *   不把一个"不限定"当成课程上下文留着；
 * - localStorage 不可用（隐私模式 / 配额）→ 静默跳过：只影响这条可选提示，不影响检索范围与归属。
 */
export function rememberLastCourseId(id: number | null): void {
  try {
    const valid = normalizeCourseId(id);
    if (valid == null) localStorage.removeItem(LS_LAST_COURSE);
    else localStorage.setItem(LS_LAST_COURSE, String(valid));
  } catch {
    /* 见上：只影响"记住上次课程" */
  }
}

/** 课程显示名：列表里有就用名字；不在列表里（已删除 / 列表未加载完）→ `课程 #N`，不张冠李戴 */
export function courseLabel(courseId: number, courses: readonly CourseRef[]): string {
  return courses.find((c) => c.id === courseId)?.name ?? `课程 #${courseId}`;
}

/**
 * 选择器里的选项文案：归档课程也要能显示出来，并标出「已归档」，
 * 免得用户看到一个和课程页不一样的名字、又不知道它已被归档（契约 §3.2）。
 */
export function courseOptionLabel(c: CourseRef): string {
  return c.archived ? `${c.name}（已归档）` : c.name;
}

/**
 * **有效检索课程**：当前会话归属优先，其次 URL 课程上下文（契约 §3.2）。
 * - 会话归属非空 → 用会话归属（`origin: "session"`）；
 * - 会话归属为 null（这个会话就是"不限定课程"）→ 回落到 URL 课程上下文（`origin: "url"`）；
 * - 两者都没有 → `null` = 全库（`origin: null`）。
 *
 * ⚠ 界面文案与 `useChat.send` 的实际检索**必须**都走这个函数：
 * 两边各写一套 `?? ` 表达式，正是"界面写全库、实际串课"这类缺陷的温床。
 */
export function effectiveScope(
  sessionCourseId: number | null | undefined,
  urlCourseId: number | null,
): { courseId: number | null; origin: ScopeOrigin } {
  const own = normalizeCourseId(sessionCourseId);
  if (own != null) return { courseId: own, origin: "session" };
  const url = normalizeCourseId(urlCourseId);
  if (url != null) return { courseId: url, origin: "url" };
  return { courseId: null, origin: null };
}

/**
 * 检索范围文案（§一 第 2 条：界面写什么，就必须按什么查）。
 * - 无有效课程 → **逐字** `SCOPE_ALL_TEXT`（既有诚实口径，不弱化、不删）；
 * - 有课程 → 写明课程名，并注明范围从哪来（会话归属 / URL 上下文），
 *   让用户一眼看出"现在到底在搜哪门课、以及为什么是它"。
 */
export function scopeTextOf(
  effectiveCourseId: number | null,
  courses: readonly CourseRef[],
  origin: ScopeOrigin,
): string {
  if (effectiveCourseId == null) return SCOPE_ALL_TEXT;
  const suffix =
    origin === "session" ? "（当前会话归属）" : origin === "url" ? "（当前课程上下文）" : "";
  return `检索范围：${courseLabel(effectiveCourseId, courses)}${suffix}`;
}
