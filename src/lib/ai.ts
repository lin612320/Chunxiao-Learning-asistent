// AI 接入：OpenAI 兼容 /chat/completions 流式对话（BYOK：用户自带 Key）。
//
// 本文件由母本 `src/lib/ai.ts` 精简而来：
//   保留 —— AIConfig / ApiMsg / ApiContentPart / normalizeEndpoint / SSE 流式增量回调；
//   删除 —— 法律专用系统提示词、function calling（工具循环留在后续里程碑按需再加）；
//   新增 —— 学习场景提示词（答疑 / 出题 / 笔记 / 讲解）、平台预设与"测试连接"。

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 多模态内容块（OpenAI 兼容 content parts 子集；M0 先备好类型，图片通道 M2 启用） */
export type ApiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** 提交给接口的消息；content 可为字符串或多模态内容块数组 */
export interface ApiMsg {
  role: "system" | "user" | "assistant";
  content: string | ApiContentPart[];
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

/** 未指定模型时的兜底值（DeepSeek 为本项目首选预设） */
export const DEFAULT_MODEL = "deepseek-chat";

// ---------------------------------------------------------------------------
// 端点归一化
// ---------------------------------------------------------------------------

/**
 * 把用户填写的 base_url 规整为干净的基础地址。
 * 处理三类常见错填：
 *   1. 末尾多余的斜杠；2. 误填完整的 /chat/completions 端点；
 *   3. 把平台**控制台网页地址**当成接口地址粘贴（母本踩过的坑）。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let b = (baseUrl || "").trim().replace(/\s+/g, "");
  if (!b) return "";
  b = b.replace(/\/+$/, "");
  b = b.replace(/\/chat\/completions$/i, "");

  const hostFix: Array<[RegExp, string]> = [
    [/^https?:\/\/(www\.)?platform\.deepseek\.com.*$/i, "https://api.deepseek.com"],
    [/^https?:\/\/(www\.)?platform\.openai\.com.*$/i, "https://api.openai.com/v1"],
    [
      /^https?:\/\/(www\.)?bailian\.console\.aliyun\.com.*$/i,
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ],
    [/^https?:\/\/(www\.)?open\.bigmodel\.cn\/(?!api\/paas\/v4).*$/i, "https://open.bigmodel.cn/api/paas/v4"],
  ];
  for (const [re, fixed] of hostFix) {
    if (re.test(b)) return fixed;
  }
  return b;
}

/** 把接口地址规整为 /chat/completions 端点。 */
export function normalizeEndpoint(baseUrl: string): string {
  const b = normalizeBaseUrl(baseUrl);
  return b ? `${b}/chat/completions` : "https://api.openai.com/v1/chat/completions";
}

/** 平台预设（BYOK 第一屏引导用） */
export interface PlatformPreset {
  key: string;
  label: string;
  baseUrl: string;
  model: string;
}

export const PLATFORMS: PlatformPreset[] = [
  { key: "deepseek", label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  {
    key: "dashscope",
    label: "通义千问（阿里云）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  { key: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { key: "custom", label: "自定义（任何 OpenAI 兼容接口）", baseUrl: "", model: "" },
];

/** 按 base_url 反查预设 key（用于设置页回显下拉） */
export function matchPreset(baseUrl: string): string {
  const b = normalizeBaseUrl(baseUrl);
  const hit = PLATFORMS.find((p) => p.baseUrl && normalizeBaseUrl(p.baseUrl) === b);
  return hit ? hit.key : "custom";
}

// ---------------------------------------------------------------------------
// 学习场景系统提示词（替换母本的法律提示词）
// ---------------------------------------------------------------------------

/** 所有模式共用的基础人设与红线口径 */
export const BASE_SYSTEM = [
  "你是「春晓」——一款本地单机学习助手，面向大学生，用于**课后理解与复习**。",
  "红线与口径（必须遵守）：",
  "1. 你不是考试工具：不提供应试速成、押题、答案速出式的协助；遇到疑似考场/测验场景，改为引导用户自己讲清思路。",
  "2. 不编造出处：只引用用户已导入的材料与已核对的先验知识；没有依据的补充必须显式说明「以下为模型补充，无材料出处，请自行核对」。",
  "3. 优先苏格拉底式追问：把「直接给答案」换成「追问到用户能自己讲清楚」，一次只问 1–2 个关键问题。",
  "4. 不确定就说不确定，不要用肯定的语气表达猜测。",
  "5. 用中文回答，结构清晰，必要时用 Markdown 小标题与列表。",
].join("\n");

export type AskMode = "explain" | "quiz" | "note" | "summarize";

export const ASK_MODES: Array<{ key: AskMode; label: string; hint: string }> = [
  { key: "explain", label: "答疑", hint: "讲清概念与来龙去脉，并反问确认你真的懂了" },
  { key: "quiz", label: "出题", hint: "依据当前材料的层次出练习题，附解析但先不给答案" },
  { key: "note", label: "笔记", hint: "把讨论整理成结构化课堂笔记（Markdown）" },
  { key: "summarize", label: "讲解", hint: "用更浅的类比把难点重讲一遍" },
];

export const SYSTEM_PROMPTS: Record<AskMode, string> = {
  explain: [
    BASE_SYSTEM,
    "",
    "当前任务：**答疑**。",
    "先给出简明结论，再分点解释推理过程与前提条件；指出常见误解；",
    "最后用 1–2 个追问检查用户是否真的理解（不要直接把追问的答案写出来）。",
  ].join("\n"),
  quiz: [
    BASE_SYSTEM,
    "",
    "当前任务：**出题**。",
    "围绕用户给的主题出 3–5 道题，难度递进，题型混合（选择 / 填空 / 简答）。",
    "先只给题目，把参考答案与解析统一放在最后的「参考答案」小节，提醒用户先自己做。",
    "每道题标注它考察的知识点，便于后续归因。",
  ].join("\n"),
  note: [
    BASE_SYSTEM,
    "",
    "当前任务：**整理笔记**。",
    "把对话与材料整理成可直接复习的 Markdown 笔记：一句话要点 → 分节要点 → 易错点 → 待确认问题。",
    "只整理有依据的内容；推测部分单独放在「待确认」小节并标注。",
  ].join("\n"),
  summarize: [
    BASE_SYSTEM,
    "",
    "当前任务：**深入浅出地讲解**。",
    "换一个更日常的类比从头讲一遍，避免术语堆砌；",
    "讲完给出一个能自测理解程度的小例子，并指出这个类比的局限在哪里。",
  ].join("\n"),
};

/** 取某个模式的完整 system 提示词 */
export function systemPromptFor(mode: AskMode): string {
  return SYSTEM_PROMPTS[mode] ?? SYSTEM_PROMPTS.explain;
}

// ---------------------------------------------------------------------------
// 流式对话
// ---------------------------------------------------------------------------

/**
 * 发起一次 /chat/completions 请求并流式消费，content 增量实时回调 onDelta。
 * 返回本次 assistant 消息的完整文本。
 */
export async function chatStream(
  cfg: AIConfig,
  messages: ApiMsg[],
  opts: { onDelta: (delta: string) => void; signal?: AbortSignal; temperature?: number },
): Promise<string> {
  const key = (cfg.apiKey || "").trim();
  if (!key) throw new Error("未配置 API Key（当前为演示模式）。");

  const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model?.trim() || DEFAULT_MODEL,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(`请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("当前环境不支持流式读取，请换用桌面版。");

  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  for (;;) {
    if (opts.signal?.aborted) {
      throw new DOMException("已停止生成", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const delta = j.choices?.[0]?.delta;
        if (delta?.content) {
          full += delta.content;
          opts.onDelta(delta.content);
        }
      } catch {
        /* 跳过无法解析的片段 */
      }
    }
  }
  return full;
}

// ---------------------------------------------------------------------------
// 测试连接（BYOK 引导的关键一步：调 `${base}/models`）
// ---------------------------------------------------------------------------

export interface TestResult {
  ok: boolean;
  text: string;
}

export async function testConnection(cfg: AIConfig, signal?: AbortSignal): Promise<TestResult> {
  const key = (cfg.apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      text: "尚未填写 API Key：请先到对应平台的控制台创建 Key，再粘贴到上面的输入框（本机保存，不会上传到任何服务器）。",
    };
  }
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) {
    return {
      ok: false,
      text: "尚未填写接口地址 base_url：可从上面的「平台预设」里选一个，或手填任意 OpenAI 兼容地址。",
    };
  }

  const url = `${base}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
    if (res.ok) {
      let names: string[] = [];
      try {
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
        names = (data.data ?? [])
          .map((m) => m.id ?? "")
          .filter(Boolean)
          .slice(0, 6);
      } catch {
        /* 少数平台 /models 不返回 JSON，拿到 200 就算通过 */
      }
      return {
        ok: true,
        text:
          `连接成功（HTTP 200）：${url}` +
          (names.length > 0 ? `\n可用模型示例：${names.join("、")}` : ""),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        text: `鉴权失败（HTTP ${res.status}）：API Key 不正确、已过期，或该 Key 没有权限。请重新复制 Key（注意不要带空格与引号）。`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        text: `接口地址不存在（HTTP 404）：${url}\n请检查 base_url。DeepSeek 应填 https://api.deepseek.com，通义应填 https://dashscope.aliyuncs.com/compatible-mode/v1。`,
      };
    }
    if (res.status === 429) {
      return { ok: false, text: "请求过于频繁（HTTP 429）：Key 有效但已触发限流，稍后再试。" };
    }
    return { ok: false, text: `连接失败（HTTP ${res.status}）：请检查接口地址与 Key 是否匹配。` };
  } catch (e) {
    if (signal?.aborted) return { ok: false, text: "已取消测试。" };
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `无法连接到 ${url}：${msg}\n常见原因：网络不通、需要代理、被防火墙拦截，或接口地址写错。`,
    };
  }
}
