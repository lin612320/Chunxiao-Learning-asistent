// 设置数据层：桌面环境走 Rust(SQLite settings 键值表)，浏览器预览降级到 localStorage。
//
// 契约键名（《01-M0骨架契约》§五 / §六）：
//   ai.base_url / ai.api_key / ai.model / theme
//
// 写入口径：写入类操作一律走 invokeStrict（失败必须可见，不许静默）。
// API Key：桌面版把**明文**交给 Rust，由 Rust 侧 keycrypt.rs 混淆（`enc.` 前缀）后落盘；
//          浏览器预览没有 Rust，则由本层先用 lib/secret.ts 混淆再进 localStorage。

import { useCallback, useEffect, useMemo, useState } from "react";
import { invokeStrict, isTauri } from "../lib/tauri";
import { decryptSecret, encryptSecret } from "../lib/secret";
import { testConnection, type AIConfig, type TestResult } from "../lib/ai";

/** 设置键名常量 */
export const KEYS = {
  aiBaseUrl: "ai.base_url",
  aiApiKey: "ai.api_key",
  aiModel: "ai.model",
  // R4：**可选的独立视觉模型** —— 主模型看不了图时，用它把图转成文字。
  // 三项全空 = 复用主模型（此时"转写"能不能成，取决于主模型本身看不看得懂图）。
  aiVisionBaseUrl: "ai.vision_base_url",
  aiVisionApiKey: "ai.vision_api_key",
  aiVisionModel: "ai.vision_model",
  // R4：图片提问方式（auto=自动 / direct=直接发图 / transcribe=先转成文字）
  imageMode: "ai.image_mode",
  theme: "theme",
} as const;

/** 需加密落盘的设置键（仅浏览器预览路径生效） */
const SECRET_KEYS: string[] = [KEYS.aiApiKey, KEYS.aiVisionApiKey];
const isSecretKey = (k: string) => SECRET_KEYS.includes(k);

export type Theme = "light" | "dark";

/**
 * 图片提问方式（R4）。
 *   · `auto`（默认）：模型名看起来能看图就直接发图；否则若配了视觉模型就先转写；
 *     两者都不满足 → 明确报错并给可操作建议；
 *   · `direct`：一律直接发图（用户知道自己的模型能看图，但名字不像）；
 *   · `transcribe`：一律先转成文字（省 token、或想让纯文本主模型也能用）。
 */
export type ImageMode = "auto" | "direct" | "transcribe";

export const IMAGE_MODE_LABEL: Record<ImageMode, string> = {
  auto: "自动",
  direct: "直接发图",
  transcribe: "先转成文字",
};

export const LS_SETTINGS = "chunxiao:settings";
export const LS_THEME = "chunxiao:theme";
/** 主题变更事件名：Topbar 与 Settings 页靠它保持同步，无需引入状态库 */
export const THEME_EVENT = "chunxiao:theme-changed";

export interface SettingsState {
  loaded: boolean;
  ai: { baseUrl: string; apiKey: string; model: string };
  /** R4：可选的独立视觉模型（全空 = 复用 `ai`） */
  vision: { baseUrl: string; apiKey: string; model: string };
  /** R4：图片提问方式 */
  imageMode: ImageMode;
  theme: Theme;
}

const DEFAULTS: SettingsState = {
  loaded: false,
  // 首启默认给 DeepSeek（BYOK 第一屏的推荐项），用户可在设置页换成其它平台
  ai: { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" },
  vision: { baseUrl: "", apiKey: "", model: "" },
  imageMode: "auto",
  theme: "light",
};

// ---------------------------------------------------------------------------
// 主题：读写 localStorage + 落到 <html data-theme>
// ---------------------------------------------------------------------------

export function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(LS_THEME) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 立即应用主题（首屏在 index 之外调用也安全） */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(LS_THEME, t);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: t }));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 本地（浏览器预览）读写
// ---------------------------------------------------------------------------

function readLocal(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeLocal(map: Record<string, string>) {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/**
 * 逐层解密：桌面 Rust 若已解密返回则是明文（循环一次即退出）；
 * 若返回的仍是 `enc.` 密文（Rust 只负责落盘不负责读时解密），这里也能还原。
 */
function decryptDeep(value: string): string {
  let v = value;
  for (let i = 0; i < 3; i++) {
    const next = decryptSecret(v);
    if (next === v) break;
    v = next;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSettings() {
  const [s, setS] = useState<SettingsState>(() => ({ ...DEFAULTS, theme: readStoredTheme() }));
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 首次载入全部设置
  useEffect(() => {
    let alive = true;
    (async () => {
      const keys: string[] = [
        KEYS.aiBaseUrl,
        KEYS.aiApiKey,
        KEYS.aiModel,
        KEYS.aiVisionBaseUrl,
        KEYS.aiVisionApiKey,
        KEYS.aiVisionModel,
        KEYS.imageMode,
        KEYS.theme,
      ];
      const map: Record<string, string> = {};

      if (isTauri()) {
        for (const k of keys) {
          try {
            // 读操作允许失败（拿不到就用默认值），但要在控制台留痕
            const v = await invokeStrict<string | null>("settings_get", { key: k });
            if (v !== null && v !== undefined) map[k] = String(v);
          } catch (e) {
            console.warn(`[settings] 读取 ${k} 失败：`, e);
          }
        }
      } else {
        const local = readLocal();
        for (const k of keys) {
          if (local[k] !== undefined) map[k] = local[k];
        }
      }

      // 解密 API Key（明文直通，密文还原）
      for (const k of SECRET_KEYS) {
        if (map[k] !== undefined) map[k] = decryptDeep(map[k]);
      }

      const theme: Theme = map[KEYS.theme] === "dark" ? "dark" : readStoredTheme();
      applyTheme(theme);

      if (!alive) return;
      const rawMode = map[KEYS.imageMode];
      setS({
        loaded: true,
        ai: {
          baseUrl: map[KEYS.aiBaseUrl] ?? DEFAULTS.ai.baseUrl,
          apiKey: map[KEYS.aiApiKey] ?? DEFAULTS.ai.apiKey,
          model: map[KEYS.aiModel] ?? DEFAULTS.ai.model,
        },
        vision: {
          baseUrl: map[KEYS.aiVisionBaseUrl] ?? "",
          apiKey: map[KEYS.aiVisionApiKey] ?? "",
          model: map[KEYS.aiVisionModel] ?? "",
        },
        // 非法值一律回落到 auto，不把垃圾值带进逻辑分支
        imageMode: rawMode === "direct" || rawMode === "transcribe" ? rawMode : "auto",
        theme,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 落盘单个键：桌面走 invokeStrict（失败会抛），浏览器走 localStorage */
  const persist = useCallback(async (key: string, value: string) => {
    if (isTauri()) {
      // 明文交给 Rust，由 keycrypt.rs 负责混淆落盘（契约 §四）
      await invokeStrict<void>("settings_set", { key, value });
      return;
    }
    const map = readLocal();
    map[key] = isSecretKey(key) ? encryptSecret(value) : value;
    writeLocal(map);
  }, []);

  /** 仅改内存态（输入框即时反馈，不落盘） */
  const setAI = useCallback((patch: Partial<SettingsState["ai"]>) => {
    setS((prev) => ({ ...prev, ai: { ...prev.ai, ...patch } }));
  }, []);

  /** 显式保存 AI 配置三项（BYOK 引导的「保存」按钮） */
  const saveAI = useCallback(async (): Promise<boolean> => {
    try {
      await persist(KEYS.aiBaseUrl, s.ai.baseUrl);
      await persist(KEYS.aiApiKey, s.ai.apiKey);
      await persist(KEYS.aiModel, s.ai.model);
      setMsg({ type: "ok", text: "AI 配置已保存在本机。" });
      return true;
    } catch (e) {
      setMsg({
        type: "err",
        text: `保存失败：${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }, [persist, s.ai]);

  /** 仅改内存态：独立视觉模型三项（输入框即时反馈，不落盘） */
  const setVision = useCallback((patch: Partial<SettingsState["vision"]>) => {
    setS((prev) => ({ ...prev, vision: { ...prev.vision, ...patch } }));
  }, []);

  /** 显式保存视觉模型三项；三项留空 = 清除（表示"复用主模型"） */
  const saveVision = useCallback(async (): Promise<boolean> => {
    try {
      await persist(KEYS.aiVisionBaseUrl, s.vision.baseUrl.trim());
      await persist(KEYS.aiVisionApiKey, s.vision.apiKey.trim());
      await persist(KEYS.aiVisionModel, s.vision.model.trim());
      setMsg({
        type: "ok",
        text:
          s.vision.baseUrl.trim() && s.vision.apiKey.trim()
            ? "图片识别配置已保存在本机。"
            : "已清空图片识别配置：图片提问将改用上面的主模型。",
      });
      return true;
    } catch (e) {
      setMsg({
        type: "err",
        text: `保存失败：${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }, [persist, s.vision]);

  /** 切换图片提问方式（立即生效 + 落盘） */
  const setImageMode = useCallback(
    async (m: ImageMode) => {
      setS((prev) => ({ ...prev, imageMode: m }));
      try {
        await persist(KEYS.imageMode, m);
      } catch (e) {
        setMsg({
          type: "err",
          text: `图片提问方式已切换，但写入设置失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [persist],
  );

  /**
   * 独立视觉模型的配置：**只在三项都齐时**返回（缺一项就当没配）。
   *
   * 为什么要求 base+key 都齐：只填了模型名却没地址/Key 时，若仍返回它，
   * 转写会在"用了一个空地址"上失败 —— 那种失败信息对用户毫无意义。
   * 返回 null 表示"没有独立视觉模型"，由调用方决定是否复用主模型。
   */
  const visionConfig: AIConfig | null = useMemo(() => {
    const { baseUrl, apiKey, model } = s.vision;
    if (baseUrl.trim() && apiKey.trim()) {
      return { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() || undefined };
    }
    return null;
  }, [s.vision]);

  /** 切换主题（立即生效 + 落盘 settings.theme） */  const setTheme = useCallback(
    async (t: Theme) => {
      setS((prev) => ({ ...prev, theme: t }));
      applyTheme(t);
      try {
        await persist(KEYS.theme, t);
      } catch (e) {
        setMsg({ type: "err", text: `主题已切换，但写入设置失败：${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [persist],
  );

  /** 测试连接：调 `${base}/models`，不落盘（结果由设置页就地展示） */
  const testAI = useCallback(async (): Promise<TestResult> => {
    return await testConnection(s.ai as AIConfig);
  }, [s.ai]);

  /** 手动备份：Rust 复制数据库到目标目录 */
  const backupNow = useCallback(async (dir: string): Promise<boolean> => {
    if (!dir.trim()) {
      setMsg({ type: "err", text: "请先填写备份目标文件夹。" });
      return false;
    }
    try {
      const res = await invokeStrict<string>("backup_now", { dir: dir.trim() });
      setMsg({ type: "ok", text: `已备份到：${res}` });
      return true;
    } catch (e) {
      setMsg({
        type: "err",
        text: `备份失败：${e instanceof Error ? e.message : String(e)}（请确认目录存在且可写）`,
      });
      return false;
    }
  }, []);

  /** 还原：用备份文件替换本地数据库 */
  const restore = useCallback(async (file: string): Promise<boolean> => {
    if (!file.trim()) {
      setMsg({ type: "err", text: "请先填写备份文件的完整路径。" });
      return false;
    }
    try {
      const res = await invokeStrict<string>("restore", { file: file.trim() });
      setMsg({ type: "ok", text: res || "还原完成，请重启应用以载入还原后的数据。" });
      return true;
    } catch (e) {
      setMsg({
        type: "err",
        text: `还原失败：${e instanceof Error ? e.message : String(e)}（请确认备份文件路径正确）`,
      });
      return false;
    }
  }, []);

  const notify = useCallback((type: "ok" | "err", text: string) => setMsg({ type, text }), []);

  /** 是否已具备调用模型的条件（用于演示模式判断） */
  const hasKey = s.ai.apiKey.trim().length > 0 && s.ai.baseUrl.trim().length > 0;

  return {
    s,
    hasKey,
    setAI,
    saveAI,
    setVision,
    saveVision,
    setImageMode,
    visionConfig,
    setTheme,
    testAI,
    backupNow,
    restore,
    notify,
    msg,
    setMsg,
  };
}
