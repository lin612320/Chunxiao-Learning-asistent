// AI 接入：基于 OpenAI 兼容接口，提供 关联查找 / 自由询问（**含图片**）
// 支持流式输出，由配置中的 baseURL/apiKey/model 驱动
//
// R4 变更：**移除「翻译」**（用户要求：悬浮球只留「材料/关联」与「询问」）。
//   同时给「询问」加上图片支持 —— content 可以是内容块数组（`image_url`），
//   与主程序 `lib/ai.ts` 的 `ApiContentPart` 保持同一种形状。

// HTTP 请求：优先 Electron net.fetch（Chromium 网络栈）
// 关键差异：net.fetch 会走 Windows 系统代理并支持企业证书，
// 而 Node 全局 fetch（undici）忽略系统代理——办公网络/代理环境下会连接失败
let electronNet = null;
try { electronNet = require('electron').net; } catch { /* 非 Electron 环境 */ }

async function httpFetch(url, opts) {
  if (electronNet && typeof electronNet.fetch === 'function') {
    return electronNet.fetch(url, opts);
  }
  return fetch(url, opts);
}

// 给 fetch 失败套上可读的错误信息（含代理提示）
async function httpFetchWithHint(url, opts) {
  try {
    return await httpFetch(url, opts);
  } catch (e) {
    throw new Error(
      `网络请求失败（${e.message || e}）。` +
      `如果办公室网络需要代理，请在 Windows「设置 → 网络和 Internet → 代理」配置系统代理后重试。`
    );
  }
}

// 常见平台域名映射：用户容易粘贴控制台网页地址，这里自动修正
const PLATFORM_FIXES = [
  // DeepSeek: platform.deepseek.com(控制台) → api.deepseek.com/v1
  { from: /platform\.deepseek\.com/i, to: 'https://api.deepseek.com/v1' },
  { from: /deepseek\.com\/api_keys/i, to: 'https://api.deepseek.com/v1' },
  // OpenAI: platform.openai.com → api.openai.com/v1
  { from: /platform\.openai\.com/i, to: 'https://api.openai.com/v1' },
  { from: /openai\.com\/api-keys/i, to: 'https://api.openai.com/v1' },
  // 阿里百炼: 控制台 → dashscope
  { from: /dashscope\.console\.aliyun/i, to: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { from: /dashscope\.aliyuncs\.com$/i, to: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  // 智谱: 控制台 → open.bigmodel.cn
  { from: /bigmodel\.cn\/console/i, to: 'https://open.bigmodel.cn/api/paas/v4' },
  { from: /open\.bigmodel\.cn$/i, to: 'https://open.bigmodel.cn/api/paas/v4' },
];

/**
 * 规范化 baseURL：
 * 1. 自动修正常见网页域名 → API 域名
 * 2. 去末尾斜杠
 * 3. 如果用户填了完整 endpoint（含 /chat/completions），截断到 base
 */
function normalizeBaseURL(raw) {
  let url = (raw || '').trim();
  if (!url) return '';
  // 修正已知网页域名
  for (const fix of PLATFORM_FIXES) {
    if (fix.from.test(url)) {
      url = fix.to;
      break;
    }
  }
  // 去掉可能带的 /chat/completions 或 /models 后缀
  url = url.replace(/\/(chat\/completions|models)$/i, '');
  // 去末尾斜杠
  return url.replace(/\/$/, '');
}

/**
 * 规范化 API Key：
 * 自动检测并去除重复粘贴的 key（如用户复制两次粘在一起）
 */
function normalizeAPIKey(raw) {
  let key = (raw || '').trim();
  // 如果 key 长度是偶数且前后两半完全相同，截断
  if (key.length >= 20 && key.length % 2 === 0) {
    const half = key.length / 2;
    if (key.slice(0, half) === key.slice(half)) {
      key = key.slice(0, half);
    }
  }
  return key;
}

function buildHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${normalizeAPIKey(cfg.ai.apiKey)}`
  };
}

function endpoint(cfg) {
  const base = normalizeBaseURL(cfg.ai.baseURL);
  if (!base) throw new Error('AI API 地址为空，请在设置中填写 baseURL');
  return `${base}/chat/completions`;
}

module.exports = { runTask, streamChat, normalizeBaseURL, normalizeAPIKey, endpoint, httpFetchWithHint, looksVisionCapable, transcribeOne };

// 系统提示词
const PROMPTS = {
  relate: (text) =>
    `你是一名知识关联助手。用户给出一段文本，请围绕其中关键概念做"关联查找"：` +
    `1) 用一句话解释文本主旨；` +
    `2) 列出 3-6 个相关概念或术语，每个用「名称：简短说明」表示；` +
    `3) 给出 2-3 条可延伸阅读的方向。使用 Markdown 列表格式输出，简洁有条理。`,
  ask: (question, context) =>
    `你是一名严谨且乐于助人的助手。根据用户的问题作答。` +
    (context ? `参考上下文：\n"""${context}"""\n` : '') +
    `如果用户还给了图片，请结合图片内容回答（看不清就说看不清，不要猜）。` +
    `回答用 Markdown，必要时分点说明。`,
  // R5：「关联知识点」的第二步 —— 从内容里提炼**可核对**的候选知识点。
  //   这是全链路唯一会"产生要写进知识库的内容"的一步，所以把"宁可不写"写进提示词：
  //   候选会先给用户核对（勾选/编辑）才入库，模型这一端先少编一点。
  extract: () =>
    `你是课程知识点的整理助手。用户会给你一段教材 / 课件 / 讲义的内容，可能还附带截图。\n` +
    `请从中提炼**可核对**的知识点，**只输出严格 JSON**（不要 Markdown 代码块、不要任何解释文字）：\n` +
    `{"items":[{"topic":"知识点名称","summary":"一句话说明","detail":"要点，可空","parent_topic":"所属上级知识点名称，没有就给 null"}]}\n` +
    `规则：\n` +
    `1) 最多 8 条；topic 不超过 40 字，彼此不重复；\n` +
    `2) 只提炼内容里**真实出现**的概念，不要补充你自己的联想；\n` +
    `3) 看不清或不确定的，宁可不写 —— 这些候选会被写进课程先验知识，编造比漏掉更糟；\n` +
    `4) 如果内容里确实没有可提炼的知识点，返回 {"items":[]}。`
};

/**
 * 流式聊天
 * @param {object} cfg 全局配置
 * @param {Array<{role,content}>} messages
 * @param {(chunk:string)=>void} onChunk 收到增量
 * @param {AbortSignal} signal
 * @param {number} [temperature] 默认 0.4；结构化输出（extract）用 0.2
 */
async function streamChat(cfg, messages, onChunk, signal, temperature) {
  if (!cfg.ai.apiKey) {
    throw new Error('未配置 AI API Key，请先在小窗设置中填写。');
  }

  const res = await httpFetchWithHint(endpoint(cfg), {
    method: 'POST',
    headers: buildHeaders(cfg),
    signal,
    body: JSON.stringify({
      model: cfg.ai.model,
      messages,
      stream: true,
      temperature: typeof temperature === 'number' ? temperature : 0.4
    })
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 按 \n\n 分块
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) onChunk(delta);
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// R5：图片路由（主模型能看图就直接发；不能看就用独立视觉模型先转文字）
// ---------------------------------------------------------------------------
//
// 与主程序 `src/lib/vision.ts` **同一套口径**：提示词逐字相同、启发式名单相同。
// 两边不一致会出现"同样一张截图，主窗口读得出来、球读不出来"这种最难解释的差异。

/** 契约 `docs/05` §2.2 的转录提示词（**逐字使用**，与 `lib/vision.ts` 一致） */
const VISION_PROMPT =
  '你是课堂材料的转录助手。请完整提取这份材料的可学习内容：标题与章节层级、正文要点、公式与符号、图表说明、例题与解答。只输出材料本身可靠呈现的内容，不要评论、不要补全缺失信息；无法可靠辨识的部分明确标注「无法辨识」。';

/** 与 `lib/vision.ts` 的 `VISION_MODEL_HINTS` 保持一致（启发式，不是能力探测） */
const VISION_MODEL_HINTS = [
  'vl', 'vision', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'claude', 'gemini',
  'glm-4v', 'glm-4.5v', 'llava', 'internvl', 'minicpm-v', 'pixtral',
  'doubao-vision', 'step-1v'
];

/** 模型名看起来能不能看图（启发式：猜错的代价只是多发一次请求，接口会如实报错） */
function looksVisionCapable(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return VISION_MODEL_HINTS.some((h) => m.includes(h));
}

/** 用（独立或主）视觉模型把一张 dataURL 转成文字。失败抛**可读中文错误**，不静默。 */
async function transcribeOne(cfg, dataUrl) {
  const vBaseURL = cfg.ai.visionBaseURL || cfg.ai.baseURL;
  const vKeyRaw = cfg.ai.visionApiKey || cfg.ai.apiKey;
  const vModel = cfg.ai.visionModel || cfg.ai.model;
  if (!vKeyRaw) {
    throw new Error(
      '需要能看图的模型：请到春晓「数据设置 → 图片识别」里单独指定一个支持视觉的模型（Key 只保存在本机）。'
    );
  }
  const base = normalizeBaseURL(vBaseURL);
  if (!base) throw new Error('视觉模型的接口地址为空，请到春晓「数据设置 → 图片识别」里填写。');

  const res = await httpFetchWithHint(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${normalizeAPIKey(vKeyRaw)}`
    },
    body: JSON.stringify({
      model: vModel,
      temperature: 0.1,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `图片转文字失败（HTTP ${res.status}）：当前模型可能不支持图片输入。` +
        `请在春晓「数据设置 → 图片识别」换一个支持视觉的模型（如 gpt-4o、Qwen-VL）。` +
        (detail ? `平台返回：${detail.slice(0, 200)}` : '')
    );
  }
  let data = null;
  try { data = await res.json(); } catch { throw new Error('视觉模型返回的不是合法 JSON，读不出文字。'); }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
      : '';
  if (!text.trim()) {
    throw new Error('视觉模型没有返回任何文字（很可能不支持图片输入）：请换一个支持视觉的模型。');
  }
  return text;
}

/**
 * 组装并执行一次任务。
 *
 * `kind`：
 *   · `relate`   —— 关联查找（旧的纯模型关联；面板现已改用主程序本机检索 `relate_search`）
 *   · `extract`  —— R5：从内容（含截图）里提炼候选知识点，输出严格 JSON
 *   · 其它        —— 询问（`question` / 可选 `context` / 可选 `images`）
 *
 * **图片路由**（与主程序 `lib/vision.ts` 同口径）：
 *   主模型看得了图 → 直接把图发过去；
 *   主模型看不了、但配了独立视觉模型 → 先转成文字再发（并在正文里如实标注）；
 *   两者都没有 → **明确报错**，绝不假装看懂了图。
 */
async function runTask(cfg, kind, opts, onChunk, signal) {
  let images = Array.isArray(opts.images) ? opts.images.filter((u) => typeof u === 'string' && u) : [];
  let question = opts.question || '';
  let context = opts.context || '';
  let temperature = 0.4;

  if (images.length > 0) {
    const mode = cfg.ai.imageMode || 'auto';
    const mainCanSee = looksVisionCapable(cfg.ai.model);
    const hasVisionModel = !!(cfg.ai.visionModel || cfg.ai.visionApiKey);
    let route;
    if (mode === 'direct') route = 'direct';
    else if (mode === 'text') route = 'text';
    else route = mainCanSee ? 'direct' : (hasVisionModel ? 'text' : 'none');

    if (route === 'none') {
      throw new Error(
        '当前主模型看不了图，也没有单独配置「图片识别」的视觉模型。\n' +
          '请到春晓「数据设置 → 图片识别」指定一个能看图的模型（Key 只保存在本机），' +
          '或者换成支持视觉的主模型。'
      );
    }
    if (route === 'text') {
      const parts = [];
      for (let i = 0; i < images.length; i++) {
        parts.push(await transcribeOne(cfg, images[i]));
      }
      const joined = parts
        .map((t, i) => `【第 ${i + 1} 张图片的内容（模型转写，非原文）】\n${t}`)
        .join('\n\n');
      question = question ? `${question}\n\n${joined}` : joined;
      images = []; // 已转成文字，不再回传图片内容块
    }
  }

  let messages;
  if (kind === 'relate') {
    const { text } = opts;
    messages = [
      { role: 'system', content: PROMPTS.relate(text) },
      { role: 'user', content: text }
    ];
  } else if (kind === 'extract') {
    temperature = 0.2; // 结构化输出：别让模型"发挥"
    const userContent = images.length > 0
      ? [
          { type: 'text', text: question || '请看这张截图里的内容' },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ]
      : (question || '');
    messages = [
      { role: 'system', content: PROMPTS.extract() },
      { role: 'user', content: userContent }
    ];
  } else {
    const userContent = images.length > 0
      ? [
          { type: 'text', text: question || '请看图片' },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ]
      : question;
    messages = [
      { role: 'system', content: PROMPTS.ask(question, context) },
      { role: 'user', content: userContent }
    ];
  }
  return streamChat(cfg, messages, onChunk, signal, temperature);
}
