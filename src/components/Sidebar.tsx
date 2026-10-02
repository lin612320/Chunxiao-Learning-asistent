import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import Mascot from "./Mascot";
import Icon, { type IconName } from "./Icon";
import { useCourses } from "../hooks/useCourses";
import { ballSyncCourse } from "../lib/ball";
import maidUrl from "../assets/mascot-maid.webp";
import { COURSE_PARAM, parseCourseParam, readLastCourseId, rememberLastCourseId } from "../lib/courseScope";
import { courseOptionLabel } from "../lib/courseScope";

/**
 * 左侧导航（R6：改成**课程优先**）。
 *
 * 用户要的结构是「先选课程，在课程里面显示笔记、题库、对话、学习画像」，
 * 所以侧栏分两态：
 *   · **全部课程** —— 课程列表 + 跨课程的笔记 / 题库 / 画像；
 *   · **某门课**   —— 该课的：课程总览 / 笔记 / 题库 / 与该课对话 / 学习画像。
 * 切换用顶部那个课程选择器；切换时**保留当前版块**（在「笔记」里换课程 → 还是「笔记」）。
 *
 * 「当前课程」的单一事实来源：`?course=N`（URL）优先，其次 `localStorage`
 * （沿用 R1 的 `chunxiao:last-course-id`，与对话页同一套口径，不另造一个状态）。
 *
 * R14：加两个入口 —— ①「手写笔记」（触控笔页）；②窄屏下点完导航**自动收起抽屉**
 *   （`onNavigate` 由 `Layout` 传入；宽屏下它什么都不做，因为那时侧栏是常驻的）。
 */
export default function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const { courses, loading } = useCourses();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();

  const urlCourseId = parseCourseParam(search);
  const [activeId, setActiveId] = useState<number | null>(() => urlCourseId ?? readLastCourseId());

  // URL 带 course= → 以 URL 为准（深链接 / 新标签页也能带上下文），并记住它
  useEffect(() => {
    if (urlCourseId != null) {
      setActiveId(urlCourseId);
      rememberLastCourseId(urlCourseId);
    }
  }, [urlCourseId]);

  // 课程被删 / 换了库：不能留一个指向不存在课程的选中态（否则界面写着 A 课、实际什么都没有）
  useEffect(() => {
    if (loading) return;
    setActiveId((cur) => (cur != null && !courses.some((c) => c.id === cur) ? null : cur));
  }, [loading, courses]);

  /**
   * R7：把「主窗口当前课程」同步给悬浮球 —— 球默认跟随它检索（含「全部课程」）。
   *
   * 为什么：球的检索范围原本是球自己独立的设置，默认「不限定课程」，
   * 于是用户在《数据库系统》里划词点「关联知识点」，实际是**全库检索**，
   * 而按钮提示写着「先在这门课的材料 / 先验知识 / 知识点里查」—— 界面与实际不一致。
   *
   * ⚠ 必须**等课程列表读完**再同步：否则首帧会把球的范围白白重置一次。
   * ⚠ 桌面版才有意义（球是外部进程）；浏览器预览由 `ballSyncCourse` 静默跳过。
   */
  useEffect(() => {
    if (loading) return;
    void ballSyncCourse(activeId);
  }, [activeId, loading]);

  const active = activeId != null ? courses.find((c) => c.id === activeId) : undefined;

  /** 带课程上下文的路径（未选课程时保持原样） */
  const withCourse = useCallback(
    (path: string) => (activeId == null ? path : `${path}?${COURSE_PARAM}=${activeId}`),
    [activeId],
  );

  /** 切换课程：**留在当前版块**，只改 URL 上的课程参数 */
  const onSelectCourse = useCallback(
    (raw: string) => {
      const id = raw ? Number(raw) : null;
      setActiveId(id);
      rememberLastCourseId(id);
      const qs = new URLSearchParams(search);
      if (id == null) qs.delete(COURSE_PARAM);
      else qs.set(COURSE_PARAM, String(id));
      const q = qs.toString();
      navigate(`${pathname}${q ? `?${q}` : ""}`, { replace: true });
    },
    [navigate, pathname, search],
  );

  const item = (to: string, icon: IconName, label: string, end = false) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
      title={label}
      onClick={onNavigate}
    >
      <Icon name={icon} className="nav-icon" />
      <span className="nav-label">{label}</span>
    </NavLink>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        {/* 品牌标记 = **迷你 App 图标**：装的就是吉祥物母版，与 exe / favicon 同一形象 */}
        <span className="brand-mark">
          <Mascot size={32} />
        </span>
        <span>
          <span className="brand-name">春晓</span>
          <span className="brand-sub">学习助手</span>
        </span>
      </div>

      {/* 课程选择器：整个侧栏的入口。选了课，下面就是"这门课的功能"。 */}
      <div className="course-picker">
        <select
          value={activeId ?? ""}
          onChange={(e) => onSelectCourse(e.target.value)}
          title="选择一门课程：下面的版块都只属于它"
          aria-label="选择课程"
        >
          <option value="">全部课程</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {courseOptionLabel(c)}
            </option>
          ))}
        </select>
      </div>

      <nav className="nav">
        <div className="nav-group">{active ? active.name : "全部课程"}</div>
        {active ? (
          <>
            {item(`/course/${active.id}`, "book", "课程总览", true)}
            {item(withCourse("/notes"), "note", "笔记")}
            {/* R14：触控笔手写（平板优先的入口，与「笔记」并列 —— 它们是同一层级的两种记法） */}
            {item(withCourse("/handwrite"), "pen", "手写笔记")}
            {/* R13：用户要求「在侧栏添加一个相关材料，点击材料可以直接打开」 */}
            {item(withCourse("/materials"), "folder", "相关材料")}
            {item(withCourse("/questions"), "help", "题库")}
            {item(withCourse("/assistant"), "chat", "与该课对话")}
            {item(withCourse("/profile"), "chart", "学习画像")}
          </>
        ) : (
          <>
            {item("/courses", "book", "课程列表")}
            {item("/notes", "note", "全部笔记")}
            {item("/handwrite", "pen", "手写笔记")}
            {item("/materials", "folder", "相关材料")}
            {item("/questions", "help", "全部题库")}
            {item("/profile", "chart", "学习画像")}
          </>
        )}

        <div className="nav-group">其他</div>
        {item("/focus", "timer", "专注计时")}
        {item("/settings", "gear", "数据设置")}
      </nav>

      {/* R11：页边「云鲸女仆」（皮肤原文的 mascot：固定在左缘底部，装饰性 → alt 留空）。
          纯装饰，`pointer-events: none`（见 styles.css），不会挡住导航点击。 */}
      <img className="sidebar-mascot" src={maidUrl} alt="" aria-hidden="true" draggable={false} />

      <div className="sidebar-foot">
        <Icon name="lock" />
        <span>本地单机 · 数据保存在本机</span>
      </div>
    </aside>
  );
}
