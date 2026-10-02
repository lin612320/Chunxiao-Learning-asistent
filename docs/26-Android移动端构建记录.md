# Android 移动端构建记录（R14）

> **版本** 主程序 `0.10.0` ｜ **构建日期** 2026-10-02 ｜ **目标** 手机 / 平板可安装的 Android APK
> **最终产物** `发布包/春晓_0.10.0_release_universal.apk`
> （17,242,144 B / **16.44 MB**，SHA256 `14FBAF4A4D04AD4332F5B3927AA24ED8070567B69A6C918B2CE1FDB276809BFE`）
> —— **release · 已签名 · 双 ABI（arm64-v8a + armeabi-v7a）**，见 §七。
> **本文口径** 所有"已验证"都来自本机实跑；"未验证"逐条写明。**本机 Windows 主机只能出 Android，
> iOS 必须在 macOS + Xcode 上做**（本机没有任何 Apple 工具链，未尝试）。
>
> ⚠ **本文第一版（debug APK）在真机上启动即闪退**。原因**不是**环境，是**两处真 bug**：
> ① `lib.rs` 的 `run()` 缺 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`（没有 JNI 入口）；
> ② APK 里**一个 `assets/` 都没有**（前端与 `tauri.conf.json` 都没打进去）。
> 定位过程与修复见 §七 —— **§一～§六 是"绕过环境障碍把 .so 编出来"的记录，仍然有效**。

---

## 一、产物是什么（**最终版**，第一版的 debug 形态见 §七）

| 项 | 值 |
| --- | --- |
| 形态 | **release APK · 已签名**（`apksigner verify` = Verifies，v2 方案）· **双 ABI** |
| 包名 / 应用名 | `com.chunxiao.study` / **春晓**（aapt2 实测 `application-label:'春晓'`） |
| 版本 | `versionName=0.10.0`，`versionCode=10000`（Tauri 按 `0.10.0` 生成） |
| SDK | `minSdk=24`（Android 7.0）/ `targetSdk=36` / `compileSdk=36` |
| 内含 native 库 | `lib/arm64-v8a/…so` **7.15 MB** + `lib/armeabi-v7a/…so` **5.48 MB**（各含 **24 个 JNI 入口**） |
| 前端 | `assets/` **72 个条目**（`index.html` + `assets/*` + `tauri.conf.json`），就是 0.10.0 那份 `dist/` |
| 体积 | **16.44 MB**（第一版 debug 是 125.38 MB —— 差在调试符号与未 strip） |
| 签名 | keystore `D:\cx-keystore\chunxiao-release.jks`，别名 `chunxiao`，密码在 `gen/android/app/keystore.properties`（**都不进仓库**） |

**为什么第一版是 debug**：release APK 需要签名，而 Tauri 生成的 `app/build.gradle.kts` **没有 `signingConfigs`**
（release 只配了 `minifyEnabled`），`assembleRelease` 只会产出 `*-unsigned.apk` —— 装不上。
最终版已补上签名（见 §五.2）。

---

## 二、路上的三堵墙（按撞上的顺序，都有真实报错）

### 墙 1：**工程路径含中文** → NDK 的 `ld.lld` 打不开目标文件

报错形态会**伪装**成别的问题，很容易往错方向查：

```
ld.lld: error: cannot find version script C:\Users\86180\Desktop\实战项目\...\rustcmEAD6X\list
ld.lld: error: cannot open ...chunxiao_study_lib.*.rcgu.o: unspecified system_category error
```

更早还会先看到一堆**误导性**错误（真因还是它）：
`error: only metadata stub found for rlib dependency core`、
`error: cannot find trait Copy/Clone/PartialEq in this scope`（落在 `syn`/`winnow`/`memchr` 等 crate 上）。

**误判代价（本机真实发生）**：这些像"std 装坏了 / rustflag 不一致 / proc-macro 不兼容"，
于是去查 rustup 目标、RUSTFLAGS、sccache、命令行长度……**全都不对**。
判别方法：错误路径里出现 `\xca\xb5\xd5\xbd` 这种**GBK 字节转义**，就是中文路径被按 ANSI 码页转码丢字。

**处置（本轮采用）**：把**编译产物目录**指到纯 ASCII 路径 —— `CARGO_TARGET_DIR=D:\cx-android-target`。
这样 lld 需要打开的 `.o` / version script 全在 ASCII 路径下，链接通过。
（**没有**移动工程本身；治本做法见 §五。）

### 墙 2：**C 盘满** → `os error 112 磁盘空间不足`

```
error: failed to build archive at `...\deps\libchunxiao_study_lib.a`: 磁盘空间不足。(os error 112)
```

C 盘 549.7 GB **只剩 0.2 GB**。清理可再生的构建产物后恢复到 20.8 GB：

| 处置 | 释放 |
| --- | --- |
| 删 `src-tauri/target/aarch64-linux-android`（上次失败的 android 产物） | 2.13 GB |
| 删 `C:\cx-android-target`（临时试的） | 2.99 GB |
| 删 `src-tauri/target/debug`（**`cargo build` 可完全重建**；0.10.0 安装包已交付） | 19.41 GB |

> ⚠ 被删的都是**构建产物**，不是源码或交付物：`发布包/春晓_0.10.0_x64-setup.exe` 一直在（已核验）。
> 要恢复桌面调试版：`cd src-tauri; cargo build`。

并把 Android 的产出目录放到 D 盘（`CARGO_TARGET_DIR=D:\cx-android-target`，51 GB 可用）。

### 墙 3：Tauri CLI 要建**符号链接** + AGP **拒绝非 ASCII 路径**

`.so` 编译成功后，Tauri CLI 的最后一步是把它**符号链接**进 jniLibs：

```
failed to build Android app: Failed to create a symbolic link from
  "D:\cx-android-target\aarch64-linux-android\debug\libchunxiao_study_lib.so"
  to file "...\src-tauri\gen/android\app/src/main/jniLibs/arm64-v8a\libchunxiao_study_lib.so"
  (file clobbering enabled): ... You should use developer mode.
```

Windows 上创建符号链接要么开**开发者模式**、要么有 `SeCreateSymbolicLinkPrivilege`；
本机**没开、当前进程也不是管理员**（实测 `IsInRole(Administrator) = False`）。

改为绕过（**不改任何工程文件**）：

1. 手工把 `.so` **复制**进 `gen/android/app/src/main/jniLibs/arm64-v8a/`；
2. 用 Gradle **init 脚本**（`%TEMP%\cx-no-rust.gradle`）把 `rustBuild*` 这些"会再调 Tauri CLI"的任务禁用；
3. 直接跑 `gradlew assembleArm64Debug`。

此时 AGP 还会再拦一道：

```
> Failed to apply plugin 'com.android.internal.application'.
   > Your project path contains non-ASCII characters. This will most likely cause the build to fail on Windows.
```

按官方提示在 `gen/android/gradle.properties` 加一行：

```properties
android.overridePathCheck=true
```

（**实测有效**：Gradle / Java / Kotlin 本身能正确处理 Unicode 路径 —— 真正不兼容的是 NDK 的 lld 与 `aapt2` 那一层，
而它们处理的对象路径此时已经全在 ASCII 的 target 目录里。**没有**改动 `gen/android` 之外的任何工程文件。）

---

## 三、本轮实际跑通的命令序列（可复现）

```powershell
# 1) 目标与前置（一次性）
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npx tauri android init --ci --skip-targets-install      # 生成 src-tauri/gen/android（NDK 28.2.13676358）

# 2) 出 .so：让 tauri CLI 跑 cargo（它会把 NDK 的 CC/AR/linker 都设好）
#    ⚠ 只到"编完 .so"为止；紧接着的符号链接会失败，这是预期的
$env:CARGO_TARGET_DIR = 'D:\cx-android-target'
npx tauri android build --apk --debug --target aarch64 --ci

# 3) 手工把 .so 放进 jniLibs（替代那步符号链接）
$so  = 'D:\cx-android-target\aarch64-linux-android\debug\libchunxiao_study_lib.so'
$dst = 'src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item $so (Join-Path $dst 'libchunxiao_study_lib.so') -Force

# 4) Gradle 打包（禁用 rustBuild*，跳过非 ASCII 路径检查）
cd src-tauri\gen\android
$env:JAVA_HOME = 'D:\Antroid_Studio\jbr'
.\gradlew.bat --init-script "$env:TEMP\cx-no-rust.gradle" assembleArm64Debug
# → app\build\outputs\apk\arm64\debug\app-arm64-debug.apk
```

> ⚠ **别用 PowerShell 管道去接 cargo 的输出**：本机实测 `cargo ... | Select-Object` 会在
> 处理超长单行（`libc` 那条 `--check-cfg` 有几万字符）时**自己栈溢出**（`0xC00000FD`），
> 把正在跑的 rustc 一起带走，于是留下半截 rlib、报出一堆假的"元数据桩"错误。
> 正确做法：让 `cmd /c ... > log 2>&1` 在**子进程里**重定向，PowerShell 完全不碰输出。

---

## 四、Android 上"会如实报错"的功能（**不是 bug**，是平台事实）

这些入口在平板上点了会给出可读错误，而不是静默失败或假装成功：

| 功能 | 原因 |
| --- | --- |
| 顶栏「悬浮球」 | 悬浮球是随包分发的 **Windows Electron 程序**，Android 上没有 |
| 相关材料「打开」/「在文件夹中显示」 | `open_file` / `reveal_in_folder` 只在 `#[cfg(windows)]` 下有实现，非 Windows 走"当前平台暂不支持"的如实分支 |
| 笔记「导出 Word（.docx）」 | 需要一个**本机目录**（如 `D:\课程\笔记`），Android 上没有这种路径概念；需要 SAF 目录选择器（未做） |
| 笔记「打印为 PDF」 | 依赖系统打印对话框，Android WebView 里不可用 |

**平板可正常用的**：课程 / 先验知识 / 笔记（含**手写页与标注工具**）/ 与该课对话（BYOK）/
题库 / 学习画像 / 专注计时 / 数据设置 / 备份还原（应用私有目录）。

---

## 五、治本做法与下一步

1. **治本（推荐先做，一劳永逸）**：
   - 把工程放到**纯 ASCII 路径**（例如 `D:\chunxiao-study\`）→ 墙 1 与墙 3 的 AGP 检查都不再需要绕；
   - 打开 **Windows 开发者模式**（设置 → 系统 → 开发者选项）→ 那步符号链接不再失败，
     `npm run tauri android build --apk --debug` 可以**原样跑通**（本机未验证，因为当前进程无管理员权限）。
2. **出 release APK（体积与性能都会好很多）**：现在 debug 的 `.so` 是 118.51 MB（带调试符号）；
   release 会 strip + LTO。步骤：
   `keytool -genkey` 生成 keystore → 在 `gen/android` 配 `signingConfigs` →
   `cargo build --release --target aarch64-linux-android --features tauri/custom-protocol` →
   `gradlew assembleArm64Release`。
3. **真机验证（仍未完成）**：最终版 release 包**还没再上真机**。安装：
   `adb install -r 春晓_0.10.0_release_universal.apk`，或把 APK 拷进手机点开（需允许"未知来源"）。
   **若仍闪退，请给 logcat**（`adb logcat -b crash` 或 `adb logcat | findstr chunxiao`）——
   本次是靠"从产物反推"定位的（无设备），有日志会快得多。
4. **ABI 覆盖**：最终包已含 **arm64-v8a + armeabi-v7a**（覆盖几乎所有手机/平板）；
   x86 / x86_64（模拟器）**没打**。要通吃：`--target x86_64` 再编一份、放进 `jniLibs/x86_64/` 重新打包。

---

## 六、已验证 / 未验证

**已验证**：`rustup` 四个 android 目标安装成功；`tauri android init` 生成 Gradle 工程成功；
cargo 为 `aarch64-linux-android` / `armv7-linux-androideabi` 编译成功（含 rusqlite 的 bundled SQLite C 源码）；
`gradlew assembleArm64Debug` 与 `assembleUniversalRelease` 均 **BUILD SUCCESSFUL**；
`aapt2 dump badging` 包名/版本/标签/SDK/`native-code` 全部正确；
`apksigner verify` = **Verifies**（v2 方案）；APK 含 `classes.dex` / `AndroidManifest.xml` /
`resources.arsc` / `assets/*`（72 条）/ 两个 ABI 的 `.so`。

**未验证**：第一版 APK **在真机（手机）上启动即闪退**（见 §七），修复后的 release 包
**尚未再上真机验证**；触控笔压感在 Android WebView 里的实际表现；其它 ABI（x86/x86_64）；iOS（需 macOS）。

---

## 七、真机闪退的定位与修复（**本轮最重要的一节**）

第一版 `春晓_0.10.0_arm64-debug.apk` 装到手机上**启动即闪退**。
因为没有连设备、拿不到 logcat，只能从产物里反推 —— 最后定位到**两个真 bug**（都不是环境问题）：

### bug 1：`lib.rs` 的 `run()` 缺 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`

**症状**：`.so` 里**一个 JNI 符号都没有**。
判据（可复现，不需要设备）：

```powershell
# 期望看到 Java_..._Rust_create / onActivityCreate 等；实测为 0 个
$re = "$env:ANDROID_HOME\ndk\28.2.13676358\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe"
& $re --dyn-syms <libchunxiao_study_lib.so> | Select-String 'Java_|JNI_OnLoad'
```

而 `wry` 的 `Rust.kt` 里声明了一串 `external fun`（`create` / `onActivityCreate` /
`onActivityDestroy` / `onNewIntent` …）——**Java 侧要调的入口在 Rust 侧根本不存在**。
于是：`System.loadLibrary` 成功，Activity 一调 `Rust.create()` → **`UnsatisfiedLinkError` → 闪退**。

**更隐蔽的连带后果**：release 构建下，**没有对外导出的入口符号 → LTO 把整个应用当死代码删光**，
产出一个 **0.3 MB 的空壳 `.so`**（只有 `__cxa_finalize`/`memcpy` 这类 C 运行时符号，
连 `sqlite3`/`tauri` 字符串都没有）。正常应为数 MB —— 这个体积异常正是定位的突破口。

**修复**（`src-tauri/src/lib.rs`）：

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() { … }
```

`mobile` 这个 cfg 由 `tauri-build` 在 Android/iOS 目标下自动设置，**桌面构建完全不受影响**。
修复后两个 ABI 的 `.so` 都从 0.3 MB 变成 **7.15 MB / 5.48 MB**，各含 **24 个 JNI 入口**。

> 这条是本项目"一直只有桌面端"造成的：桌面上 `main.rs` 直接调 `run()`，从来不需要 JNI 入口。

### bug 2：APK 里**没有 `assets/`**（前端与 `tauri.conf.json` 都没打进去）

**症状**：APK 内 `assets/*` 条目数 = **0**；而 `tauri-android` 的 `PluginManager.kt` 在启动时要读
`FsUtils.readAsset(context.assets, "tauri.conf.json")` —— 读不到就是启动期异常。

**为什么没打进去**：Tauri CLI 的顺序是「cargo 编出 `.so` → 符号链接进 jniLibs → **复制前端到 assets/** → 调 Gradle」。
本机在第 2 步（符号链接，需开发者模式）就 `failed to build Android app` 退出了，
**第 3 步（复制前端）根本没执行** —— 而 `app/src/main/assets/` 目录已被创建（所以看起来"目录在"）。

**修复**：手工补上 CLI 漏掉的那一步（这就是它在正常环境里会做的事）：

```powershell
$as = 'src-tauri\gen\android\app\src\main\assets'
Copy-Item 'dist\*' $as -Recurse -Force                    # 前端（index.html + assets/*）
Copy-Item 'src-tauri\tauri.conf.json' "$as\tauri.conf.json" -Force
```

### 另外两处（构建环境层，已在 §二/§三记录）

- 中文工程路径 → NDK `ld.lld` 打不开目标文件（→ `CARGO_TARGET_DIR` 指到 ASCII 路径）；
- C 盘满 `os error 112`（→ 清可再生的构建产物）；
- 符号链接需开发者模式 + AGP 拒非 ASCII 路径（→ 手工放 jniLibs + init 脚本禁用 `rustBuild*` +
  `android.overridePathCheck=true`）。

### 最终打包命令（可复现）

```powershell
# 1) 两个 ABI 的 release .so（Tauri CLI 负责设好 NDK 环境；它在符号链接那步会失败，属预期）
$env:CARGO_TARGET_DIR='D:\cx-android-target'
npx tauri android build --apk --target aarch64 --ci      # → 7.15 MB
npx tauri android build --apk --target armv7   --ci      # → 5.48 MB

# 2) 手工就位：jniLibs/<abi>/*.so  +  app/src/main/assets/*
#    （见上；这一步替代 CLI 因权限失败的两步）

# 3) 签名 + 打包 release（签名写在 app/build.gradle.kts 末尾，读 app/keystore.properties）
cd src-tauri\gen\android
$env:JAVA_HOME='D:\Antroid_Studio\jbr'
.\gradlew.bat --init-script "$env:TEMP\cx-no-rust.gradle" assembleUniversalRelease
# → app\build\outputs\apk\universal\release\app-universal-release.apk（16.44 MB）
```
