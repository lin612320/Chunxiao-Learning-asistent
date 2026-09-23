// AI 接入：基于 OpenAI 兼容接口，提供翻译/关联查找/自由询问
// 支持流式输出，由配置中的 baseURL/apiKey/model 驱动

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

module.exports = { runTask, streamChat, normalizeBaseURL, normalizeAPIKey, endpoint, httpFetchWithHint };

// 系统提示词
const PROMPTS = {
  translate: (text, target) =>
    `你是一名专业翻译。请把用户给出的文本翻译为${target}。` +
    `只输出译文，不要解释，不要附加原文。如果文本本身已是${target}，则原样输出。`,
  relate: (text) =>
    `你是一名知识关联助手。用户给出一段文本，请围绕其中关键概念做"关联查找"：` +
    `1) 用一句话解释文本主旨；` +
    `2) 列出 3-6 个相关概念或术语，每个用「名称：简短说明」表示；` +
    `3) 给出 2-3 条可延伸阅读的方向。使用 Markdown 列表格式输出，简洁有条理。`,
  ask: (question, context) =>
    `你是一名严谨且乐于助人的助手。根据用户的问题作答。` +
    (context ? `参考上下文：\n"""${context}"""\n` : '') +
    `回答用 Markdown，必要时分点说明。`
};

/**
 * 流式聊天
 * @param {object} cfg 全局配置
 * @param {Array<{role,content}>} messages
 * @param {(chunk:string)=>void} onChunk 收到增量
 * @param {AbortSignal} signal
 */
async function streamChat(cfg, messages, onChunk, signal) {
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
      temperature: 0.4
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

function runTask(cfg, kind, opts, onChunk, signal) {
  let messages;
  if (kind === 'translate') {
    const { text, target } = opts;
    messages = [
      { role: 'system', content: PROMPTS.translate(text, target) },
      { role: 'user', content: text }
    ];
  } else if (kind === 'relate') {
    const { text } = opts;
    messages = [
      { role: 'system', content: PROMPTS.relate(text) },
      { role: 'user', content: text }
    ];
  } else {
    const { question, context } = opts;
    messages = [
      { role: 'system', content: PROMPTS.ask(question, context) },
      { role: 'user', content: question }
    ];
  }
  return streamChat(cfg, messages, onChunk, signal);
}
