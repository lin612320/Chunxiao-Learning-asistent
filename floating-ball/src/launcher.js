// 启动器：供其他 Node.js 项目 require() 嵌入使用
// 也支持独立启动（npm start 走 main.js，不走本文件）
//
// 用法一（嵌入到其他 Node 项目）：
//   const launcher = require('./chunxiao-ball/src/launcher');
//   launcher.start({ child: true });          // 启动（若已运行则直接唤起）
//   launcher.show();                          // 显示小窗
//   launcher.hide();                          // 隐藏小窗
//   launcher.prefill('选中的文本');             // 预填文本并打开小窗
//   launcher.run('ask', { question: '均摊分析是什么？' }); // 直接跑 AI（R4：翻译已移除）
//   launcher.quit();                          // 彻底退出
//
// 用法二（非 Node 项目，通过 spawn 命令行）：
//   spawn('electron', ['/path/to/chunxiao-ball', '--child', '--cmd=show']);
//   spawn('electron', ['/path/to/chunxiao-ball', '--child', '--prefill=hello']);
//   spawn('electron', ['/path/to/chunxiao-ball', '--child', '--cmd=quit']);
//
// 底层机制：
//   依赖 Electron 单实例锁 (requestSingleInstanceLock)，
//   第二次启动的实例把命令行参数透传给已运行实例的 second-instance 事件，
//   已运行实例解析参数并执行对应动作后 quit 自己。

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');


// 解析 Electron 可执行文件路径（兼容开发态和打包态）
function resolveElectron() {
  // 1. 开发态：node_modules/electron 内置的 dist/electron.exe
  const devExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(devExe)) return devExe;
  // 2. 打包态：上层目录或 dist 目录
  const packagedExe = path.join(ROOT, '..', '春晓助手.exe');
  if (fs.existsSync(packagedExe)) return packagedExe;
  // 3. npm start 方式：用 npx 包装
  return 'electron';
}

let childProc = null;

function launchInstance(extras = []) {
  const electron = resolveElectron();
  childProc = spawn(electron, [ROOT, ...extras], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  childProc.unref();
}

module.exports = {
  /**
   * 启动悬浮球（若已运行则直接唤起）
   * @param {object} [opts]
   * @param {boolean} [opts.child] 作为子进程启动（不注册全局快捷键/钩子）
   */
  start(opts = {}) {
    const args = [];
    if (opts.child) args.push('--child');
    launchInstance(args);
  },

  /** 显示小窗 */
  show() { launchInstance(['--cmd=show']); },

  /** 隐藏小窗 */
  hide() { launchInstance(['--cmd=hide']); },

  /**
   * 预填文本并打开小窗
   * @param {string} text
   */
  prefill(text) {
    launchInstance([`--prefill=${encodeURIComponent(text || '')}`]);
  },

  /**
   * 让已运行实例直接执行 AI 任务
   * @param {'translate'|'relate'|'ask'} kind
   * @param {object} opts
   */
  run(kind, opts = {}) {
    const payload = encodeURIComponent(JSON.stringify({ kind, opts }));
    launchInstance([`--run=${payload}`]);
  },

  /** 退出整个应用 */
  quit() { launchInstance(['--cmd=quit']); }
};
