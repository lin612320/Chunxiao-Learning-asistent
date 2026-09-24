import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useCurrentPage } from "../nav";
import { ballShow } from "../lib/ball";
import { useCourses } from "../hooks/useCourses";
import { parseCourseParam } from "../lib/courseScope";
import { applyTheme, readStoredTheme, THEME_EVENT, type Theme } from "../hooks/useSettings";
import Icon from "./Icon";

/**
 * 顶栏（R3 打磨，R6 去噪）。
 *
 * R6 的两处改动：
 *   1. **删掉标题下那句说明**（`PAGE_HINT`）—— 用户要求「提示的东西太多，界面不简洁」；
 *      它与侧栏、页面内文案重复，删掉后每页少一行。
 *   2. 标题旁新增**当前课程**胶囊：导航改成"课程优先"之后，
 *      「我现在在哪门课里」必须**始终可见**，否则用户会分不清看到的笔记属于谁。
 *      （课程名从 `?course=N` 解析，与侧栏、各页面同源。）
 */
export default function Topbar() {
  const page = useCurrentPage();
  const nav = useNavigate();
  const { courses } = useCourses();
  const { search } = useLocation();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  const courseId = parseCourseParam(search);
  const course = courseId != null ? courses.find((c) => c.id === courseId) : undefined;

  // 应用主题；同时监听设置页切换主题的事件，保证两个入口不打架
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onChange = (e: Event) => {
      const t = (e as CustomEvent<Theme>).detail;
      if (t === "light" || t === "dark") setTheme(t);
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);

  const dark = theme === "dark";

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1 className="page-title">{page.label}</h1>
        {course && (
          <span className="course-chip" title="当前课程：侧栏与各页面的内容都属于它">
            {course.name}
          </span>
        )}
      </div>
      <div className="topbar-actions">
        <button
          className="ghost-btn"
          onClick={() => void ballShow()}
          title="唤起桌面悬浮球：选中文字或截图就能随时问"
        >
          <Icon name="target" />
          悬浮球
        </button>
        <button
          className="ghost-btn"
          onClick={() => nav("/settings")}
          title="打开数据与设置"
        >
          <Icon name="gear" />
          设置
        </button>
        <button
          className="icon-btn"
          onClick={() => setTheme(dark ? "light" : "dark")}
          title={dark ? "切换到日间模式" : "切换到夜间模式"}
          aria-label={dark ? "切换到日间模式" : "切换到夜间模式"}
        >
          <Icon name={dark ? "sun" : "moon"} />
        </button>
      </div>
    </header>
  );
}
