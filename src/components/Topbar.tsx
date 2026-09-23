import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentPage } from "../nav";
import { ballShow } from "../lib/ball";
import { applyTheme, readStoredTheme, THEME_EVENT, type Theme } from "../hooks/useSettings";
import Icon from "./Icon";

/**
 * 顶栏（R3 打磨）。
 *
 * 两个要点：
 *   1. **emoji 全部换成内联 SVG 图标**：🎯 ☀️ 🌙 在不同系统上字形不同、基线不可控、
 *      颜色不跟随主题，是"界面不高级"的典型来源；SVG 走 `currentColor`，随主题变化。
 *   2. 标题右侧补一句**大白话说明**（"这一页是干什么的"）——
 *      原顶栏只有一个版块名，用户进来常常不知道从哪下手。说明里**不写任何实现口径**。
 */
const PAGE_HINT: Record<string, string> = {
  home: "从哪里接着学",
  courses: "先验知识、材料与课程对话",
  assistant: "先查你的课程材料，再回答并标明出处",
  notes: "把课堂与对话整理成可复习的笔记",
  questions: "按知识点生成题目、练习与错题重练",
  profile: "掌握度与弱项，只统计本机的作答记录",
  focus: "专注计时与近 7 天统计",
  settings: "模型接入、外观与数据备份",
};

export default function Topbar() {
  const page = useCurrentPage();
  const nav = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

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
  const hint = PAGE_HINT[page.key];

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1 className="page-title">{page.label}</h1>
        {hint && <p className="page-sub">{hint}</p>}
      </div>
      <div className="topbar-actions">
        <button
          className="ghost-btn"
          onClick={() => void ballShow()}
          title="唤起桌面悬浮球：选中文字就能随时提问"
        >
          <Icon name="target" />
          悬浮球
        </button>
        <button
          className="ghost-btn"
          onClick={() => nav("/assistant")}
          title="打开与春晓的对话"
        >
          <Icon name="chat" />
          对话
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
