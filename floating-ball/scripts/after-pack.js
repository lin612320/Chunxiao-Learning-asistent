// electron-builder afterPack 钩子：**离线**给打包后的 exe 写入品牌图标与版本信息。
//
// 为什么需要这一步：
//   · electron-builder 自带的 exe 资源编辑由 build.win.signAndEditExecutable 控制。
//     打开它需要 winCodeSign 包；本机对该下载源不可达（网络被拦），
//     母本因此把它设成 false —— 这是**本机环境的绕行**，不是配置疏忽。
//   · 关掉后，win-unpacked 里的 exe 会保留 Electron 默认图标与版本信息
//     （便携版最外层 stub 仍有品牌图标，但**运行时的任务栏图标取自内层 exe**）。
//   · 本钩子在「app 目录已打包完成、各 target（portable）尚未生成」之间运行，
//     因此这里改过的内层 exe 会被随后生成的便携版**一并收进去**。
//     直接调用本机 electron-builder 缓存里的 rcedit，全程不联网。
//
// 找不到 rcedit 时**只告警、不失败**：打包仍应成功，只是 exe 未被品牌化。
// 覆盖路径按可能性从高到低探测；也可用环境变量 RCEDIT_PATH 显式指定。

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PRODUCT = "春晓助手";
const COMPANY = "春晓学习助手";

function findRcedit() {
  if (process.env.RCEDIT_PATH && fs.existsSync(process.env.RCEDIT_PATH)) {
    return process.env.RCEDIT_PATH;
  }
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign"),
    path.join(process.env.APPDATA || "", "electron-builder", "Cache", "winCodeSign"),
  ];
  const names = ["rcedit-x64.exe", "rcedit-ia32.exe"];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    // 缓存目录可能是 winCodeSign-<版本>，也可能是哈希命名 —— 两种都扫
    for (const dir of fs.readdirSync(root)) {
      const sub = path.join(root, dir);
      let isDir = false;
      try {
        isDir = fs.statSync(sub).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      for (const n of names) {
        const p = path.join(sub, n);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const productFilename = packager.appInfo.productFilename || PRODUCT;
  const exe = path.join(appOutDir, `${productFilename}.exe`);
  const icon = path.join(__dirname, "..", "assets", "icon.ico");
  const version = packager.appInfo.version || "0.0.0";

  if (!fs.existsSync(exe)) {
    console.warn(`[after-pack] 未找到打包后的 exe，跳过品牌化：${exe}`);
    return;
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn(
      "[after-pack] 未找到 rcedit（electron-builder 的 winCodeSign 缓存里没有），" +
        "跳过图标/版本写入 —— exe 将保留 Electron 默认外观。可设 RCEDIT_PATH 显式指定。",
    );
    return;
  }
  if (!fs.existsSync(icon)) {
    console.warn(`[after-pack] 未找到 ${icon}，跳过品牌化（先跑 scripts/make-icons.ps1）`);
    return;
  }

  const args = [
    exe,
    "--set-icon",
    icon,
    "--set-version-string",
    "ProductName",
    PRODUCT,
    "--set-version-string",
    "FileDescription",
    PRODUCT,
    "--set-version-string",
    "CompanyName",
    COMPANY,
    "--set-version-string",
    "LegalCopyright",
    COMPANY,
    "--set-file-version",
    version,
    "--set-product-version",
    version,
  ];
  try {
    execFileSync(rcedit, args, { stdio: "inherit" });
    console.log(`[after-pack] 已写入品牌图标与版本信息：${path.basename(exe)} → ${version}`);
  } catch (e) {
    // 品牌化失败不应让打包整体失败（exe 仍可用，只是外观是默认的）
    console.warn(`[after-pack] rcedit 执行失败（打包继续）：${e && e.message ? e.message : e}`);
  }
};
