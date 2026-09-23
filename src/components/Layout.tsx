import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

export default function Layout() {
  // 悬浮球面板以 ?float=1 作为独立紧凑模式：去掉侧栏与顶栏，只留对话区
  const { search } = useLocation();
  const isFloat = new URLSearchParams(search).get("float") === "1";

  if (isFloat) {
    return (
      <div className="float-shell">
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
