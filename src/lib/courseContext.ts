// R8：把「本课上下文」注入系统提示词。
//
// 为什么需要它 —— 一个真实的现场缺陷（2026-09-24 用户实测）：
//   用户在《计算机系统基础》里问「什么是 IR」，模型把 IR 当成了通用缩写，列了
//   Information Retrieval / Intermediate Representation / 国际关系 / 红外 / 事件响应……一堆其他领域的含义。
//
//   根因**不是**检索坏了（那次确实 0 命中，界面也如实标了「无材料出处」），而是
//   **系统提示词里从来没有课程名**：`systemPromptFor(mode)` 只有固定人设 + 任务，
//   课程上下文唯一的入口是「先查材料」命中后的材料片段块。
//   于是材料为空时（新课程、还没导入课件 —— 实测该课 `course_prior` 与 `materials` 都是 0 条），
//   模型完全不知道自己在哪门课里，本课语境里的术语（IR = 指令寄存器）就退化成了全网最常见的含义。
//
// 口径（守 `docs/00` §7.3 的溯源红线，**不许松动**）：
//   · 这一块只**限定语境**，不提供"新的知识依据"：有出处的回答仍然只许引用材料片段；
//     无出处的补充仍然必须标注「模型补充，无材料出处」。
//   · 本课知识骨架的条目名可以列出来（它们本来就是用户看得到、可核对的东西），
//     但**必须显式标注它们是 AI 生成且未核对**，避免模型把 AI 生成的知识点当成事实依据引用。

/** 本课上下文块的表头（与 `NO_MATERIAL_BLOCK` / `SEARCH_FAILED_BLOCK` 并列注入） */
export const COURSE_BLOCK_HEAD = "【本课上下文】";

/** 列出的知识骨架条目上限：够模型认出"这门课在讲什么"，又不至于把提示词顶爆 */
export const COURSE_TOPICS_MAX = 40;

/**
 * 组装本课上下文块。
 *
 * @param courseName 当前会话的有效课程名（拿不到就传空串 —— 本函数会返回空串，调用方据此跳过注入）
 * @param priorTopics 该课先验知识的条目名（只用来划范围，不作为事实依据）
 */
export function buildCourseBlock(
  courseName: string,
  priorTopics: readonly string[] = [],
): string {
  const name = courseName.trim();
  // 说不出是哪门课，就不注入 —— 注入一块「你在某门课里」等于没说，还占上下文
  if (!name) return "";

  const lines: string[] = [
    COURSE_BLOCK_HEAD,
    `用户正在《${name}》这门课里提问。`,
    "理解术语、缩写与简称时，**优先按这门课的语境取义**；",
    "若一个缩写在本课语境里通常不是它最常见的那个含义，先说明你按哪种含义理解，再据此回答。",
  ];

  const topics = priorTopics
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, COURSE_TOPICS_MAX);
  if (topics.length > 0) {
    lines.push(
      "",
      "本课的知识骨架（由 AI 生成、**尚未与你核对**；只用来说明这门课的范围，不要当成事实依据引用）：",
      topics.join(" · "),
    );
  }
  return lines.join("\n");
}
