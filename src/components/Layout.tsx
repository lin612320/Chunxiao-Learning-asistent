import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

/**
 * 应用外壳。三种形态：
 *
 *   1. **常规** —— 侧栏 + 顶栏 + 内容区；
 *   2. **`?float=1`** —— 悬浮球面板的紧凑模式：去掉侧栏与顶栏，只留对话区
 *     （M0 冻结行为，见 `docs/01-M0骨架契约.md` §五）；
 *   3. **`/note/:id`** —— R12 笔记沉浸式编辑器：同样去掉侧栏与顶栏，
 *      由编辑器自己的顶栏提供「返回」，让正文占满整个窗口。
 *
 *     ⚠ 编辑器的「无干扰」是**布局层**的决定，不是编辑器自己藏起来的 ——
 *     这样侧栏/顶栏不会先挂载再被隐藏（那会白跑一次课程列表 IPC，也会闪一下）。
 */
export default function Layout() {
  const { search, pathname } = useLocation();
  const q = new URLSearchParams(search);
  const isFloat = q.get("float") === "1";
  const isEditor = pathname.startsWith("/note/");

  if (isFloat) {
    return (
      <div className="float-shell">
        <Outlet />
      </div>
    );
  }

  if (isEditor) {
    return (
      <div className="editor-shell">
        <Outlet />
      </div>
    );
  }

  return (
    <div className="layout">
      <Sidebar />
      <div className="main">
        <Topbar />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
