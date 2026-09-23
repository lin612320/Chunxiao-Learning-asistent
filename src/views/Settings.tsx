import { useEffect, useRef, useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { matchPreset, PLATFORMS, type TestResult } from "../lib/ai";
import { isTauri } from "../lib/tauri";
import { resetSampleDb } from "../data/sample";
import Icon from "../components/Icon";
import TechNote from "../components/TechNote";

/**
 * 数据与设置页（R3 重做文案与信息层次）。
 *
 * 本页原先把实现口径直接铺在主界面上（"BYOK"、"本地数据库"、
 * `%APPDATA%\com.chunxiao.study\`、公式与"不是强化学习"……）。
 * 现在按产品口径拆开：
 *   · **主界面**：只说用户要做的动作与后果（填什么、点了会怎样、不填会怎样）；
 *   · **「说明」折叠区**：接口地址怎么填、Key 存在哪、备份里有什么、统计是怎么算的。
 * 顺带修掉一处过期文案：页面底部原先还写着「版本 0.1.0（M0 骨架）…
 * 笔记 / 题库 / 画像 / 番茄钟为 M1+ 规划」——那是 0.5.0 之前的老黄历。
 */
export default function Settings() {
  const { s, hasKey, setAI, saveAI, setTheme, testAI, backupNow, restore, msg, setMsg } = useSettings();

  const [presetKey, setPresetKey] = useState("deepseek");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [backupDir, setBackupDir] = useState("");
  const [restoreFile, setRestoreFile] = useState("");
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);

  // 载入完成后按已保存的 base_url 回显平台预设（只同步一次，避免覆盖用户的手动选择）
  const synced = useRef(false);
  useEffect(() => {
    if (s.loaded && !synced.current) {
      synced.current = true;
      setPresetKey(matchPreset(s.ai.baseUrl));
    }
  }, [s.loaded, s.ai.baseUrl]);

  function onPresetChange(key: string) {
    setPresetKey(key);
    const p = PLATFORMS.find((x) => x.key === key);
    if (p && p.key !== "custom") {
      setAI({ baseUrl: p.baseUrl, model: p.model || s.ai.model });
      setTestResult(null);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    const r = await testAI();
    setTestResult(r);
    setTesting(false);
  }

  async function handleSave() {
    await saveAI();
  }

  const preset = PLATFORMS.find((x) => x.key === presetKey);

  return (
    <div className="settings-page">
      {!s.loaded && <p className="loading-line">加载设置中…</p>}

      {/* ① 模型接入 */}
      <section className="card">
        <div className="section-head">
          <h3>模型接入</h3>
          <span className="badge">{hasKey ? "已配置" : "未配置"}</span>
        </div>
        <p className="muted hint">
          春晓不自带账号，对话用的是<b>你自己的模型账号</b>：Key 只保存在这台电脑上，
          由春晓直接访问你选的平台，不经过我们的服务器。不配置也能用，只是对话会停在演示模式。
        </p>

        <div className="form-grid">
          <label className="wide">
            <span>平台预设</span>
            <select value={presetKey} onChange={(e) => onPresetChange(e.target.value)}>
              {PLATFORMS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>接口地址</span>
            <input
              value={s.ai.baseUrl}
              onChange={(e) => {
                setAI({ baseUrl: e.target.value });
                setTestResult(null);
              }}
              placeholder="https://api.deepseek.com"
            />
          </label>

          <label>
            <span>模型名</span>
            <input
              value={s.ai.model}
              onChange={(e) => setAI({ model: e.target.value })}
              placeholder={preset?.model || "deepseek-chat"}
            />
          </label>

          <label className="wide">
            <span>API Key（仅保存在本机）</span>
            <input
              type={apiKeyVisible ? "text" : "password"}
              value={s.ai.apiKey}
              onChange={(e) => {
                setAI({ apiKey: e.target.value });
                setTestResult(null);
              }}
              placeholder="sk-…（粘贴时注意不要带空格）"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={apiKeyVisible}
            onChange={(e) => setApiKeyVisible(e.target.checked)}
          />
          <span>显示 Key 明文（旁边有人时别开）</span>
        </label>

        <div className="btn-row">
          <button className="primary" disabled={testing} onClick={() => void handleTest()}>
            <Icon name="refresh" />
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button className="ghost-btn" onClick={() => void handleSave()}>
            <Icon name="check" />
            保存配置
          </button>
        </div>

        {testResult && (
          <div className={"test-result " + (testResult.ok ? "ok" : "err")}>{testResult.text}</div>
        )}

        {!hasKey && (
          <p className="warn">当前尚未配置完整的 Key 与接口地址，对话页会停留在演示模式。</p>
        )}

        <TechNote title="接口地址怎么填？Key 存在哪里？">
          <ul>
            <li>
              接口地址填<b>平台的基础地址</b>：不要填控制台网页地址，也不要带
              <code>/chat/completions</code> 后缀。常见填错（例如粘贴了
              <code>platform.deepseek.com</code>）春晓会自动纠正为真实接口地址。
            </li>
            <li>
              「测试连接」会请求 <code>基础地址/models</code> 验证 Key 与地址是否匹配，
              <b>不会发送你的课程内容或问题</b>。
            </li>
            <li>
              Key 存在本机数据文件里，并做了混淆处理（避免以 <code>sk-…</code> 明文出现，
              但这不等同于强加密）。共用电脑上请勿长期保留 Key。
            </li>
            <li>
              本机数据目录：<code>%APPDATA%\com.chunxiao.study\</code>；数据库文件
              <code>chunxiao.db</code>（含课程、先验知识、材料索引、对话与作答记录）。
            </li>
          </ul>
        </TechNote>
      </section>

      {/* ② 外观 */}
      <section className="card">
        <div className="section-head">
          <h3>外观</h3>
        </div>
        <p className="muted hint">主题会随设置在下次启动时恢复。</p>
        <div className="chip-bar">
          <button
            className={"chip" + (s.theme === "light" ? " chip-active" : "")}
            onClick={() => void setTheme("light")}
          >
            <Icon name="sun" />
            日间
          </button>
          <button
            className={"chip" + (s.theme === "dark" ? " chip-active" : "")}
            onClick={() => void setTheme("dark")}
          >
            <Icon name="moon" />
            夜间
          </button>
        </div>
      </section>

      {/* ③ 备份与还原 */}
      <section className="card">
        <div className="section-head">
          <h3>数据备份与还原</h3>
        </div>
        <p className="muted hint">
          课程、先验知识、材料索引与对话全部存在本机。换电脑或重装前建议先备份一次。
        </p>

        <h4 className="sub-title">立即备份</h4>
        <div className="form-grid">
          <label className="wide">
            <span>备份到哪个文件夹</span>
            <input
              value={backupDir}
              onChange={(e) => setBackupDir(e.target.value)}
              placeholder="例如：D:\春晓备份"
            />
          </label>
        </div>
        <button
          className="primary"
          disabled={busy !== null || !backupDir.trim()}
          onClick={() => {
            void (async () => {
              setBusy("backup");
              await backupNow(backupDir);
              setBusy(null);
            })();
          }}
        >
          <Icon name="download" />
          {busy === "backup" ? "备份中…" : "立即备份"}
        </button>

        <h4 className="sub-title">从备份还原</h4>
        <div className="form-grid">
          <label className="wide">
            <span>备份文件完整路径</span>
            <input
              value={restoreFile}
              onChange={(e) => setRestoreFile(e.target.value)}
              placeholder="选择之前备份生成的文件"
            />
          </label>
        </div>
        <button
          className="primary danger"
          disabled={busy !== null || !restoreFile.trim()}
          onClick={() => {
            if (!window.confirm("还原会用备份覆盖这台电脑上的当前数据，操作前请先手动备份一次。继续？")) return;
            void (async () => {
              setBusy("restore");
              await restore(restoreFile);
              setBusy(null);
            })();
          }}
        >
          <Icon name="upload" />
          {busy === "restore" ? "还原中…" : "从备份还原"}
        </button>
        <p className="muted hint">还原完成后建议重启应用，确保重新载入数据。</p>

        <TechNote title="备份里到底有什么？">
          <ul>
            <li>
              备份产物是<b>一个数据库文件</b>（<code>.db</code> 快照），包含课程、先验知识、
              材料文本与切块、对话、笔记与批注、题库与作答、专注记录。
            </li>
            <li>
              <b>不含</b>你导入的原始课件文件本身（备份的是提取出的文本与索引），
              换机后如需重新引用原文件，请保留原始材料。
            </li>
            <li>还原会整体覆盖当前数据，因此是一个不可撤销的操作 —— 先备份再还原。</li>
          </ul>
        </TechNote>
      </section>

      {/* ④ 关于与边界说明 */}
      <section className="card">
        <div className="section-head">
          <h3>关于春晓</h3>
          <span className="badge">版本 {__APP_VERSION__}</span>
        </div>
        <ul className="notice-list">
          <li>
            <b>定位</b>：面向课后理解与复习 —— 答疑、整理笔记、自测练习；<b>不面向考试场景</b>，
            不提供应试速成或答案速出式的协助。
          </li>
          <li>
            <b>数据只在本机</b>：课程、材料与对话都保存在这台电脑上，不做云同步、不上传；
            只有你在对话页提问时，问题内容才会发送给你自己配置的模型接口。
          </li>
          <li>
            <b>AI 说的要自己核对</b>：标了「待核对」的内容尚未与教材核对；回答里没有出处的补充
            也会明确标注，请以教材与课堂内容为准。
          </li>
          <li>
            <b>材料版权</b>：只导入你有权使用的材料；材料不随安装包分发，也不回传云端。
          </li>
        </ul>

        <TechNote title="学习画像与「智能」到底做了什么？">
          <ul>
            <li>
              学习画像与复习优先级只是<b>本机统计</b>：例如按你最近几次作答的正确率调整复习顺序。
              这些数字只写在本机数据文件里，不上传，也不参与任何模型训练。
            </li>
            <li>
              换句话说：<b>这不是强化学习，模型权重不会因此改变</b>。
              春晓无法训练模型，能调整的只有本机统计口径与发给模型的提示词。
            </li>
            <li>
              掌握度按样本数说话：作答次数少的知识点只显示「样本不足」，不给数字、不进弱项榜 ——
              避免用一两次作答下结论。
            </li>
          </ul>
        </TechNote>

        {!isTauri() && (
          <button
            className="ghost-btn"
            onClick={() => {
              if (window.confirm("重置浏览器预览用的示例数据（只影响浏览器里的预览数据）？")) {
                resetSampleDb();
                window.location.reload();
              }
            }}
          >
            <Icon name="refresh" />
            重置浏览器预览数据
          </button>
        )}
      </section>

      {/* 提示 */}
      {msg && (
        <div className={`settings-msg ${msg.type}`} onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
