import type { ReactNode } from "react";
import Icon from "./Icon";

/**
 * 可折叠的「说明」区块 —— **工程细节的唯一收纳处**（R3 产品决定）。
 *
 * 背景：此前版本把大量实现层面的描述直接铺在界面上（掌握度公式、evidence 口径、
 * 「不是强化学习」、严格 JSON、检索词、本机数据库路径……）。它们出于诚实边界而写，
 * 但对一个学生用户来说读起来像在看开发文档，也让界面显得"不像成品"。
 *
 * 现在的口径：**主界面只讲大白话，技术细节收进这里**。
 *   · 默认收起 → 不干扰主流程；
 *   · 展开即可查证 → 诚实边界并没有被删掉，只是不再挡路。
 *
 * ⚠ 用法纪律：这里放的是**补充说明**，不能用来藏"必须让用户看到"的警示
 *   （例如「AI 生成 · 待核对」这类来源标注必须留在正文里，不能塞进折叠区）。
 */
export interface TechNoteProps {
  /** 折叠条上的标题，例如「掌握度是怎么算的」。默认「说明」 */
  title?: string;
  children: ReactNode;
}

export default function TechNote({ title = "说明", children }: TechNoteProps) {
  return (
    <details className="tech-note">
      <summary>
        <Icon name="info" />
        <span>{title}</span>
        <Icon name="chevron-right" className="chev" />
      </summary>
      <div className="tech-body">{children}</div>
    </details>
  );
}
