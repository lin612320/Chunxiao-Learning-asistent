import { useLocation } from "react-router-dom";
import type { IconName } from "./components/Icon";

/**
 * 左侧导航（M0 建立，R3 重排）。
 *
 * R3 变更：
 *   · 每项带 `icon`（内联 SVG）—— 原先是"小圆点"，8 个入口长得一模一样，扫视成本高；
 *   · 新增 `group` 分组标题（学习 / 记录 / 系统）—— 入口变多后，分组比堆图标更能拉开层次；
 *   · `planned` 保留：`Placeholder.tsx` 与 `.placeholder` 类名仍被质量闸门第 7 步用来
 *     防"某页被换回占位页"，将来新增未落地板块时仍可标 `planned: true` 弱化显示。
 */
export interface NavItem {
  key: string;
  label: string;
  path: string;
  /** 导航图标（内联 SVG 名称，见 components/Icon.tsx） */
  icon: IconName;
  /** 分组标题：相邻且同名的项会归入同一组，渲染一次标题 */
  group: string;
  /** M1+ 规划中：侧栏以弱化样式提示 */
  planned?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "首页总览", path: "/home", icon: "home", group: "学习" },
  { key: "courses", label: "课程", path: "/courses", icon: "book", group: "学习" },
  { key: "assistant", label: "与春晓对话", path: "/assistant", icon: "chat", group: "学习" },
  { key: "notes", label: "笔记", path: "/notes", icon: "note", group: "记录" },
  { key: "questions", label: "题库", path: "/questions", icon: "help", group: "记录" },
  { key: "profile", label: "学习画像", path: "/profile", icon: "chart", group: "记录" },
  { key: "focus", label: "专注计时", path: "/focus", icon: "timer", group: "记录" },
  { key: "settings", label: "数据设置", path: "/settings", icon: "gear", group: "系统" },
];

/** 根据当前路径取出版块标题，用于顶部栏 */
export function useCurrentPage(): NavItem {
  const { pathname } = useLocation();
  // /course/:id 属于「课程」版块
  if (pathname === "/course" || pathname.startsWith("/course/")) {
    return NAV_ITEMS.find((it) => it.key === "courses") ?? NAV_ITEMS[0];
  }
  return (
    NAV_ITEMS.find((it) => it.path === pathname) ?? { key: "home", label: "首页总览", path: "/home", icon: "home", group: "学习" }
  );
}
