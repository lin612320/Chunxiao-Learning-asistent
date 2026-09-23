// 配置管理：持久化 AI Key、皮肤、悬浮球位置、快捷键等
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { getDefaultApiKey, encrypt, decrypt } = require('./keycrypt');

const configDir = app
  ? path.join(app.getPath('userData'))
  : __dirname;
const configFile = path.join(configDir, 'chunxiao-ball-config.json');

const DEFAULT_CONFIG = {
  // AI 配置（OpenAI 兼容接口）
  // 【BYOK】不内置共享 Key，apiKey 默认为空，由用户在设置中填写；
  // 未填写时面板进入"未配置"提示，不影响悬浮球本体与抓取功能。
  ai: {
    baseURL: 'https://api.deepseek.com',
    apiKey: getDefaultApiKey(), // 恒为空串，见 keycrypt.js 的 BYOK 说明
    model: 'deepseek-chat',
    timeoutMs: 60000
  },
  // 球皮肤（BALL_SKINS 的 key）
  skin: 'aurora',
  // 面板主题（PANEL_THEMES 的 key）
  theme: 'dark',
  // 抓取模式：auto=选取文字自动抓取弹面板；manual=不主动抓取，等用户拖入文本
  grabMode: 'auto',
  // 全局选词快捷键
  hotkey: 'Alt+Q',
  // 悬浮球位置（屏幕坐标），null 表示默认右下角
  ballPos: null,
  // 小窗宽度
  panelWidth: 420
};

function load() {
  try {
    if (fs.existsSync(configFile)) {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const rawKey = data && data.ai ? data.ai.apiKey : '';
      // 深合并，保证新增字段有默认值
      const merged = deepMerge(structuredClone(DEFAULT_CONFIG), data);
      // childMode 是运行时状态，历史版本曾误写入配置文件导致
      // 全局钩子/快捷键被永久禁用——这里剔除，只由启动参数决定
      delete merged.childMode;
      // apiKey 落盘为密文，读取时解密回明文（兼容历史明文）
      if (merged.ai && merged.ai.apiKey) merged.ai.apiKey = decrypt(merged.ai.apiKey);
      // 旧配置文件里 key 若为明文，自动迁移为加密落盘
      if (rawKey && typeof rawKey === 'string' && !rawKey.startsWith('enc.')) {
        try { save(merged); } catch {}
      }
      return merged;
    }
  } catch (e) {
    console.error('读取配置失败:', e);
  }
  return structuredClone(DEFAULT_CONFIG);
}

function save(cfg) {
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    // 落盘前加密 apiKey，配置文件中不出现明文 sk-...
    const toWrite = structuredClone(cfg);
    if (toWrite.ai && toWrite.ai.apiKey) toWrite.ai.apiKey = encrypt(toWrite.ai.apiKey);
    fs.writeFileSync(configFile, JSON.stringify(toWrite, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入配置失败:', e);
  }
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

module.exports = { load, save, DEFAULT_CONFIG, configFile };
