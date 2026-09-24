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
  // R10：默认换成 `whale`（鲸鱼娘，DSH 主题）。老配置里的 `aurora` 会在 load() 里一次性迁移。
  skin: 'whale',
  // 面板主题（PANEL_THEMES 的 key）
  theme: 'dark',
  // 抓取模式：auto=选取文字自动抓取弹面板；manual=不主动抓取，等用户拖入文本
  grabMode: 'auto',
  // 全局选词快捷键
  hotkey: 'Alt+Q',
  // 悬浮球位置（屏幕坐标），null 表示默认右下角
  ballPos: null,
  // 面板尺寸（R5：可缩放，用户拖过就记住）
  panelWidth: 420,
  // 面板高度（R5.1：**上下限由 windows.js 钳制为 420–1200**；
  //   这里只存用户拖出来的值。旧的 `panelCollapsed` 已随「收起」功能移除，见下方 load() 的自愈。）
  panelHeight: 620
};

/** 面板允许的最小高度（与 windows.js 的 PANEL_MIN_H 一致，自愈时用） */
const PANEL_MIN_HEIGHT = 460;

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
      // ── R5.1 自愈：把「收起」留下的坏状态清掉 ──────────────────────────
      // 1.0.5 的「收起」会把 panelHeight 存成 64、并写一个 panelCollapsed: true。
      // 那个功能已删除，但**坏值会留在用户配置里**：面板会以 64px 的高打开，
      // 而 64px 装不下输入框 + 按钮行 —— 用户看到的是一道残疾的窄条，
      // 且"展开"按钮被裁在窗口外，重启也恢复不了（真机上就是这样卡住的）。
      // 这里做了两件事：丢掉 panelCollapsed、把高度拉回合法下限。
      delete merged.panelCollapsed;
      if (!Number.isFinite(Number(merged.panelHeight)) || Number(merged.panelHeight) < PANEL_MIN_HEIGHT) {
        merged.panelHeight = DEFAULT_CONFIG.panelHeight;
      }
      // ── R10 迁移：主题换成 DSH（鲸鱼娘）后，把**旧默认皮肤**顶掉的那个值换过来 ──
      // 1.0.7 及以前的默认是 `aurora`（极光绿）。用户若从没手动选过皮肤，
      // 配置里就一直是 `aurora` —— 不迁移的话，"换主题"对他等于没发生。
      // ⚠ 只动**恰好等于旧默认值**的那一种取值：真选过别的皮肤（midnight/ocean/…）一律尊重。
      //   迁移后用户仍可在球的换肤窗里选回极光绿（`aurora` 皮肤本身保留着）。
      const migratingSkin = data && data.skin === 'aurora';
      if (migratingSkin) merged.skin = DEFAULT_CONFIG.skin;
      // apiKey 落盘为密文，读取时解密回明文（兼容历史明文）
      if (merged.ai && merged.ai.apiKey) merged.ai.apiKey = decrypt(merged.ai.apiKey);
      // 旧配置文件里 key 若为明文，自动迁移为加密落盘；
      // 顺带把上面清理掉的多余键也写回去（否则每次启动都要再清一遍）
      const dirty =
        (rawKey && typeof rawKey === 'string' && !rawKey.startsWith('enc.')) ||
        'panelCollapsed' in data ||
        migratingSkin;
      if (dirty) {
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
