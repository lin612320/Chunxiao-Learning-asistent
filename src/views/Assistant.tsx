import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useChat } from "../hooks/useChat";
import { useSettings } from "../hooks/useSettings";
import { useCourses } from "../hooks/useCourses";
import { ASK_MODES, type AskMode } from "../lib/ai";
import { parseRefs } from "../data/sample";
import { refTitle } from "../lib/materials";
import Highlight from "../lib/highlight";
import { isTauri } from "../lib/tauri";
import Mascot from "../components/Mascot";
import Icon from "../components/Icon";
import TechNote from "../components/TechNote";
import { collectImages, dataUrlBytes, humanBytes, imagesFromClipboard } from "../lib/images";
// R1（契约 `docs/11-R1对话课程归属与先验知识提炼契约.md` §3.1 / §3.2）：
// 课程上下文与检索范围的口径统一放在 lib/courseScope.ts，避免各页各写一套。
import {
  assistantPath,
  courseLabel,
  courseOptionLabel,
  effectiveScope,
  NO_COURSE_LABEL,
  parseCourseParam,
  parseFloatParam,
  readLastCourseId,
  rememberLastCourseId,
  scopeTextOf,
} from "../lib/courseScope";

export default function Assistant() {
  const { search } = useLocation();
  const nav = useNavigate();
  // 悬浮球小窗复用本页：?float=1 走紧凑模式（Layout 已去掉侧栏与顶栏）
  // —— 既有冻结行为，改课程上下文/改归属时也要**保留**这个参数（见 gotoCourseContext）。
  const isFloat = parseFloatParam(search);
  // R1：`/assistant?course=N` = 该课程上下文；`/assistant` 无参数 = **不限定课程**（§3.1）
  const urlCourseId = parseCourseParam(search);

  const { s, hasKey, visionConfig } = useSettings();
  const { courses } = useCourses();
  const {
    sessions,
    currentId,
    messages,
    loading,
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
    send,
    stop,
  } = useChat({
    ai: s.ai,
    hasKey,
    courseId: urlCourseId, // ← G1/G2/G3 的修复点：把课程上下文接上数据层
    vision: visionConfig,
    imageMode: s.imageMode,
  });

  const [text, setText] = useState("");
  const [mode, setMode] = useState<AskMode>("explain");
  /** M1：默认开启「先查课程材料再回答」 */
  const [useMaterials, setUseMaterials] = useState(true);
  /** R4：本轮要随问题发出去的图片（已压缩的 dataURL） */
  const [images, setImages] = useState<string[]>([]);
  /** R4：图片相关的**如实提示**（被拒的原因等），不静默丢弃 */
  const [imgNotice, setImgNotice] = useState<string | null>(null);
  /** R4：点击缩略图放大查看 */
  const [zoom, setZoom] = useState<string | null>(null);
  /** R1：改归属成功后的**明说**提示（移到哪门课 / 改成不限定课程） */
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  /** R1：最近课程提示条被忽略后，本次会话内不再出现（它只是**可选**提示，绝不自动套用） */
  const [lastCourseHintOff, setLastCourseHintOff] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息 / 流式增量时自动滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, searching]);

  // URL 上带 `course=N` = 用户的一次**显式选择**（课程页入口或对话页选择器），记下来供可选提示条用。
  // ⚠ 只在有 `course` 参数时写：`/assistant` 无参数**就是不限定课程**，
  //    绝不在这里"顺手"套用最近课程（§一 第 3 条）。
  useEffect(() => {
    if (urlCourseId != null) rememberLastCourseId(urlCourseId);
  }, [urlCourseId]);

  async function handleSend() {
    const t = text.trim();
    // R4：允许"只有图片、没有文字"（贴一张题图直接问是最常见的用法）
    if ((!t && images.length === 0) || sending) return;
    const sendingImages = images;
    setText("");
    setImages([]);
    setImgNotice(null);
    await send(t, mode, useMaterials, sendingImages);
  }

  /** R4：粘贴图片 —— 截图后直接 Ctrl+V。纯文本粘贴**不拦**，照旧交给 textarea。 */
  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = imagesFromClipboard(e.nativeEvent);
    if (files.length === 0) return; // 没有图片 → 让它走默认的文本粘贴
    e.preventDefault();
    const { images: added, rejected } = await collectImages(files, images);
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
    setImgNotice(
      rejected.length > 0
        ? rejected.join("\n")
        : added.length > 0
          ? `已放入 ${added.length} 张图片（会随这次提问一起发给模型）`
          : null,
    );
  }

  /** 拖拽图片进来也支持（与粘贴走同一条压缩链路） */
  async function handleDropImages(e: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    const { images: added, rejected } = await collectImages(files, images);
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
    setImgNotice(rejected.length > 0 ? rejected.join("\n") : `已放入 ${added.length} 张图片`);
  }

  const current = sessions.find((x) => x.id === currentId);
  const modeHint = ASK_MODES.find((m) => m.key === mode)?.hint ?? "";

  /** 当前会话的归属（`null` = 不限定课程）；会话不在列表里时按"无"处理 */
  const ownCourseId = current?.course_id ?? null;

  // 检索范围：**当前会话归属优先，其次 URL 课程上下文**（§3.2）；
  // 两者都没有时 scopeTextOf 会**逐字**给出「检索范围：全部课程材料（本机全库）」。
  // 口径与实际检索同源（useChat 的 send 也用 effectiveScope），界面写什么就按什么查（§一 第 2 条）。
  const scope = effectiveScope(ownCourseId, urlCourseId);
  const scopeText = scopeTextOf(scope.courseId, courses, scope.origin);

  /** 最近一次显式选择的课程（只用于可选提示条；不改变任何检索范围） */
  const lastCourseId = readLastCourseId();
  const lastCourseKnown = lastCourseId != null ? courses.find((c) => c.id === lastCourseId) : undefined;
  // 提示条只在「URL 没有课程参数」时出现（已经有上下文就没必要再问），且**不自动**改变任何东西。
  // 课程已不在列表里（例如被删了）就不提示 —— 免得"切过去"落在一个不存在的课程上。
  const hintCourse =
    urlCourseId == null && !lastCourseHintOff && lastCourseKnown ? lastCourseKnown : undefined;

  /** 切换课程上下文：写 URL（保留 ?float=1）+ 记最近课程；**不**自动改任何会话的归属 */
  function gotoCourseContext(next: number | null) {
    setMoveNotice(null);
    rememberLastCourseId(next); // 选「不限定课程」= 显式取消，清掉最近课程
    nav(assistantPath(next, { float: isFloat }));
  }

  /**
   * 改当前会话的归属（§3.2）：成功后**跟随切换上下文**并明说移到哪门课；
   * 失败时错误已由 useChat 写进 `error`（界面可见，绝不静默），这里不再切换上下文。
   */
  async function handleSetSessionCourse(next: number | null) {
    if (!current) return;
    const title = current.title;
    const ok = await setSessionCourse(current.id, next);
    if (!ok) return;
    setMoveNotice(
      next == null
        ? `已把会话「${title}」改为不限定课程（已跟随切换对话上下文）`
        : `已把会话「${title}」移到《${courseLabel(next, courses)}》（已跟随切换对话上下文）`,
    );
    rememberLastCourseId(next);
    nav(assistantPath(next, { float: isFloat }));
  }

  return (
    <div className={"assistant-page" + (isFloat ? " float" : "")}>
      {/* 顶部说明（紧凑模式下只留一行） */}
      <div className="assistant-bar">
        <div>
          <b>与春晓对话</b>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            面向课后理解与复习 · 不面向考试场景
          </span>
        </div>
        <div className="assistant-actions">
          {!hasKey && <span className="tag tag-warn">演示模式</span>}
          <span className="tag">数据都在这台电脑上</span>
        </div>
      </div>

      {/* R1：课程上下文 + 当前会话归属（契约 §一 第 1 条：界面必须**始终可见**当前课程上下文）。
          两个选择器只是"显示 + 显式选择"：上下文决定本页会话列表/新建会话/材料检索范围；
          改归属是显式动作，成功后明说并跟随切换上下文。 */}
      <div className="chat-scope-bar">
        <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
          在聊哪门课
        </span>
        <select
          className="course-select"
          value={urlCourseId != null ? String(urlCourseId) : ""}
          disabled={sending}
          title="选定后：这里的对话列表只看这门课，新对话会归到这门课，找材料也只在这门课里找。选「不限定课程」= 在这台电脑上的全部课程材料里找。切换只影响之后的提问，不会改动已有对话的归属。"
          onChange={(e) => gotoCourseContext(e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="">{NO_COURSE_LABEL}</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {courseOptionLabel(c)}
            </option>
          ))}
          {/* 当前课程不在列表里（已删除 / 列表还没加载完）时补一个兜底选项：绝不让当前课程变成空选中 */}
          {urlCourseId != null && !courses.some((c) => c.id === urlCourseId) && (
            <option value={urlCourseId}>{courseLabel(urlCourseId, courses)}</option>
          )}
        </select>

        {current && (
          <>
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
              这个对话属于
            </span>
            <select
              className="course-select"
              value={ownCourseId != null ? String(ownCourseId) : ""}
              disabled={sending}
              title="把这个对话挪到某门课下（或改成不属于任何课）。改完会明确提示，并跟着切到那门课。"
              onChange={(e) =>
                void handleSetSessionCourse(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">{NO_COURSE_LABEL}</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {courseOptionLabel(c)}
                </option>
              ))}
              {ownCourseId != null && !courses.some((c) => c.id === ownCourseId) && (
                <option value={ownCourseId}>{courseLabel(ownCourseId, courses)}</option>
              )}
            </select>
          </>
        )}
        {currentId != null && !current && (
          <span className="muted" style={{ fontSize: 12 }}>
            （这个对话不在当前课程里）
          </span>
        )}
      </div>

      {/* R1：可选提示条 —— 绝不自动改变检索范围（§一 第 3 条）；只有点「切过去」才会切上下文 */}
      {hintCourse && (
        <div className="demo-banner">
          <span>
            上次你在《{hintCourse.name}》学习，切过去吗？
            <b>这只是提示：点「切过去」之前，这里在聊哪门课、去哪找材料都不会变。</b>
          </span>
          <button className="ghost-btn" onClick={() => gotoCourseContext(hintCourse.id)}>
            切过去
          </button>
          <button className="ghost-btn" onClick={() => setLastCourseHintOff(true)}>
            忽略
          </button>
        </div>
      )}

      {/* 浏览器预览：材料检索走的是示例数据，必须说明，不能冒充用户的真实材料 */}
      {!isTauri() && useMaterials && (
        <div className="demo-banner">
          <span>
            <b>网页预览模式</b>：这里找材料用的是<b>示例数据</b>（不是你自己的材料），只用来试界面；
            桌面版才会在你这台电脑上真正去材料里找。
          </span>
        </div>
      )}

      {/* 未配置 Key：明确说明不会调模型 */}
      {!hasKey && (
        <div className="demo-banner">
          <span>
            <b>演示模式</b>：还没有填模型 Key，春晓<b>不会调用任何模型</b>，
            这里的回复是程序写好的固定说明。请先到 <Link to="/settings">数据设置</Link> 选一个服务商、填入你的 Key，
            点「测试连接」通过后保存。
          </span>
        </div>
      )}

      {/* 会话列表 */}
      <div className="session-bar">
        <button className="chip chip-new" onClick={() => void createSession()} title="新建一个对话">
          <Icon name="plus" size={15} />
          新对话
        </button>
        {loading ? (
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            加载会话…
          </span>
        ) : sessions.length === 0 ? (
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            还没有会话，直接提问会自动新建一个。
          </span>
        ) : (
          sessions.map((se) => (
            <button
              key={se.id}
              className={"chip" + (se.id === currentId ? " chip-active" : "")}
              onClick={() => void selectSession(se.id)}
              title={se.title}
            >
              {se.title}
            </button>
          ))
        )}
        {currentId != null && (
          <button
            className="chip session-del"
            title="删除当前会话（不可撤销）"
            onClick={() => {
              if (window.confirm(`确定删除会话「${current?.title ?? ""}」吗？消息将一并删除。`)) {
                void removeSession(currentId);
              }
            }}
          >
            删除会话
          </button>
        )}
      </div>

      {/* R1：改归属成功后的明说提示（§3.2）；点击可关闭 */}
      {moveNotice && (
        <div className="settings-msg ok" title="点击关闭" onClick={() => setMoveNotice(null)}>
          {moveNotice}
        </div>
      )}

      {error && (
        <div className="settings-msg err" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* 消息区 */}
      <div className="assistant-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="assistant-empty">
            {/* 空态主视觉：把「春晓」这个形象摆出来，比一句冷冰冰的"问点什么吧"亲近得多。
                装饰性图像 → alt 留空（读屏软件不该念它）。 */}
            <Mascot size={124} />
            <div className="assistant-empty-title">问点什么吧</div>
            <div>
              例如：「均摊分析到底在算什么？」「把红黑树的性质讲得再浅一点」。
              <br />
              打开「先查课程材料再回答」后，春晓会先从你的问题里挑出关键词，到这台电脑上的课程材料里找一找，
              把找到的段落当作参考一起交给模型；回答下面会列出参考来源，并把找到的词标黄。
              一个都没找到时会<b>明确写明这条回答没有材料出处</b>，也会告诉你这次用了哪些词去找。
              <br />
              标着「AI 生成 · 待核对」的课程知识点，确认过再当依据用。
            </div>
            {!hasKey && (
              <Link to="/settings" className="assistant-setup">
                去填模型 Key（只存在这台电脑上）
                <Icon name="chevron-right" />
              </Link>
            )}
          </div>
        ) : (
          messages
            .filter((m) => m.role !== "system")
            .map((m, i) => {
              const refs = parseRefs(m.refs);
              const kind = m.source_kind ?? "";
              const fromDemo = kind.startsWith("demo_");
              const noMaterial = kind.endsWith("no_material");
              const searchFailed = kind.endsWith("search_failed");
              // 本轮检索词：优先用每条引用自带的 terms（Rust 实际使用的词，旧数据可能没有）
              const refTerms = Array.from(new Set(refs.flatMap((r) => r.terms ?? [])));
              return (
                <div className={"msg " + (m.role === "user" ? "user" : "assistant")} key={i}>
                  <div className="msg-col">
                    {/* R4：本轮提问带的图片（随消息落库，可回看、可放大） */}
                    {m.images && m.images.length > 0 ? (
                      <div className="msg-imgs">
                        {m.images.map((src, k) => (
                          <button
                            type="button"
                            className="msg-img"
                            key={k}
                            onClick={() => setZoom(src)}
                            title="点击放大"
                          >
                            <img src={src} alt={`第 ${k + 1} 张图片`} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="msg-bubble">{m.content}</div>

                    {/* 没找到 / 查找出错：显式标注"没有材料出处" */}
                    {m.role === "assistant" && searchFailed && (
                      <div className="src-flag src-flag-warn">
                        <Icon name="alert" size={15} />
                        这次没能在材料里找（找的过程出错了）· 本条没有材料出处，内容请自行核对
                      </div>
                    )}
                    {m.role === "assistant" && noMaterial && (
                      <div className="src-flag src-flag-none">
                        <Icon name="alert" size={15} />
                        没有材料出处 · 没在你的课程材料里找到相关内容（以下内容来自模型自己知道的东西，请自行核对）
                      </div>
                    )}

                    {/* 参考来源（可折叠）：材料名 · 标题路径 · 片段摘要（找到的词高亮，安全渲染） */}
                    {m.role === "assistant" && refs.length > 0 && (
                      <details className="refs-box">
                        <summary>
                          {fromDemo ? "材料里找到的原文" : "参考来源"}（{refs.length}）
                          {refTerms.length > 0 ? ` · 这次用的词：${refTerms.join(" · ")}` : ""}
                        </summary>
                        <div className="refs-hint">
                          {fromDemo
                            ? "这条回复是程序写好的固定说明（没有调用模型），下面只是在你材料里找到的原文，不是它的引用。"
                            : "下面这些段落来自你导入的课程材料（是在这台电脑上找到的原文，不是 AI 写的）；回答里引用的地方请对照核对。"}
                          {refTerms.length > 0 && " 标黄的地方就是这次用到的词。"}
                        </div>
                        <ol className="refs-list">
                          {refs.map((r, j) => (
                            <li key={j}>
                              <div className="refs-title">
                                【{j + 1}】
                                <Highlight text={refTitle(r)} terms={r.terms ?? refTerms} />
                                {typeof r.page === "number" ? ` · 第 ${r.page} 页` : ""}
                              </div>
                              <div className="refs-snippet">
                                <Highlight text={r.snippet} terms={r.terms ?? refTerms} />
                              </div>
                              {r.terms && r.terms.length > 0 && (
                                <div className="refs-terms">这一条里用到的词：{r.terms.join(" · ")}</div>
                              )}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                </div>
              );
            })
        )}
        {imageBusy && (
          <div className="loading-line">
            正在让视觉模型把图片转成文字…（这一步用的是你配的视觉模型，转完再交给主模型回答）
          </div>
        )}
        {searching && <div className="loading-line">正在这台电脑上的课程材料里找…（不联网）</div>}

        {/* 如实告诉用户这次用了哪些词、找到多少（一个都没找到也要说清为什么） */}
        {useMaterials && lastSearch && !searching && (
          <div className="mat-search-trace">
            <span>
              这次用的词：
              <b>{lastSearch.terms.length > 0 ? lastSearch.terms.join(" · ") : "（没有）"}</b>
              {lastSearch.fallback ? "（没挑出关键词，就用整句去找）" : ""}
            </span>
            <span className="muted">
              {lastSearch.failed
                ? "· 这次没能在材料里找（找的过程出错了），本条没有材料出处"
                : lastSearch.hits > 0
                  ? `· 在材料里找到 ${lastSearch.hits} 段（已标黄）`
                  : "· 材料里没找到：这条回答不会把模型自己知道的东西说成来自你的材料"}
            </span>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="assistant-input">
        <div className="mode-chips">
          {ASK_MODES.map((m) => (
            <button
              key={m.key}
              className={"chip" + (mode === m.key ? " chip-active" : "")}
              title={m.hint}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </button>
          ))}
          <span className="muted" style={{ fontSize: 12 }}>
            {modeHint}
          </span>
        </div>
        <div className="mat-toggle-row">
          <label className="mat-toggle" title="打开后：先从你的问题里挑关键词，再到这台电脑上的课程材料里找，把找到的段落作为参考一起交给模型">
            <input
              type="checkbox"
              checked={useMaterials}
              disabled={sending}
              onChange={(e) => setUseMaterials(e.target.checked)}
            />
            <span>
              <Icon name="book" size={15} />
              先查课程材料再回答
            </span>
          </label>
          <span className="muted mat-scope">
            {useMaterials ? scopeText : "已关闭：这次按普通对话回答，不去找材料、也不标出处"}
          </span>
        </div>

        {/* 折叠区：检索的完整机制（原来塞在 title 里，读起来像开发文档） */}
        <TechNote title="「先查课程材料再回答」是怎么工作的？">
          <p>
            打开后，春晓会先从你的问题里挑出关键词（中文长句整句去搜几乎一定搜不到），
            再到你这台电脑上的课程材料里找一找，把找到的段落编号后一起交给模型；
            回答下面会列出参考来源，并把用到的词标黄。
          </p>
          <p>
            一个都没找到时，会明确写明这条回答没有材料出处，并告诉你这次用了哪些词。
            材料检索全部在这台电脑上完成，不联网；只有你提出的问题会发给模型。
          </p>
        </TechNote>
        {/* R4：图片区（粘贴 / 拖入）——缩略图 + 可删 + 如实提示被拒原因 */}
        {images.length > 0 && (
          <div className="img-strip">
            {images.map((src, i) => (
              <span className="img-thumb" key={i}>
                <button
                  type="button"
                  className="img-thumb-pic"
                  onClick={() => setZoom(src)}
                  title="点击放大"
                >
                  <img src={src} alt={`第 ${i + 1} 张待发送的图片`} />
                </button>
                <button
                  type="button"
                  className="img-thumb-x"
                  onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))}
                  title="移除这张"
                  aria-label="移除这张图片"
                >
                  <Icon name="close" size={12} />
                </button>
                <span className="img-thumb-size">{humanBytes(dataUrlBytes(src))}</span>
              </span>
            ))}
            <button type="button" className="ghost-btn img-strip-clear" onClick={() => setImages([])}>
              全部移除
            </button>
          </div>
        )}
        {imgNotice && (
          <div className="img-notice" onClick={() => setImgNotice(null)} role="status">
            {imgNotice}
          </div>
        )}
        <div
          className="assistant-drop"
          onDrop={(e) => void handleDropImages(e)}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
        >
          <textarea
            rows={isFloat ? 2 : 3}
            value={text}
            placeholder={
              hasKey
                ? "输入问题；截图后可直接 Ctrl+V 粘贴图片（Enter 换行，Ctrl+Enter 发送）"
                : "现在是演示模式：可以先试试界面，填好 Key 之后才会真正让模型回答"
            }
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => void handlePaste(e)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
        </div>
        <div className="assistant-input-foot">
          <span className="muted" style={{ fontSize: 12 }}>
            AI 写的内容要自己核对 · 对话与材料只存在这台电脑上
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {sending && (
              <button className="ghost-btn" onClick={stop} title="停止生成（保留已生成内容）">
                停止
              </button>
            )}
            <button
              className="primary small"
              disabled={sending || (!text.trim() && images.length === 0)}
              onClick={() => void handleSend()}
            >
              {sending ? "生成中…" : images.length > 0 ? `发送（含 ${images.length} 图）` : "发送"}
            </button>
          </div>
        </div>
      </div>

      {/* R4：点击缩略图放大查看（纯前端，不请求任何服务） */}
      {zoom && (
        <div className="img-zoom" onClick={() => setZoom(null)} role="dialog" aria-label="放大查看图片">
          <img src={zoom} alt="放大的图片" />
          <span className="img-zoom-hint">点击任意处关闭</span>
        </div>
      )}
    </div>
  );
}
