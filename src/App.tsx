import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Courses from "./views/Courses";
import Course from "./views/Course";
import Assistant from "./views/Assistant";
import Settings from "./views/Settings";
import Focus from "./views/Focus";
import Notes from "./views/Notes";
// M4 已落地：题库与学习画像不再是占位页（契约 docs/10-M4契约.md §3.3）。
// ⚠ `views/Placeholder.tsx` 保留但不再被引用：`scripts/smoke-ui.mjs` 的「不是占位组件」
//   与「全站占位措辞扫描」断言依赖 `.placeholder` 这个类名，留着它才能继续防
//   "某页被换回占位页"这类退化。
import Questions from "./views/Questions";
import Profile from "./views/Profile";
import NoteEditor from "./views/NoteEditor";
import Materials from "./views/Materials";

/**
 * 路由表（R6：改成**课程优先**）。
 *
 *   · **删掉首页总览**（用户明确要求）：打开应用直接落在「课程」；
 *     `/` 与旧的 `/home` 都重定向到 `/courses` —— 旧链接不 404（README / 文档里引用过）。
 *   · 笔记 / 题库 / 画像 / 对话**仍是独立路由**，但由侧栏带上 `?course=N` 进入该课程的上下文；
 *     不带参数 = 「全部课程」（跨课程汇总）。
 *     ⚠ 之所以不做成"课程页里的内嵌标签"：那要把 4 个页面组件塞进课程页、每个都加"内嵌模式"，
 *       改动面大，且容易藏出"标题重复 / 高度算错"这类问题。
 *       现在这样：**侧栏本身就是这门课的功能列表**，语义一致，风险小得多。
 */
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/courses" replace />} />
          <Route path="/home" element={<Navigate to="/courses" replace />} />
          <Route path="/courses" element={<Courses />} />
          <Route path="/course/:id" element={<Course />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/settings" element={<Settings />} />

          {/* M3 已落地：笔记与专注计时（不再是占位页） */}
          <Route path="/notes" element={<Notes />} />
          {/* R12：笔记的**沉浸式编辑器**（独立文档视图）。`Layout` 见到 `/note/` 前缀会
              换成无干扰外壳（不渲染侧栏与顶栏），返回入口在编辑器自己的顶栏里。 */}
          <Route path="/note/:id" element={<NoteEditor />} />
          {/* R13：侧栏「相关材料」——列本课导入的材料，点「打开」用系统默认程序打开原文件 */}
          <Route path="/materials" element={<Materials />} />
          <Route path="/focus" element={<Focus />} />

          {/* M4 已落地：题库与学习画像（不再是占位页） */}
          <Route path="/questions" element={<Questions />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/courses" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
