// 对话数据层：会话列表 / 消息收发 / 本地持久化。
//
// 桌面走 Rust(SQLite chat_sessions / chat_messages)，浏览器预览降级到 data/sample.ts。
// 会话与消息的**写入**一律 invokeStrict（失败可见）。
//
// 演示模式：settings 里没配 ai.api_key 时**不调模型**，只回一段固定说明文案，
// 并引导用户去「数据设置」配置 —— 绝不假装有 AI 回答。

import { useCallback, useEffect, useRef, useState } from "react";
import { callRust, invokeStrict, isTauri } from "../lib/tauri";
import {
  allocId,
  loadSampleDb,
  saveSampleDb,
  serializeRefs,
  type ChatMessage,
  type ChatSession,
  type MsgRef,
} from "../data/sample";
import {
  chatStream,
  systemPromptFor,
  type AIConfig,
  type ApiContentPart,
  type ApiMsg,
  type AskMode,
} from "../lib/ai";
// 检索范围口径与对话页**同源**（契约 `docs/11-R1…` §一 第 2 条：界面写什么就必须按什么查）
import { effectiveScope } from "../lib/courseScope";
// R4：图片提问的路由（直接发图 / 先转成文字）与能力启发式判定
import { looksVisionCapable, transcribeDataUrls } from "../lib/vision";
import type { ImageMode } from "./useSettings";
import { onBallPush } from "../lib/ball";
import {
  buildMaterialBlock,
  extractSearchTermsWithInfo,
  materialSearch,
  refsFromHits,
  NO_MATERIAL_BLOCK,
  SEARCH_FAILED_BLOCK,
} from "../lib/materials";

/** 未配置 Key 时的固定演示回复（不调模型，明确说明这不是 AI 回答） */
export const DEMO_REPLY = [
  "【演示模式 · 这不是 AI 的回答】",
  "",
  "本机还没有配置模型 API Key，所以春晓没有调用任何模型，上面这段是程序写死的说明文案。",
  "",
  "要开始真正的问答：打开左侧「数据设置」→ 选平台预设（DeepSeek / OpenAI / 通义 / 智谱）→ 填入你自己的 API Key → 点「测试连接」→ 保存，再回到这里提问。",
  "",
  "两点说明：",
  "· Key 与课程数据都只保存在这台电脑上（本地单机），不会上传到我们的服务器；",
  "· 春晓面向课后理解与复习，不面向考试场景；AI 生成的内容请自行核对。",
].join("\n");

export interface UseChatOptions {
  ai: AIConfig;
  /** 是否具备真实调用条件（没 Key / 没 base_url → 走演示模式） */
  hasKey: boolean;
  /**
   * 限定的**课程上下文**：会话列表按它筛、新建会话/材料检索都按它走。
   * `null` / 不传 = 不限定课程（`/assistant` 无参数就是这个语义，不是"最近用过的课程"）。
   * R1 修复点：对话页必须把 `?course=<id>` 解析后传进来，否则桌面版 `chat_sessions.course_id` 恒为 NULL。
   */
  courseId?: number | null;
  /**
   * R4：**可选的独立视觉模型**（三项齐全时才有值）。
   * 主模型看不了图、又配了它 → 先用它把图转成文字，再把文字交给主模型。
   */
  vision?: AIConfig | null;
  /** R4：图片提问方式（默认 `auto`） */
  imageMode?: ImageMode;
}

/**
 * 本轮材料检索的如实记录（M2）：中文长句会被抽成关键词再检索，
 * 用户需要知道**实际用了哪些词**、命中多少 —— 否则"为什么没有引用"无从判断。
 */
export interface SearchTrace {
  /** 本轮真正送给检索的词（空格连接后交给 `material_search`） */
  terms: string[];
  /** true = 没抽出关键词，退回整句检索 */
  fallback: boolean;
  /** 命中的材料片段数（0 = 如实告知"未命中"） */
  hits: number;
  /** true = 检索本身没跑成（与"没命中"必须区分） */
  failed: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function useChat(opts: UseChatOptions) {
  const { ai, hasKey, courseId, vision = null, imageMode = "auto" } = opts;

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  /** M1：正在做本机材料检索（与"模型生成中"分开显示，避免用户误以为在调模型） */
  const [searching, setSearching] = useState(false);
  /** R4：正在把图片转成文字（走独立视觉模型）——与"模型生成中"分开显示，别让用户以为在等回答 */
  const [imageBusy, setImageBusy] = useState(false);
  /** M2：本轮检索用了哪些词 / 命中多少（如实展示，命中 0 也要说清） */
  const [lastSearch, setLastSearch] = useState<SearchTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 消息镜像：流式回调里需要读"当前"消息，不能依赖 state 的异步更新 */
  const msgsRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * `currentId` 的镜像。
   * 用途：课程上下文（`courseId`）变化后重拉列表的那个 effect 需要知道"**当前**选中的是哪个会话"
   * 才能判断它是否还在新列表里；但它不能把 `currentId` 写进依赖 —— 那样每次点会话都会重拉列表、
   * 并把选中项抢回列表首个。所以这里镜像一份，并用 `applyCurrentId` 统一写（state + ref 同步）。
   */
  const currentIdRef = useRef<number | null>(null);
  const applyCurrentId = useCallback((id: number | null) => {
    currentIdRef.current = id;
    setCurrentId(id);
  }, []);

  const applyMessages = useCallback((next: ChatMessage[]) => {
    msgsRef.current = next;
    setMessages(next);
  }, []);

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  const listSessions = useCallback(async (): Promise<ChatSession[]> => {
    if (isTauri()) {
      const list = await callRust<ChatSession[]>(
        "chat_sessions_list",
        courseId != null ? { courseId } : undefined,
      );
      return Array.isArray(list) ? list : [];
    }
    const db = loadSampleDb();
    const all = db.sessions;
    return (courseId != null ? all.filter((s) => s.course_id === courseId) : all).slice();
  }, [courseId]);

  const refreshSessions = useCallback(async () => {
    const list = await listSessions();
    setSessions(list);
    return list;
  }, [listSessions]);

  const loadMessages = useCallback(
    async (sessionId: number) => {
      setLoadingMsgs(true);
      try {
        if (isTauri()) {
          const list = await callRust<ChatMessage[]>("chat_history_load", { sessionId });
          applyMessages(Array.isArray(list) ? list : []);
        } else {
          const db = loadSampleDb();
          applyMessages(db.messages[String(sessionId)] ?? []);
        }
      } catch (e) {
        setError(`读取历史消息失败：${errText(e)}`);
        applyMessages([]);
      } finally {
        setLoadingMsgs(false);
      }
    },
    [applyMessages],
  );

  // 首次载入 + **课程上下文（courseId）变化**：重新拉列表并核对当前选中项。
  // （`listSessions` 的身份随 `courseId` 变化，所以这一个 effect 覆盖两种时机。）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listSessions();
      if (!alive) return;
      setSessions(list);
      setLoading(false);
      // 旧的 currentId 可能已**不在新列表里**：切了课程上下文、会话被改归属到别的课程、
      // 或在别处被删除。这里显式核对：不在列表 → 落回列表首个；列表为空 → 置 null 并清空消息区。
      // ⚠ 不能只写 `if (first) { … }`（本文件原来的写法）：列表为空时 currentId 会**停留**在一个
      //    不属于当前上下文的旧会话上 —— 界面看着像选中了它、消息区也还显示它的内容，
      //    而检索范围与归属已经和它无关（正是本次要修的串课隐患）。
      const prev = currentIdRef.current;
      const next = prev != null && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null);
      applyCurrentId(next);
      if (next != null) await loadMessages(next);
      else applyMessages([]);
    })();
    return () => {
      alive = false;
    };
  }, [listSessions, loadMessages, applyCurrentId, applyMessages]);

  // -------------------------------------------------------------------------
  // 会话增删
  // -------------------------------------------------------------------------

  const selectSession = useCallback(
    async (id: number) => {
      applyCurrentId(id);
      setError(null);
      await loadMessages(id);
    },
    [loadMessages, applyCurrentId],
  );

  const createSession = useCallback(
    async (title = "新对话"): Promise<number | null> => {
      try {
        let id: number;
        if (isTauri()) {
          id = await invokeStrict<number>("chat_session_create", {
            courseId: courseId ?? null,
            title,
          });
          await refreshSessions();
        } else {
          const db = loadSampleDb();
          id = allocId(db);
          db.sessions.unshift({
            id,
            course_id: courseId ?? null,
            title,
            summary: null,
            created_at: nowStr(),
            updated_at: nowStr(),
          });
          db.messages[String(id)] = [];
          saveSampleDb(db);
          setSessions(db.sessions.slice());
        }
        applyCurrentId(id);
        applyMessages([]);
        setError(null);
        return id;
      } catch (e) {
        setError(`新建会话失败：${errText(e)}`);
        return null;
      }
    },
    [courseId, refreshSessions, applyMessages, applyCurrentId],
  );

  const removeSession = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("chat_session_delete", { id });
        } else {
          const db = loadSampleDb();
          db.sessions = db.sessions.filter((s) => s.id !== id);
          delete db.messages[String(id)];
          saveSampleDb(db);
        }
        const list = await refreshSessions();
        if (currentId === id) {
          const next = list[0];
          if (next) {
            applyCurrentId(next.id);
            await loadMessages(next.id);
          } else {
            applyCurrentId(null);
            applyMessages([]);
          }
        }
        setError(null);
        return true;
      } catch (e) {
        setError(`删除会话失败：${errText(e)}`);
        return false;
      }
    },
    [currentId, refreshSessions, loadMessages, applyMessages, applyCurrentId],
  );

  /**
   * 修改**既有会话**的课程归属（契约 §2.1 `chat_session_set_course` / §3.2）。
   * - `courseId = null` → 把会话置为**不限定课程**；
   * - 桌面：`invokeStrict`（失败抛出，错误文本来自 Rust，例如「会话不存在（id=N）」）；
   * - 浏览器预览：就地改示例库 `sessions` 里的 `course_id` 再 `saveSampleDb`
   *   （`sample.ts` 的结构不动；与 `useCourses.archive` 同一套降级做法）；
   * - 成功 → 重新拉会话列表（归属变了，会话可能脱离当前课程上下文）；
   * - 失败 → 可读中文错误写进本 hook 的 `error`，**绝不静默**。
   */
  const setSessionCourse = useCallback(
    async (id: number, courseId: number | null): Promise<boolean> => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("chat_session_set_course", { id, courseId });
        } else {
          const db = loadSampleDb();
          const target = db.sessions.find((s) => s.id === id);
          if (!target) throw new Error(`会话不存在（id=${id}）`);
          target.course_id = courseId;
          saveSampleDb(db);
        }
        await refreshSessions();
        setError(null);
        return true;
      } catch (e) {
        setError(`修改会话归属失败：${errText(e)}`);
        return false;
      }
    },
    [refreshSessions],
  );

  /** 用首条提问给会话命名（失败只记日志：这是锦上添花，不该打断对话） */
  const renameSession = useCallback(
    async (id: number, title: string) => {
      try {
        if (isTauri()) {
          await invokeStrict<void>("chat_session_rename", { id, title });
        } else {
          const db = loadSampleDb();
          db.sessions = db.sessions.map((s) => (s.id === id ? { ...s, title } : s));
          saveSampleDb(db);
        }
        await refreshSessions();
      } catch (e) {
        console.warn("[chat] 会话重命名失败：", e);
      }
    },
    [refreshSessions],
  );

  // -------------------------------------------------------------------------
  // 消息写入
  // -------------------------------------------------------------------------

  const saveMessages = useCallback(async (sessionId: number, list: ChatMessage[]) => {
    if (isTauri()) {
      await invokeStrict<void>("chat_history_save", { sessionId, messages: list });
      return;
    }
    const db = loadSampleDb();
    db.messages[String(sessionId)] = list;
    db.sessions = db.sessions.map((s) =>
      s.id === sessionId ? { ...s, updated_at: nowStr() } : s,
    );
    saveSampleDb(db);
  }, []);

  /** 停掉正在进行的流式生成（保留已生成的部分） */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 发送一条消息。
   * - 没有可用会话时自动新建；
   * - `useMaterials=true`：先在本机材料里检索，把编号来源注入系统提示词，并把来源随消息落库；
   * - hasKey=false → 演示模式（写死文案，不调模型；检索照做，但界面上标明"这不是它的引用"）；
   * - hasKey=true  → 走 lib/ai.ts 的流式接口。
   */
  const send = useCallback(
    async (
      text: string,
      mode: AskMode = "explain",
      useMaterials = false,
      images: string[] = [],
    ): Promise<void> => {
      const content = text.trim();
      // R4：允许"只有图片、没有文字"的提问（只贴一张题图直接问，是最常见的用法）
      if ((!content && images.length === 0) || sending) return;
      const imgs = images.filter((s) => typeof s === "string" && s.length > 0);

      setError(null);
      setSending(true);

      let sid = currentId;
      if (sid == null) {
        sid = await createSession(content.slice(0, 20) || "图片提问");
      }
      if (sid == null) {
        setSending(false);
        return;
      }

      const userMsg: ChatMessage = {
        role: "user",
        content,
        created_at: nowStr(),
        images: imgs.length > 0 ? imgs : null,
      };
      const history = msgsRef.current;
      const withUser = [...history, userMsg];
      applyMessages(withUser);

      // 首条消息顺手给会话命名
      if (history.length === 0) {
        void renameSession(sid, content.slice(0, 20) || "图片提问");
      }

      // —— M1：先查课程材料（本机检索，不联网），把来源喂给模型 ——
      // 演示模式也照做：检索是本机能力，与有没有 Key 无关；
      // 但用 demo_ 前缀把"这不是演示文案的引用"标出来，界面据此措辞。
      const demoPrefix = hasKey ? "" : "demo_";
      let sysExtra = "";
      let refs: MsgRef[] = [];
      let sourceKind: string | null = null;
      if (useMaterials) {
        setSearching(true);
        try {
          // 检索范围：**当前会话归属优先，其次 URL 课程上下文**，两者都没有 → null（全库）。
          // 口径与对话页的 `scopeText` 同源（`lib/courseScope.effectiveScope`）：
          // 界面写"全库"就必须查全库、写某课就必须只查该课（契约 §一 第 2 条）。
          const ownCourse = sessions.find((se) => se.id === sid)?.course_id ?? null;
          const searchCourse = effectiveScope(ownCourse, courseId ?? null).courseId;
          // M2：中文提问通常没有空格，先抽内容关键词再检索（否则整句进 FTS/LIKE 几乎必然 0 命中）；
          // 抽不出来时 extractSearchTermsWithInfo 会退回整句，并把 fallback 标出来给 UI 如实说明。
          const picked = extractSearchTermsWithInfo(content, 3);
          const outcome = await materialSearch(searchCourse, picked.terms.join(" "), 8);
          setLastSearch({
            terms: picked.terms,
            fallback: picked.fallback,
            hits: outcome.ok ? outcome.hits.length : 0,
            failed: !outcome.ok,
          });
          if (!outcome.ok) {
            sourceKind = `${demoPrefix}search_failed`;
            sysExtra = SEARCH_FAILED_BLOCK;
            setError(`课程材料检索失败，本条回答没有材料出处，请自行核对：${outcome.error}`);
          } else if (outcome.hits.length === 0) {
            sourceKind = `${demoPrefix}no_material`;
            sysExtra = NO_MATERIAL_BLOCK;
          } else {
            sourceKind = `${demoPrefix}material`;
            refs = refsFromHits(outcome.hits);
            sysExtra = buildMaterialBlock(outcome.hits);
          }
        } finally {
          setSearching(false);
        }
      } else {
        // 关闭"先查课程材料"时，清掉上一轮的检索词提示（与 M0 行为一致：不检索、不标出处）
        setLastSearch(null);
      }
      const refsJson = serializeRefs(refs);

      // —— R4：图片路由（必须在调模型之前定下来：决定"发图"还是"发文字"）——
      //   ① 主模型看着能看图 → 直接发图；
      //   ② 否则若配了独立视觉模型 → 先转成文字，把文字拼进提问；
      //   ③ 都不满足 → 明确报错并给可操作建议（**绝不假装看懂了图**）；
      //      但用户消息仍然落库 —— 图不能白贴，配好模型后还能回看。
      let directImages: string[] = [];
      let imageAddon = "";
      if (imgs.length > 0) {
        const mainLooks = looksVisionCapable(ai.model ?? "");
        const wantTranscribe =
          imageMode === "transcribe" || (imageMode === "auto" && !mainLooks);
        // 要走转写时用哪套配置：优先独立视觉模型；用户明确要求"一律转写"时退回主模型
        // （他清楚主模型能看图，只是想把图变成文字再问 —— 例如为了省 token）
        const vcfg = vision ?? (imageMode === "transcribe" ? ai : null);

        if (wantTranscribe && !vcfg) {
          setError(
            `这 ${imgs.length} 张图这次用不上：当前模型（${ai.model || "未填模型名"}）看不了图片，` +
              `也没有单独配置视觉模型。两种改法：到「数据设置」把模型换成支持视觉的（如 qwen-vl / gpt-4o / glm-4v），` +
              `或在同一页的「图片识别」里单独指定一个能看图的模型。` +
              `图片已随这条消息保存在本机，配好之后可以回看。`,
          );
          try {
            await saveMessages(sid, withUser);
          } catch (e) {
            setError(`消息保存失败：${errText(e)}`);
          }
          setSending(false);
          return;
        }

        if (wantTranscribe && vcfg) {
          setImageBusy(true);
          try {
            const results = await transcribeDataUrls(vcfg, imgs);
            const okOnes: string[] = [];
            const bad: string[] = [];
            results.forEach((r, i) => {
              if (r.ok && r.text.trim()) okOnes.push(r.text.trim());
              else bad.push(`第 ${i + 1} 张：${r.err ?? "模型没有返回内容"}`);
            });
            if (okOnes.length === 0) {
              setError(`图片没能转成文字：${bad.join("；")}`);
              try {
                await saveMessages(sid, withUser);
              } catch (e) {
                setError(`消息保存失败：${errText(e)}`);
              }
              setSending(false);
              return;
            }
            imageAddon =
              "\n\n【图片转写的文字 · 模型转写，非原文】\n" +
              okOnes.map((t, i) => `（第 ${i + 1} 张）\n${t}`).join("\n\n") +
              (bad.length > 0 ? `\n\n（另有 ${bad.length} 张没转成功：${bad.join("；")}）` : "");
          } finally {
            setImageBusy(false);
          }
        } else {
          directImages = imgs;
        }
      }

      // —— 演示模式：不调模型 ——
      if (!hasKey) {
        const demo: ChatMessage = {
          role: "assistant",
          content:
            imgs.length > 0
              ? `${DEMO_REPLY}\n\n（这次还带了 ${imgs.length} 张图片：演示模式下不调用任何模型，` +
                `所以图片没有被解析 —— 它已随这条消息保存在本机。）`
              : DEMO_REPLY,
          refs: refsJson,
          source_kind: sourceKind,
          created_at: nowStr(),
        };
        const next = [...withUser, demo];
        applyMessages(next);
        try {
          await saveMessages(sid, next);
        } catch (e) {
          setError(`消息保存失败：${errText(e)}`);
        }
        setSending(false);
        return;
      }

      // —— 真实调用：流式 ——
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const acc: ChatMessage = {
        role: "assistant",
        content: "",
        refs: refsJson,
        source_kind: sourceKind,
        created_at: nowStr(),
      };
      const base = [...withUser, acc];
      applyMessages(base);

      const sys = sysExtra ? `${systemPromptFor(mode)}\n\n${sysExtra}` : systemPromptFor(mode);
      // R4：只有**本轮**这条用户消息带图片 / 转写补充；历史一律纯文本 ——
      //   多轮图片会把上下文与费用顶爆，且历史图对当前问题通常没有增量信息。
      //   注意过滤条件要放行"只有图、没有文字"的消息（否则它会被整条丢掉）。
      const trimmed = withUser.filter(
        (m) =>
          m.role !== "system" &&
          (m.content.trim().length > 0 || (m.images?.length ?? 0) > 0),
      );
      const apiMessages: ApiMsg[] = [
        { role: "system", content: sys },
        ...trimmed.slice(-20).map((m, i, arr) => {
          const isLast = i === arr.length - 1;
          const text = isLast && imageAddon ? `${m.content}${imageAddon}` : m.content;
          const use = isLast ? directImages : [];
          if (m.role === "user" && use.length > 0) {
            const parts: ApiContentPart[] = [
              { type: "text", text: text || "（请看图片）" },
              ...use.map((u) => ({ type: "image_url" as const, image_url: { url: u } })),
            ];
            return { role: "user", content: parts } as ApiMsg;
          }
          return { role: m.role === "assistant" ? "assistant" : "user", content: text } as ApiMsg;
        }),
      ];

      try {
        await chatStream(ai, apiMessages, {
          signal: ctrl.signal,
          onDelta: (delta) => {
            acc.content += delta;
            applyMessages([...withUser, { ...acc }]);
          },
        });
      } catch (e) {
        const aborted = ctrl.signal.aborted;
        if (!aborted) {
          setError(`模型调用失败：${errText(e)}（请到「数据设置」检查接口地址 / Key / 模型名，或点「测试连接」）`);
        }
      } finally {
        abortRef.current = null;
        setSending(false);
        // 空回复（失败或立刻中止）不落库，避免留下空助手消息
        const finalList = [...withUser, ...(acc.content.trim() ? [acc] : [])];
        applyMessages(finalList);
        try {
          await saveMessages(sid, finalList);
        } catch (e) {
          setError(`消息保存失败：${errText(e)}`);
        }
      }
    },
    [
      ai,
      applyMessages,
      courseId,
      createSession,
      currentId,
      hasKey,
      imageMode,
      renameSession,
      saveMessages,
      sending,
      sessions,
      vision,
    ],
  );

  // -------------------------------------------------------------------------
  // R4：悬浮球问答落库后的界面刷新
  // -------------------------------------------------------------------------
  /**
   * 悬浮球完成一次问答时，**主程序（Rust 桥接线程）已经把消息写进库了**
   * （见 `db::ball_append_qa`）—— 这里只负责刷新界面，不重复落库。
   *
   * ⚠ 分工要记牢：落库在 Rust、刷新在前端。若哪天把这句挪回前端来写库，
   *   就会退回"球问答依赖主程序界面开着"的老问题（`docs/11` §六 G4）。
   */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    void (async () => {
      const un = await onBallPush((payload) => {
        if (payload.action !== "ask") return;
        void (async () => {
          try {
            const list = await refreshSessions();
            const sid = (payload as { session_id?: number }).session_id;
            if (sid != null && currentIdRef.current === sid) {
              await loadMessages(sid);
            }
            // 该课程下的会话列表变化（球可能新建了「悬浮球问答」会话），
            // 但当前选中的不是它 —— 只需列表已刷新，不做任何静默跳转。
            void list;
          } catch (e) {
            console.warn("[chat] 悬浮球问答落下后刷新失败：", e);
          }
        })();
      });
      if (alive) unlisten = un;
      else un();
    })();
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [refreshSessions, loadMessages]);

  return {
    sessions,
    currentId,
    messages,
    loading,
    loadingMsgs,
    sending,
    searching,
    imageBusy,
    lastSearch,
    error,
    setError,
    selectSession,
    createSession,
    removeSession,
    setSessionCourse,
    refreshSessions,
    send,
    stop,
  };
}
