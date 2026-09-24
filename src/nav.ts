import { useLocation } from "react-router-dom";

/**
 * 页面标题（顶栏用）。R6：导航改成「课程优先」，这里只负责"当前在哪一页"。
 *
 * ⚠ 已经**删掉**原来的 `hint`（每个页面标题下那句说明）：
 *   用户明确要求「提示的东西太多，界面不简洁」。那句说明与侧栏、页面内文案重复，
 *   删掉后每页少一行，而真正需要解释的口径全部收在页面内的折叠「说明」区。
 *
 * 已经**删掉** `NAV_ITEMS`：导航项要带课程上下文（`?course=N`），
 * 静态列表表达不了 —— 改由 `components/Sidebar.tsx` 按当前课程现算。
 */
export interface PageInfo {
  key: string;
  label: string;
}

const PAGES: Array<{ key: string; label: string; match: (pathname: string) => boolean }> = [
  { key: "courses", label: "课程", match: (p) => p === "/courses" || p === "/" },
  { key: "course", label: "课程", match: (p) => p.startsWith("/course/") },
  { key: "notes", label: "笔记", match: (p) => p === "/notes" },
  { key: "questions", label: "题库", match: (p) => p === "/questions" },
  { key: "profile", label: "学习画像", match: (p) => p === "/profile" },
  { key: "assistant", label: "与春晓对话", match: (p) => p === "/assistant" },
  { key: "focus", label: "专注计时", match: (p) => p === "/focus" },
  { key: "settings", label: "数据设置", match: (p) => p === "/settings" },
];

/** 根据当前路径取出版块标题（用于顶部栏） */
export function useCurrentPage(): PageInfo {
  const { pathname } = useLocation();
  const hit = PAGES.find((p) => p.match(pathname));
  return hit ? { key: hit.key, label: hit.label } : { key: "courses", label: "课程" };
}
