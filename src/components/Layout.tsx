import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

/**
 * 应用外壳。三种形态：
 *
 *   1. **常规** —— 侧栏 + 顶栏 + 内容区；
 *   2. **`?float=1`** —— 悬浮球面板的紧凑模式：去掉侧栏与顶栏，只留对话区
 *     （M0 冻结行为，见 `docs/01-M0骨架契约.md` §五）；
 *   3. **`/note/:id` 与 `/handwrite/:id`** —— 沉浸式工作区（R12 笔记编辑器 / R14 手写页）：
 *      同样去掉侧栏与顶栏，由各自的顶栏提供「返回」，让正文/画布占满整个窗口。
 *
 *     ⚠ 编辑器的「无干扰」是**布局层**的决定，不是编辑器自己藏起来的 ——
 *     这样侧栏/顶栏不会先挂载再被隐藏（那会白跑一次课程列表 IPC，也会闪一下）。
 *
 * R14：窄屏（平板竖屏 / 手机）下侧栏变成**抽屉** —— 状态放在这里（外壳层），
 *   因为它同时被顶栏（汉堡按钮）、侧栏（点完就关）、遮罩（点一下就关）三方影响。
 *   宽屏下这个状态**没有任何作用**（CSS 里抽屉样式只在小屏媒体查询内）。
 */
export default function Layout() {
  const { search, pathname } = useLocation();
  const q = new URLSearchParams(search);
  const isFloat = q.get("float") === "1";
  const isEditor = pathname.startsWith("/note/") || pathname.startsWith("/handwrite");

  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  /**
   * 抽屉在**换路由时自动收起**。
   * 不这样做的话：从抽屉里点「笔记」跳到新页面，抽屉还盖在内容上 —— 用户会以为"点了没反应"。
   */
  useEffect(() => {
    setNavOpen(false);
  }, [pathname, search]);

  // 抽屉打开时把 body 打上标记：CSS 据此让抽屉滑入、遮罩出现（宽屏下这些规则不生效）
  useEffect(() => {
    if (navOpen) document.body.classList.add("nav-open");
    else document.body.classList.remove("nav-open");
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

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
      <Sidebar onNavigate={closeNav} />
      {/* 抽屉遮罩：点一下关掉。宽屏下它没有存在感（opacity 0 + pointer-events none） */}
      <div className="nav-backdrop" onClick={closeNav} aria-hidden="true" />
      <div className="main">
        <Topbar navOpen={navOpen} onToggleNav={() => setNavOpen((v) => !v)} />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
