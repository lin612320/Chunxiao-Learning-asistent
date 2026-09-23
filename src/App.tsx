import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./views/Home";
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

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<Home />} />
          <Route path="/courses" element={<Courses />} />
          <Route path="/course/:id" element={<Course />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/settings" element={<Settings />} />

          {/* M3 已落地：笔记与专注计时（不再是占位页） */}
          <Route path="/notes" element={<Notes />} />
          <Route path="/focus" element={<Focus />} />

          {/* M4 已落地：题库与学习画像（不再是占位页） */}
          <Route path="/questions" element={<Questions />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
