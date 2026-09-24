// 浏览器预览用示例数据 + 前端数据模型类型定义。
//
// 用途：`!isTauri()` 时（`npx vite` 直接在浏览器里调 UI）各 hook 降级到这里，
// 保证前端可以脱离 Rust 单独调试。浏览器里的增删改会写进 localStorage，
// 刷新不丢；清空可用 `resetSampleDb()`。
//
// ⚠️ 字段口径：类型里的 **snake_case** 是 SQLite 行原样序列化后的键名
//   （Rust 侧 `courses_list` 返回 `Vec<Value>`，键名就是表列名）。
//    命令**参数**才是 camelCase —— 见 `lib/tauri.ts` 的 invokeStrict 注释。

export interface Course {
  id: number;
  name: string;
  term?: string | null;
  teacher?: string | null;
  intro?: string | null;
  cover?: string | null;
  archived: number; // 0 | 1
  created_at: string;
}

/** 先验知识条目：`source` 必填，是 §7.3 溯源口径的落地字段 */
export interface PriorItem {
  id: number;
  course_id: number;
  parent_id?: number | null;
  topic: string;
  summary?: string | null;
  detail?: string | null;
  /** ai | textbook | web | user | <材料名> */
  source: string;
  source_ref?: string | null;
  confidence?: number | null;
  verified: number; // 0 | 1
  created_at: string;
}

export interface MaterialItem {
  id: number;
  course_id: number;
  file_name: string;
  file_path: string;
  kind?: string | null;
  size_bytes?: number | null;
  /** local（本地离线提取） | model（视觉模型转录） */
  extracted_by: string;
  text_len?: number | null;
  /** M1：该材料在 material_chunks 里的切块数（Rust materials_list 的 chunk_count 列） */
  chunk_count?: number | null;
  truncated: number; // 0 | 1
  note?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// M1：材料检索与引用（契约 `03-M1材料导入与检索契约.md` §2.1 / §4.2）
// ---------------------------------------------------------------------------

/**
 * `material_search` 的一行命中（**snake_case，键名与契约返回逐字一致**）。
 * 无命中时 Rust 返回 `[]`，不会返回 null。
 */
export interface MaterialHit {
  chunk_id: number;
  material_id: number;
  /** 材料文件名 */
  material: string;
  kind?: string | null;
  /** 该块在材料内的序号 */
  seq?: number | null;
  /** 页码（拿不到就是 null —— 不编造） */
  page?: number | null;
  /** 标题路径（Markdown 标题等；拿不到就是 null） */
  heading?: string | null;
  /** 关键词附近裁切出的片段（Rust 侧裁切） */
  snippet: string;
  /** 相关度，越大越相关（Rust 已统一成"越大越相关"） */
  score: number;
  /**
   * M2：本次检索**实际使用的词列表**（Rust `material_search` 新增字段），前端拿它做命中高亮。
   * 旧数据 / 早期实现可能没有这个字段 → 前端必须容忍缺失（退化为不高亮）。
   */
  terms?: string[];
}

/**
 * 随消息持久化的一条引用（落进 `chat_messages.refs` 的 JSON 数组）。
 * Rust 侧 `ChatMsg.refs` 用 `Value` 接收、以文本形式落库，
 * `chat_history_load` 读回来是**字符串**，所以读写都用 parseRefs/serializeRefs。
 */
export interface MsgRef {
  material: string;
  heading?: string | null;
  snippet: string;
  material_id?: number | null;
  chunk_id?: number | null;
  page?: number | null;
  score?: number | null;
  /** M2：命中高亮用的词表（本条引用对应的那次检索）；缺失时前端退化为不高亮 */
  terms?: string[];
}

/** 从任意值里取出一个安全的词表（非数组 / 非字符串项一律丢掉） */
function parseTerms(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8);
  return out.length > 0 ? out : undefined;
}

/** 把 `refs`（可能是 JSON 字符串 / 数组 / null）解析成引用数组；解析不了就当没有。 */
export function parseRefs(raw: unknown): MsgRef[] {
  if (raw == null) return [];
  let v: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      v = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      material: typeof x.material === "string" ? x.material : "（未标注材料）",
      heading: typeof x.heading === "string" ? x.heading : null,
      snippet: typeof x.snippet === "string" ? x.snippet : "",
      material_id: typeof x.material_id === "number" ? x.material_id : null,
      chunk_id: typeof x.chunk_id === "number" ? x.chunk_id : null,
      page: typeof x.page === "number" ? x.page : null,
      score: typeof x.score === "number" ? x.score : null,
      terms: parseTerms(x.terms),
    }));
}

/** 把引用数组序列化成落库用的 JSON 字符串（空数组返回 null，不留空串） */
export function serializeRefs(list: MsgRef[]): string | null {
  return list.length > 0 ? JSON.stringify(list) : null;
}

export interface ChatSession {
  id: number;
  course_id?: number | null;
  title: string;
  summary?: string | null;
  created_at: string;
  updated_at?: string | null;
  /**
   * R5：会话来源 —— `"app"` 主窗口 / `"ball"` 悬浮球。
   *
   * 缺省按 `"app"` 处理（与 Rust 侧 `origin TEXT NOT NULL DEFAULT 'app'` 同口径）：
   * 旧示例数据、旧库里都没有这个字段，**不能**把它当成"第三种来源"。
   */
  origin?: "app" | "ball";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  refs?: string | null;
  source_kind?: string | null;
  created_at?: string | null;
  /**
   * R4：本轮提问携带的图片，元素是**完整 dataURL**（可直接塞 `<img src>`）。
   *
   * ⚠ 语义上必须能区分三件事，别把它们揉成一个：
   *   · `undefined` —— 前端本地刚建、还没走库的对象；
   *   · `null` —— 库里就是"没有图片"（旧消息全是这一种）；
   *   · `[]` —— 不该出现（Rust 侧刻意把空数组落成 NULL），若出现按无图处理。
   * 字段名与 SQLite 列名 `images` 逐字一致（Rust 侧 `ChatMsg.images` 接收）。
   */
  images?: string[] | null;
}

// ---------------------------------------------------------------------------
// M3：笔记与批注（契约 `07-M3契约.md` §2.2 / §三）
// 字段名与 SQLite 列名**逐字一致**（`content_md` / `exported` / `block_index` / `start_off` …），
// 因为 Rust 侧返回的就是表列名 —— 前端不能自作主张改成 camelCase。
// ---------------------------------------------------------------------------

/** `notes` 表一行（含 Markdown 全文；列表接口只给 `content_len`，这里为了预览方便两者都给） */
export interface NoteItem {
  id: number;
  course_id: number;
  session_id?: number | null;
  title: string;
  content_md: string;
  /** `YYYY-MM-DD`（本地日期） */
  date?: string | null;
  /** 最近一次导出的文件路径；null = 未导出 */
  exported?: string | null;
  /** ai_session（AI 整理 · 待核对）| user（自己写的） */
  source: string;
  created_at: string;
}

/**
 * `annotations` 表一行。锚点三件套：`block_index` + `start_off`/`end_off`（**块内纯文本偏移**）
 * + `quote`（校验与自愈用）。旧数据的 `block_index` 可能是 null → 前端归入「已失效的批注」。
 */
export interface AnnotationItem {
  id: number;
  target_kind: string;
  target_id: number;
  block_index?: number | null;
  quote?: string | null;
  start_off?: number | null;
  end_off?: number | null;
  color?: string | null;
  comment?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// M4：知识点 / 题库 / 作答（契约 `10-M4契约.md` §二）
// 字段名与 SQLite 列名**逐字一致**（`kp_id` / `qtype` / `prior_id` / `question_count` /
// `last_correct` / `duration_ms` / `self_eval`），因为 Rust 侧返回的就是表列名；
// 命令**参数**才是 camelCase（见 `lib/tauri.ts` 注释）。
// ---------------------------------------------------------------------------

/** `knowledge_points` 表一行（`knowledge_points_list` 的返回形状） */
export interface KnowledgePointItem {
  id: number;
  course_id: number;
  /** 关联先验知识树的条目 id；`knowledge_points_sync_from_prior` 用它做幂等判重 */
  prior_id?: number | null;
  name: string;
  parent_id?: number | null;
  /** 本机统计：该知识点下已有多少道题 */
  question_count?: number | null;
  /** 本机统计：该知识点下累计作答次数 / 答对次数（样本少时不要当成结论） */
  attempts?: number | null;
  correct?: number | null;
  created_at?: string | null;
}

/**
 * `questions` 表一行。
 * `options` 在库里是 **JSON 字符串**（选择题：`["A项","B项",...]`；其它题型为 null），
 * 所以这里也是字符串 —— 用 `lib/questions.ts` 的 `parseOptions` / `serializeOptions` 转换。
 */
export interface QuestionItem {
  id: number;
  course_id: number;
  kp_id?: number | null;
  /** 列表接口若带上知识点名就直接用，省一次查询 */
  kp_name?: string | null;
  /** choice | blank | short | essay */
  qtype: string;
  stem: string;
  /** 选择题的选项（JSON 字符串）；其它题型为 null */
  options?: string | null;
  answer: string;
  explain?: string | null;
  /** 1–5 */
  difficulty?: number | null;
  /** 人工校正标记：1 = 用户标记过「题目有问题」（落库是 0/1，前端也容忍 true/false） */
  flawed?: number | boolean | null;
  /** ai | user | <材料名> */
  source: string;
  source_ref?: string | null;
  created_at?: string | null;
  /** 本机统计：该题被作答的次数 / 最近一次是否答对（null = 还没答过） */
  attempts?: number | null;
  last_correct?: number | boolean | null;
}

/** `attempts` 表一行（错题本的数据源；`attempts_list` 会带上题目原文与本次作答） */
export interface AttemptItem {
  id: number;
  question_id: number;
  course_id?: number | null;
  kp_id?: number | null;
  kp_name?: string | null;
  /** 题目原文（列表接口一并返回，错题本不必再逐题去查） */
  stem?: string | null;
  qtype?: string | null;
  options?: string | null;
  answer?: string | null;
  explain?: string | null;
  user_answer?: string | null;
  /** null = 主观题还没判分（由用户自评） */
  correct?: number | boolean | null;
  /** 主观题自评：1 = 答上来了，0 = 没答上来 */
  self_eval?: number | boolean | null;
  /** 从出题到提交的毫秒数 */
  duration_ms?: number | null;
  /** 作答时的把握程度 1–5，可空 */
  confidence?: number | null;
  created_at: string;
}

export interface SampleDB {
  courses: Course[];
  prior: PriorItem[];
  materials: MaterialItem[];
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
  /** M3：笔记预览数据 */
  notes: NoteItem[];
  /** M3：批注预览数据 */
  annotations: AnnotationItem[];
  /** M4：知识点预览数据 */
  knowledge_points: KnowledgePointItem[];
  /** M4：题库预览数据 */
  questions: QuestionItem[];
  /** M4：作答记录预览数据（错题本用） */
  attempts: AttemptItem[];
  nextId: number;
}

const LS_KEY = "chunxiao:sample-db";

function iso(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 初始示例数据（每门课都标注为示例，避免被当成真实课程） */
function seed(): SampleDB {
  return {
    nextId: 100,
    courses: [
      {
        id: 1,
        name: "数据结构与算法",
        term: "2026-秋",
        teacher: "王老师",
        intro: "示例数据：数组、链表、树、图与常见排序查找算法的复杂度分析。",
        cover: null,
        archived: 0,
        created_at: iso(12),
      },
      {
        id: 2,
        name: "线性代数",
        term: "2026-秋",
        teacher: "李老师",
        intro: "示例数据：向量空间、矩阵运算、特征值与特征向量。",
        cover: null,
        archived: 0,
        created_at: iso(9),
      },
      {
        id: 3,
        name: "大学物理（上学期）",
        term: "2025-春",
        teacher: "张老师",
        intro: "示例数据：已归档课程，力学与热学部分。",
        cover: null,
        archived: 1,
        created_at: iso(210),
      },
    ],
    prior: [
      {
        id: 11,
        course_id: 1,
        parent_id: null,
        topic: "时间复杂度与渐进记号",
        summary: "用 O / Ω / Θ 描述输入规模增长时运行时间的量级。",
        detail:
          "渐进分析忽略常数与低阶项，只保留增长最快的部分。\n注意区分上界 O、下界 Ω 与紧确界 Θ：说「快排平均 O(n log n)」用的是上界口径。",
        source: "textbook",
        source_ref: "《算法导论》第 3 章",
        confidence: 0.95,
        verified: 1,
        created_at: iso(11),
      },
      {
        id: 12,
        course_id: 1,
        parent_id: 11,
        topic: "均摊分析（amortized analysis）",
        summary: "动态数组扩容的单次最坏是 O(n)，但均摊到每次插入是 O(1)。",
        detail: "常用三种方法：聚合法、记账法、势能法。",
        source: "ai",
        source_ref: null,
        confidence: 0.55,
        verified: 0,
        created_at: iso(10),
      },
      {
        id: 13,
        course_id: 1,
        parent_id: null,
        topic: "二叉搜索树的中序遍历有序性",
        summary: "BST 的中序遍历结果一定单调不减。",
        detail: null,
        source: "user",
        source_ref: "课堂笔记",
        confidence: 1,
        verified: 1,
        created_at: iso(8),
      },
      {
        id: 14,
        course_id: 1,
        parent_id: null,
        topic: "红黑树的五条性质",
        summary: "由讲义整理：节点颜色、根为黑、红节点子节点必黑、黑高一致。",
        detail: null,
        source: "数据结构讲义-第4章.pdf",
        source_ref: "p.42",
        confidence: 0.9,
        verified: 1,
        created_at: iso(7),
      },
      {
        id: 15,
        course_id: 2,
        parent_id: null,
        topic: "矩阵可对角化的充要条件",
        summary: "n 阶矩阵有 n 个线性无关的特征向量。",
        detail: "AI 生成，尚未与教材核对，请以课堂内容为准。",
        source: "ai",
        source_ref: null,
        confidence: 0.5,
        verified: 0,
        created_at: iso(6),
      },
    ],
    materials: [
      {
        id: 21,
        course_id: 1,
        file_name: "数据结构讲义-第4章.pdf",
        file_path: "D:\\课程\\数据结构\\数据结构讲义-第4章.pdf",
        kind: "pdf",
        size_bytes: 2841344,
        extracted_by: "local",
        text_len: 18320,
        chunk_count: 24,
        truncated: 0,
        note: null,
        created_at: iso(7),
      },
      {
        id: 22,
        course_id: 1,
        file_name: "期中复习提纲.docx",
        file_path: "D:\\课程\\数据结构\\期中复习提纲.docx",
        kind: "docx",
        size_bytes: 51200,
        extracted_by: "local",
        text_len: 4210,
        chunk_count: 6,
        truncated: 0,
        note: null,
        created_at: iso(3),
      },
      {
        id: 23,
        course_id: 2,
        file_name: "线代课堂板书照片.jpg",
        file_path: "D:\\课程\\线代\\板书.jpg",
        kind: "image",
        size_bytes: 1048576,
        extracted_by: "model",
        text_len: 900,
        chunk_count: 2,
        truncated: 1,
        note: "模型解析，非原文：内容由视觉模型转录，可能有误，请对照原图核对。",
        created_at: iso(2),
      },
    ],
    sessions: [
      {
        id: 31,
        course_id: 1,
        title: "均摊分析到底在算什么",
        summary: null,
        created_at: iso(5),
        updated_at: iso(5),
      },
      {
        id: 32,
        course_id: null,
        title: "（示例）第一次对话",
        summary: null,
        created_at: iso(1),
        updated_at: iso(1),
      },
      {
        // R5 示例：**悬浮球**产生的会话（`origin: "ball"`）。
        // 主窗口默认不列它（分开显示），打开「含悬浮球记录」后才出现并带「球」徽标。
        id: 33,
        course_id: 1,
        title: "悬浮球问答",
        summary: null,
        created_at: iso(3),
        updated_at: iso(3),
        origin: "ball",
      },
    ],
    messages: {
      "31": [
        { role: "user", content: "动态数组扩容为什么说插入是 O(1)？", created_at: iso(5) },
        {
          role: "assistant",
          // R7：这条示例回答**故意写成 Markdown**（标题 + 列表 + 粗体）。
          //   对话页的气泡现在走 `lib/markdown.tsx` 渲染（旧债 T28），
          //   `scripts/smoke-ui.mjs` 就在这一页断言「渲染出了真标题与真列表、
          //   且气泡里不再原样出现 `#` 与 `**`」—— 示例数据是那条断言的数据源。
          content:
            "## 一句话结论\n\n" +
            "因为把扩容那一次 O(n) 的成本**摊到**了 n 次插入上，均摊结果仍是常数。\n\n" +
            "- 单次插入最坏是 O(n)，但那是被 n 次插入一起分摊掉的\n" +
            "- 均摊分析看的是**一整个序列**的总代价，不是某一次\n\n" +
            "不妨先自己想一想：如果每次插入都扩容会发生什么？（这是追问，先别急着看结论）",
          created_at: iso(5),
        },
      ],
      "32": [
        {
          role: "assistant",
          content:
            "这是浏览器预览模式下的示例会话。配置好模型 Key 之后，就可以在「问答」页真正开始对话了。",
          created_at: iso(1),
        },
      ],
    } as Record<string, ChatMessage[]>,
    // M3：笔记预览数据 —— 3 条（AI 整理 / 自己写的 / 另一门课的 AI 整理）
    notes: [
      {
        id: 71,
        course_id: 1,
        session_id: 31,
        title: "均摊分析与红黑树",
        date: iso(4).slice(0, 10),
        exported: null,
        source: "ai_session",
        created_at: iso(4),
        content_md: [
          "# 均摊分析与红黑树",
          "",
          "## 一、均摊分析",
          "",
          "动态数组扩容那一次的开销是 O(n)，但把这次成本摊到之前的 n 次插入上，均摊到每次插入仍是 O(1)。",
          "",
          "常用三种分析方法：",
          "",
          "- 聚合法：把总成本除以操作次数",
          "- 记账法：给便宜操作预存「信用」",
          "- 势能法：用势能函数描述数据结构的状态",
          "",
          "> 注意：均摊 O(1) 说的是「一串操作的平均」，不是「每一次插入都不会慢」。",
          "",
          "## 二、红黑树",
          "",
          "红黑树用五条性质把树高控制在 O(log n)：",
          "",
          "| 性质 | 说明 |",
          "| --- | --- |",
          "| 节点颜色 | 非红即黑 |",
          "| 根节点 | 必为黑色 |",
          "| 红节点 | 子节点必为黑 |",
          "| 黑高 | 任一节点到叶子的路径黑节点数相同 |",
          "| 叶子 | NIL 视为黑 |",
          "",
          "## 待确认",
          "",
          "- 势能法里势函数的具体选取课上没展开，**待确认**。",
          "- 删除操作后的着色修正步骤，记录里只有一句话，**待确认**。",
        ].join("\n"),
      },
      {
        id: 72,
        course_id: 1,
        session_id: null,
        title: "二叉树与遍历复习",
        date: iso(7).slice(0, 10),
        exported: "D:\\课程\\数据结构\\二叉树与遍历复习.docx",
        source: "user",
        created_at: iso(7),
        content_md: [
          "# 二叉树与遍历复习",
          "",
          "## 一、三种深度优先遍历",
          "",
          "- 先序：根 → 左 → 右（用来复制整棵树）",
          "- 中序：左 → 根 → 右（BST 上得到有序序列）",
          "- 后序：左 → 右 → 根（用来释放内存）",
          "",
          "## 二、易错点",
          "",
          "中序遍历有序只是 BST 的性质，普通的二叉树没有这个结论。",
        ].join("\n"),
      },
      {
        id: 73,
        course_id: 2,
        session_id: null,
        title: "矩阵可对角化：条件与直觉",
        date: iso(2).slice(0, 10),
        exported: null,
        source: "ai_session",
        created_at: iso(2),
        content_md: [
          "# 矩阵可对角化：条件与直觉",
          "",
          "## 一、结论",
          "",
          "n 阶矩阵可对角化，当且仅当它有 n 个线性无关的特征向量。",
          "",
          "## 二、判断顺序",
          "",
          "1. 先解特征方程 det(A − λI) = 0，得到全部特征值；",
          "2. 再看每个特征值的几何重数是否等于代数重数；",
          "3. 两者全部相等，矩阵才能对角化。",
          "",
          "## 待确认",
          "",
          "- 特征值有重根时几何重数的算法，课上只讲了一道例题，**待确认**。",
        ].join("\n"),
      },
    ],
    // M3：批注预览数据（挂在笔记 71 上，用来验证契约 §三 的三条分支）
    annotations: [
      // ① 锚点完全正确（块序号 + 偏移 + quote 三者一致）→ 原位渲染，不标「已自动修正」
      {
        id: 41,
        target_kind: "note",
        target_id: 71,
        block_index: 2,
        quote: "均摊到每次插入仍是 O(1)",
        start_off: 38,
        end_off: 52,
        color: "yellow",
        comment: "示例批注：这句是均摊分析的关键——均摊 O(1) 说的是「一串操作的平均」。",
        created_at: iso(4),
      },
      // ② **故意做错**：quote 实际在第 4 块（列表项），这里却写第 7 块、偏移也不匹配
      //    → 用于验证「位置已自动修正」分支
      {
        id: 42,
        target_kind: "note",
        target_id: 71,
        block_index: 7,
        quote: "聚合法：把总成本除以操作次数",
        start_off: 0,
        end_off: 4,
        color: "green",
        comment: "示例批注：这条的块序号与偏移是过期的（模拟笔记被重新整理过），应被自动修正。",
        created_at: iso(4),
      },
      // ③ quote 在全文里都找不到 → 用于验证「已失效的批注」分支（不能假装它还在原位）
      {
        id: 43,
        target_kind: "note",
        target_id: 71,
        block_index: 10,
        quote: "势能函数一定要写成二次型",
        start_off: 0,
        end_off: 4,
        color: "pink",
        comment: "示例批注：这条批注的原文已经不在正文里了，应归入「已失效的批注」。",
        created_at: iso(4),
      },
    ],
    // M4：知识点预览数据 —— 2 个（都挂在课程 1 的先验知识上，用来验证「从先验知识同步知识点」）
    knowledge_points: [
      {
        id: 81,
        course_id: 1,
        prior_id: 11,
        name: "时间复杂度与渐进记号",
        parent_id: null,
        question_count: 2,
        attempts: 2,
        correct: 1,
        created_at: iso(10),
      },
      {
        id: 82,
        course_id: 1,
        prior_id: 13,
        name: "二叉搜索树的中序遍历有序性",
        parent_id: null,
        question_count: 2,
        attempts: 1,
        correct: 1,
        created_at: iso(10),
      },
    ],
    // M4：题库预览数据 —— 4 道题（choice / blank / short / choice，最后一道演示「标记题目有问题」）
    questions: [
      {
        id: 91,
        course_id: 1,
        kp_id: 81,
        kp_name: "时间复杂度与渐进记号",
        qtype: "choice",
        stem: "关于渐进记号 O、Ω、Θ，下列说法正确的是？",
        options: JSON.stringify([
          "O 是渐近上界，Θ 是紧确界",
          "O 是渐近下界，Θ 是渐近上界",
          "O、Ω、Θ 三者含义完全相同",
          "Θ 只用来描述最好情况",
        ]),
        answer: "O 是渐近上界，Θ 是紧确界",
        explain:
          "O 给上界（最多多快），Ω 给下界（至少多快），Θ 同时给出上界与下界（紧确界）。\n「快排平均 O(n log n)」用的是上界口径，说 Θ 时需要上下界一致。",
        difficulty: 2,
        flawed: 0,
        source: "ai",
        source_ref: "AI 生成 · 待核对",
        created_at: iso(9),
        attempts: 1,
        last_correct: 0,
      },
      {
        id: 92,
        course_id: 1,
        kp_id: 81,
        kp_name: "时间复杂度与渐进记号",
        qtype: "blank",
        stem: "动态数组扩容那一次的开销是 O(n)，把它摊到之前的 n 次插入上，均摊到每次插入是 O(____)。",
        options: null,
        answer: "1",
        explain: "常用三种分析方法：聚合法、记账法、势能法；结论都是均摊 O(1)，注意说的是「一串操作的平均」。",
        difficulty: 3,
        flawed: 0,
        source: "ai",
        source_ref: "AI 生成 · 待核对",
        created_at: iso(9),
        attempts: 1,
        last_correct: 1,
      },
      {
        id: 93,
        course_id: 1,
        kp_id: 82,
        kp_name: "二叉搜索树的中序遍历有序性",
        qtype: "short",
        stem: "为什么二叉搜索树的中序遍历结果一定是单调不减的？",
        options: null,
        answer:
          "中序遍历的顺序是「左 → 根 → 右」，而 BST 要求左子树所有关键字都小于根、右子树都大于根，所以访问序列天然按关键字递增排列。",
        explain: "这是 BST 的性质，普通二叉树没有这个结论 —— 换个遍历顺序（先序 / 后序）也不再有这个结论。",
        difficulty: 3,
        flawed: 0,
        source: "user",
        source_ref: null,
        created_at: iso(8),
        attempts: 0,
        last_correct: null,
      },
      {
        id: 94,
        course_id: 1,
        kp_id: 82,
        kp_name: "二叉搜索树的中序遍历有序性",
        qtype: "choice",
        stem: "（示例：这是一道被人工标记为「有问题」的题，用来验证筛选与徽标）下列关于红黑树性质的说法，哪一条是正确的？",
        options: JSON.stringify([
          "根节点必须是黑色",
          "红节点的子节点可以是红色",
          "任一节点到叶子的路径上黑节点数可以不同",
          "叶子节点（NIL）视为红色",
        ]),
        answer: "根节点必须是黑色",
        explain:
          "五条性质里：节点非红即黑、根为黑、红节点的子节点必为黑、任一节点到叶子的所有路径黑节点数相同、叶子（NIL）视为黑。\n（本题在预览数据里被标记为「题目有问题」，仅用于演示 flawed 筛选。）",
        difficulty: 4,
        flawed: 1,
        source: "ai",
        source_ref: "AI 生成 · 待核对",
        created_at: iso(8),
        attempts: 0,
        last_correct: null,
      },
    ],
    // M4：作答记录预览数据 —— 3 条（其中 1 条答错，用于验证错题本）
    attempts: [
      {
        id: 95,
        question_id: 91,
        course_id: 1,
        kp_id: 81,
        user_answer: "O 是渐近下界，Θ 是渐近上界",
        correct: 0,
        self_eval: null,
        duration_ms: 42000,
        confidence: 4,
        created_at: iso(3),
      },
      {
        id: 96,
        question_id: 92,
        course_id: 1,
        kp_id: 81,
        user_answer: "O(1)",
        correct: 1,
        self_eval: null,
        duration_ms: 26000,
        confidence: 3,
        created_at: iso(3),
      },
      {
        id: 97,
        question_id: 94,
        course_id: 1,
        kp_id: 82,
        user_answer: "根节点必须是黑色",
        correct: 1,
        self_eval: null,
        duration_ms: 33000,
        confidence: 2,
        created_at: iso(2),
      },
    ],
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 读取浏览器预览数据（首次调用写入示例数据） */
export function loadSampleDb(): SampleDB {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SampleDB;
      if (parsed && Array.isArray(parsed.courses)) {
        parsed.messages = parsed.messages ?? {};
        parsed.nextId = parsed.nextId ?? 1000;
        // M3：早先版本存在 localStorage 里的预览数据没有这两个键。
        // 若直接当成 []，笔记页在预览模式下会看起来"坏了"（空列表、无批注可验证），
        // 所以这里补上示例数据并回写一次；已经有数据的用户不受影响。
        if (!Array.isArray(parsed.notes) || !Array.isArray(parsed.annotations)) {
          const fresh = clone(seed()) as SampleDB;
          if (!Array.isArray(parsed.notes)) parsed.notes = fresh.notes;
          if (!Array.isArray(parsed.annotations)) parsed.annotations = fresh.annotations;
          saveSampleDb(parsed);
        }
        // M4：同理，早先版本没有这三个键。直接当成 [] 会让题库页在预览模式下看起来"空的"，
        // 所以补上示例数据并回写一次；已经有数据的用户不受影响。
        if (
          !Array.isArray(parsed.knowledge_points) ||
          !Array.isArray(parsed.questions) ||
          !Array.isArray(parsed.attempts)
        ) {
          const fresh = clone(seed()) as SampleDB;
          if (!Array.isArray(parsed.knowledge_points)) parsed.knowledge_points = fresh.knowledge_points;
          if (!Array.isArray(parsed.questions)) parsed.questions = fresh.questions;
          if (!Array.isArray(parsed.attempts)) parsed.attempts = fresh.attempts;
          saveSampleDb(parsed);
        }
        return parsed;
      }
    }
  } catch {
    /* 数据损坏则重新播种 */
  }
  const fresh = clone(seed()) as SampleDB;
  saveSampleDb(fresh);
  return fresh;
}

export function saveSampleDb(db: SampleDB): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(db));
  } catch {
    /* localStorage 不可用时保持内存态 */
  }
}

/** 恢复出厂示例数据（设置页「重置预览数据」用） */
export function resetSampleDb(): SampleDB {
  const fresh = clone(seed()) as SampleDB;
  saveSampleDb(fresh);
  return fresh;
}

/** 取下一个可用 id（示例库是内存自增，Rust 侧由 SQLite 负责） */
export function allocId(db: SampleDB): number {
  db.nextId = (db.nextId ?? 1000) + 1;
  return db.nextId;
}

// ---------------------------------------------------------------------------
// M1：浏览器预览的降级实现（`!isTauri()` 时用，保证 UI 能脱离 Rust 调试）
// 契约 `03-M1材料导入与检索契约.md` §6.5 / §4.3
// ---------------------------------------------------------------------------

/** `extract_material_b64` / `extract_material` 的返回形状（与 Rust 逐字一致） */
export interface ExtractResult {
  /** docx | pptx | xlsx | txt | md | csv | pdf | image | unknown */
  kind: string;
  text: string;
  /** 段落 / 幻灯片 / 工作表行等块数 */
  blocks: number;
  truncated: boolean;
  /** 给用户的提示（pdf / 图片会带"需视觉模型"的说明） */
  note?: string | null;
}

const KIND_BY_EXT: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  xls: "xlsx",
  txt: "txt",
  md: "md",
  markdown: "md",
  csv: "csv",
  log: "log",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
};

/** 按扩展名猜 kind（口径与 Rust `office.rs` 的分派保持一致） */
export function guessKind(fileName: string): string {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  return KIND_BY_EXT[ext] ?? "unknown";
}

/** 预览模式下可直接解码的纯文本类格式 */
const TEXT_KINDS = new Set(["txt", "md", "csv", "log"]);

/** 预览模式的示例解析结果（**不是真实解析**，仅用于脱离 Rust 调 UI） */
const SAMPLE_EXTRACTS: Record<string, { text: string; blocks: number }> = {
  docx: {
    blocks: 4,
    text: [
      "# 期中复习提纲（示例解析结果）",
      "",
      "## 一、复杂度与均摊分析",
      "动态数组的扩容是 O(n)，但把扩容成本摊到每次插入上是 O(1)。",
      "常用三种方法：聚合法、记账法、势能法。",
      "",
      "## 二、树结构",
      "二叉搜索树的中序遍历结果单调不减。",
      "红黑树靠五条性质把树高控制在 O(log n)。",
    ].join("\n"),
  },
  pptx: {
    blocks: 3,
    text: [
      "第 1 页：课程回顾",
      "第 2 页：矩阵的秩与线性方程组解的结构",
      "第 3 页：特征值与特征向量的几何意义（示例解析结果）",
    ].join("\n"),
  },
  xlsx: {
    blocks: 5,
    text: [
      "排名\t姓名\t平时分\t期末分",
      "1\t示例同学甲\t92\t88",
      "2\t示例同学乙\t85\t91",
      "（以上为浏览器预览模式的示例表格内容）",
    ].join("\n"),
  },
};

/** base64（含或不含 `data:...;base64,` 前缀）→ UTF-8 文本；解不开就返回 null */
function decodeB64Text(dataB64: string): string | null {
  try {
    const pure = dataB64.includes(",") ? dataB64.slice(dataB64.indexOf(",") + 1) : dataB64;
    const bin = atob(pure);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 浏览器预览版的 `extract_material_b64`。
 * - txt / md / csv：前端直接按 UTF-8 解码（真实内容，不是编的）；
 * - docx / pptx / xlsx：返回示例解析文本，并在 `note` 里写明这是预览示例；
 * - pdf / 图片：返回空文本 + 与桌面版一致的"需视觉模型"说明（诚实边界）。
 */
export function sampleExtractMaterialB64(fileName: string, dataB64: string): ExtractResult {
  const kind = guessKind(fileName);
  if (TEXT_KINDS.has(kind)) {
    const text = decodeB64Text(dataB64) ?? "";
    return {
      kind,
      text,
      blocks: text.split("\n").filter((l) => l.trim().length > 0).length,
      truncated: false,
      note:
        "浏览器预览模式：文本由前端直接解码（桌面版由 Rust 在本机提取）。",
    };
  }
  if (kind === "pdf" || kind === "image") {
    return {
      kind,
      text: "",
      blocks: 0,
      truncated: false,
      note: "本机无法离线提取 PDF / 图片的正文，需交给支持视觉（或文件输入）的模型解析",
    };
  }
  const sample = SAMPLE_EXTRACTS[kind];
  if (sample) {
    return {
      kind,
      text: sample.text,
      blocks: sample.blocks,
      truncated: false,
      note: "浏览器预览模式：这是示例解析文本（并非真实解析该文件），仅用于调试界面。",
    };
  }
  return {
    kind: "unknown",
    text: "",
    blocks: 0,
    truncated: false,
    note: `浏览器预览模式：暂不支持 .${(fileName.split(".").pop() ?? "").toLowerCase()} 的解析（桌面版支持 docx / pptx / xlsx / txt / md / csv）。`,
  };
}

/** 预览检索语料：每条 = 一个切块（course_id 用于验证课程过滤） */
const SAMPLE_CHUNKS: Array<{
  course_id: number;
  chunk_id: number;
  material_id: number;
  material: string;
  kind: string;
  seq: number;
  heading: string | null;
  snippet: string;
  keywords: string[];
}> = [
  {
    course_id: 1,
    chunk_id: 101,
    material_id: 21,
    material: "数据结构讲义-第4章.pdf",
    kind: "pdf",
    seq: 12,
    heading: "4.3 红黑树的性质",
    snippet:
      "红黑树用五条性质把树高控制在 O(log n)：节点非红即黑；根为黑；红节点的子节点必为黑；任一节点到其叶子的所有路径上黑节点数相同；叶子（NIL）视为黑。插入与删除后靠旋转与重新着色恢复这些性质。",
    keywords: ["红黑树", "平衡树", "旋转", "着色", "properties"],
  },
  {
    course_id: 1,
    chunk_id: 102,
    material_id: 22,
    material: "期中复习提纲.docx",
    kind: "docx",
    seq: 3,
    heading: "第二章 均摊分析",
    snippet:
      "动态数组扩容那一次的开销是 O(n)，但把这次成本摊到之前的 n 次插入上，均摊到每次插入仍是 O(1)。常用三种分析方法：聚合法、记账法（信用）、势能法。",
    keywords: ["均摊分析", "动态数组", "扩容", "势能法", "amortized"],
  },
  {
    course_id: 2,
    chunk_id: 201,
    material_id: 23,
    material: "线代课堂板书照片.jpg",
    kind: "image",
    seq: 0,
    heading: null,
    snippet:
      "（模型转录，非原图原文）特征值 λ 是使 Ax = λx 有非零解的数，对应的非零向量 x 称为特征向量；n 阶矩阵可对角化当且仅当它有 n 个线性无关的特征向量。",
    keywords: ["特征值", "特征向量", "对角化", "矩阵"],
  },
];

/**
 * M2 预览版分词：按空白与中英文标点切分 → 去首尾空白 / 去空 / 长度 ≥ 2 / 大小写不敏感去重 / 最多 8 个。
 * 与 Rust 侧 `db.rs::split_terms` 的口径保持一致（前端只在浏览器预览模式用）。
 */
export function splitTerms(query: string): string[] {
  const parts = (query ?? "").split(
    /[\s,，.。、;；:：!！?？'"“”‘’()（）\[\]【】{}<>《》/\\|\-—–~*+`]+/,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const w = raw.trim();
    if (w.length < 2) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 浏览器预览版的 `material_search`：在示例语料里按**多词 OR** 召回（M2 契约 §4.1）。
 * - 返回行带 `terms`（本次实际使用的词），保证预览模式也能验证命中高亮；
 * - 命中不了就返回 `[]`（**不编造**），方便调「无材料出处」那条 UI 分支。
 */
export function sampleMaterialSearch(
  courseId: number | null,
  query: string,
  limit = 8,
): MaterialHit[] {
  const q = query.trim();
  if (!q) return [];

  // 词表：正常情况下用切分出的词；查询里没有 ≥2 字的词时退回整串（与 M1 行为一致）
  const terms = splitTerms(q);
  const probes = terms.length > 0 ? terms : [q];
  const lowerQ = q.toLowerCase();

  const pool = courseId == null ? SAMPLE_CHUNKS : SAMPLE_CHUNKS.filter((c) => c.course_id === courseId);
  const hits: MaterialHit[] = [];
  let score = 1;
  for (const c of pool) {
    const hay = `${c.snippet} ${c.heading ?? ""} ${c.keywords.join(" ")}`.toLowerCase();
    // 任一关键词命中即召回（OR）；再保留 M1 的"关键词被整段查询包含"兜底，避免长句查询退化
    const matched =
      probes.some((t) => hay.includes(t.toLowerCase())) ||
      c.keywords.some((k) => lowerQ.includes(k.toLowerCase()));
    if (!matched) continue;
    hits.push({
      chunk_id: c.chunk_id,
      material_id: c.material_id,
      material: c.material,
      kind: c.kind,
      seq: c.seq,
      page: null,
      heading: c.heading,
      snippet: c.snippet,
      score: Number(score.toFixed(2)),
      terms: [...terms],
    });
    score -= 0.2;
    if (hits.length >= Math.max(1, Math.min(limit, 50))) break;
  }
  return hits;
}
