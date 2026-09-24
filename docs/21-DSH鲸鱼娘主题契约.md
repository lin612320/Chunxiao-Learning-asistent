# 春晓学习助手 · DSH 鲸鱼娘主题（R10 契约）

> **状态**：已实现并出包。
> **不改数据模型、不新增命令**（纯主题 / 视觉 + 悬浮球皮肤）。产出 **0.8.0**（主程序）+
> **悬浮球 1.0.8**，安装包 `发布包/春晓_0.8.0_x64-setup.exe`。
> 主题**不是手调出来的**：所有颜色 / 字体 / 形象几何都能在 DSH 自己的包里逐值对上（见 §一）。

---

## 〇、用户原话

> 「现在改一改 ui 吧，主题风格换成你（dsh）的鲸鱼娘主题，背景也要用你的背景，然后悬浮球同步，完成后打包」

四件事：① 主题整体换 DSH；② 背景也用 DSH 的；③ 悬浮球同步；④ 打包（这次**要出安装包**，撤销 R7 那句「先打 exe」）。

---

## 一、取色与几何**来源**（可逐值复核）

| 用途 | 来源 | 抽到的内容 |
| --- | --- | --- |
| 色板 + 语义令牌 | `@deepseek-ai/dsh-client-ui-theme/lib/client.js`（`design_platform_css_default`） | `--dsw-static-*` 原始色板（浅/深两段）、`--dsw-alias-*` 语义令牌（浅/深两套）、`--dsw-font-family` |
| 鲸鱼几何 | `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` | `FISH_LOGO_PATH`（3448 字符）+ `FISH_LOGO_VIEWBOX` = `23.16 × 17.04` |
| 交叉验证 | `@deepseek-ai/dsh-web-frontend/dist/favicon.svg` | 同一只鲸鱼的独立 SVG 版本 |
| 品牌用法 | `@deepseek-ai/dsh-client-ui-brand-official/lib/client.js` | 官方品牌位 = `FishLogo`（鲸鱼）+ `BrandWordmark` |

**关键取色**（都能在主题包里逐字对上，括号里是 DSH 的令牌名）：

| 项 | 浅色 | 深色 | DSH 令牌 |
| --- | --- | --- | --- |
| 应用底色 / 背景 | `#fff` | `#151517` | `--dsw-alias-bg-base`（= `--dsh-boot-bg`） |
| 卡片 / 抬高面 | `#fff` | `#232324` | `--dsw-alias-bg-layer-1` |
| 页面底 / 侧栏 | `#f9fafb` | `#1b1b1c` | `--dsw-specific-sidebar-fill` |
| 内嵌区 / 表头 | `#f5f6f7` | `#f9fafb` | `--dsw-static-neutral-bluish-60` |
| 主操作（实底） | `#0f1115` | `#f9fafb` | `--dsw-alias-brand-primary`（DSH 的主按钮是**单色**的） |
| 品牌蓝（强调/链接） | `#4176e6` | `#5686fe` | `--dsw-static-deepseek-500` / `-450`（= `--dsw-alias-link`） |
| 文字 主/次/三 | `#0f1115` / `#61666b` / `#81858c` | `#f9fafb` / `#cfd3d6` / `#adb2b8` | `--dsw-alias-label-primary/-secondary/-tertiary` |
| 描边 | `#0000001a` | `#ffffff1f` | `--dsw-alias-border-l2` |
| **用户气泡** | `#edf3fe` | `#2c2c2e` | `--dsw-specific-bubble` |
| 成功 / 警告 / 错误 | `#22c55e` / `#f59e0b` / `#ec1313` | `#4ed17e` / `#f59e0b` / `#f25a5a` | `--dsw-alias-state-*` |

⚠ **DSH 的主按钮不是蓝色而是单色**（浅色近黑、深色白），蓝只用于链接与强调 ——
所以春晓的 `--brand-solid`（主按钮 / 实底角标）映射到 `brand-primary`，
而 `--brand`（描边 / 圆点 / 渐变）映射到品牌蓝。这是**照 DSH 的口径**，不是"顺手把主色刷成蓝"。

---

## 二、分层：DSH 令牌层 + 春晓令牌**指向**它

```css
:root {
  --dsw-static-…: …;        /* ① DSH 原始色板：原样抄进来 */
  --dsw-alias-…: var(--dsw-static-…);   /* ② DSH 语义令牌：原样抄进来 */
  --surface: var(--dsw-alias-bg-layer-1);   /* ③ 春晓令牌 → 指向 alias */
  --text:    var(--dsw-alias-label-primary);
  …
}
:root[data-theme="dark"] {
  --dsw-static-neutral-bluish-60: #f9fafb;  /* 深色下**唯一不同**的原始色 */
  --dsw-alias-…: …;          /* 只覆盖 alias */
  /* ⚠ 中性令牌（--surface/--text/--border/--hairline）**不用重写** —— 它们指向 alias */
}
```

三条好处（也是选这个做法的理由）：
1. **组件 CSS 一行都不用改**（4000 行样式全部靠令牌）；
2. 深色主题只需覆盖 alias，**不会再出现"某页忘了给暗色值"**；
3. 以后 DSH 换主题 = 把 `--dsw-*` 那两段重新抄一遍。

---

## 三、具体改了什么

### 3.1 主程序（`src/styles.css`）

- 令牌层整体重写（见 §二）；`.content` 的**背景**从"春绿晨光径向渐变"换成 DSH 底色 `--surface-muted`
  （浅 `#f9fafb` / 深 `#1b1b1c`）—— DSH 的界面是**平色 + 层次靠描边**，再叠一层光会与卡片打架。
- 字体栈换成 `--dsw-font-family`（逐字照抄 DSH 的顺序）。
- 阴影 / 发丝线 / 焦点环：色相从"品牌绿"换成 DSH 的中性墨色 `#0f1115`，焦点环用品牌蓝 `rgba(86,134,254,.28)`。
- **用户气泡改用 `--dsw-specific-bubble`**：DSH 的用户消息是**淡色底 + 常规文字**，不是实心主色块；
  原来那版把 `--brand-solid` 直接铺上，换到 DSH 令牌后会变成"近黑大色块"，不像 DSH。
- `.brand-mark` 底盘改 **DSH 近黑** `#0f1115`（暗色下 `#232324`）：
  形象现在是蓝色系，蓝鲸落在原来的蓝底渐变上会糊成一团；近黑底盘让它与 **App 图标完全同构**。
- 残留的旧品牌绿全部换到 DSH 令牌：成功徽标、导入结果、批注高亮绿（`#3aa87e` → `#4ed17e`）、
  mascot 投影、`.home-welcome` 的绿色光晕（该页 R6 已删，顺手清掉）。

### 3.2 形象母版：鲸鱼（含图标流水线）

- `src/assets/mascot.svg` → **DSH 鲸鱼**：几何逐字取 `FISH_LOGO_PATH`，缩放到 240×240 画布
  （视觉中心 `(120,120)`、宽 180）以**对齐 `make-icons.ps1` 已有的取景假设**；
  颜色用 `deepseek-450 #5686fe`（亮底 `#fff` 与暗底 `#151517` 上都可读，所以不必走 `currentColor`）。
- 旧母版「晨光云朵」**留档**在 `src/assets/mascot-cloud.svg`（要回退，换回文件名即可）。
- `scripts/make-icons.ps1`：圆角底盘 `#45BE8C→#1E6A4E`（春绿）→ `#2C2C2E→#0F1115`（DSH 近黑）、
  顶部光晕 `#FFF0CE`（暖橙）→ `#5686FE`（品牌蓝）。于是图标 = **蓝鲸 + 近黑盘**，与主题同源。
  已重出：5 档 PNG + ICO(7 条目) + 悬浮球 `assets/icon.png/ico` + 前端 favicon。

### 3.3 悬浮球同步

| 项 | 改动 |
| --- | --- |
| 球皮肤 | 新增 **`whale`（鲸鱼娘）** 并设为**默认**：球面 = 品牌蓝渐变（`#5686fe→#4176e6`），形象 = DSH 鲸鱼（白色 SVG） |
| 鲸鱼几何 | 新增 `floating-ball/src/renderer/whale.js` —— **单一份**几何，球窗口与换肤窗共用（两个独立窗口各内联一份迟早漂移）；加载失败时**退回 🐳 emoji**，不留空白球 |
| 面板主题 | `skins.js` 的 `PANEL_THEMES` 与 `panel.js` 的 `THEMES` 都换成 DSH 浅/深令牌（两处**必须一致**，已在两边写注释说明） |
| 面板默认值 | `panel.html` 的 `:root` 旧色（`#161b22/#0d1117/#e6edf3/#58a6ff`）换成 DSH；`--accent-2` 换成品牌蓝系 |
| 换肤窗 | `skin-picker.html` 重写配色为 DSH 深色；`.whale-preview` 画真鲸鱼，不再是一张只有蓝球的卡片 |
| 配置迁移 | `config.js` 默认皮肤 `aurora → whale`；对**恰好等于旧默认 `aurora`** 的存量配置做一次性迁移（真选过 `midnight`/`ocean`/… 的一律尊重） |

---

## 四、商标 / 归属（如实登记，别含糊）

- DSH 的鲸鱼标识是 **DeepSeek 的官方商标**。本次按用户要求把它用作春晓的形象（**个人本机使用**）。
- `docs/00` §4.3 原来那条素材红线针对的是**第三方**项目 `maid-whale-webui` 的美术
  （其 `NOTICE` 声明不为所绘角色授权），与本次来源不同 —— 本次取自 DSH **自己的品牌包**。
- ⚠ **若要对外分发**（演示站 / 参赛 / 公开下载），需要重新评估商标与素材授权；
  另外 exe 与安装包**仍无代码签名**（SmartScreen 会提示"未知发布者"）。

---

## 五、验收（实测）

| 项 | 结果 |
| --- | --- |
| 质量闸门 | **9/9**（第 1–7、9 步真跑；第 8 步在闸门里一度 SKIP，**随后单独真跑 18/18**） |
| 桌面真机 UI 冒烟 | **18/18**（真 WebView2 + 真 Tauri IPC + 真 SQLite；为此**先重编调试版 exe**，否则跑的是旧前端资源） |
| 浏览器层 UI 冒烟 | **108/108**（换主题不动文案，108 条断言全部仍绿） |
| 悬浮球面板版面守门 | **42/42**（面板配色全换，版面没动） |
| 图标资产回读 | 通过（ICO 7 条目 + 5 档 PNG + 悬浮球 png/ico + favicon） |
| tsc / vite build / cargo check | exit 0、0 warning |
| 悬浮球重打 | **1.0.8**（`after-pack` 打印「已写入品牌图标与版本信息 → 1.0.8」） |
| 安装包 | `春晓_0.8.0_x64-setup.exe`（82.24 MB，SHA256 `073A896B…`，构建 exit 0） |
| release exe | `ProductVersion=0.8.0`；包内 `win-unpacked-0.8.0\春晓助手.exe` = **1.0.8** |
| 便携版 | `发布包/春晓助手_1.0.8_便携版.exe`（71.08 MB） |

⚠ **本版尚未真装一次**（0.4.0 时的安装布局验证仍有效：装到 `%LOCALAPPDATA%\春晓\`）。

### 5.1 本轮踩到/避开的坑

1. **`.ps1` 必须保留 UTF-8 BOM**：改 `make-icons.ps1` 时不能走普通文本编辑器（BOM 会被吃掉，
   闸门第 6 步立刻红）。本轮用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($true))` 写回并复检了前三个字节。
2. **形象换色会撞车**：鲸鱼是蓝的，而 `.brand-mark` 原来铺的就是蓝底渐变、悬浮球默认皮肤也是蓝 ——
   两处都改成"近黑底盘"才让蓝鲸显出来（与 App 图标同构）。
3. **主题有两份**（主进程 `skins.js` / 渲染进程 `panel.js`）：渲染进程拿不到主进程代码，
   只能各留一份 —— 已在两边写注释点名"改一处就要改两处"。
4. **换形象的连带面**：`make-icons.ps1` 的取景是按"母版视觉中心 (120,120)"写死的，
   新母版必须**主动对齐这个假设**（缩放到 240×240、宽 180），否则图标里的鲸鱼会小到看不见。
