// 静态资源的模块声明。
//
// ⚠ 这里**故意不用** `/// <reference types="vite/client" />`：
//   那个声明会把 `import.meta.hot` 变成"有类型"，从而让 `src/lib/ball.ts` 里
//   两处为它准备的 `// @ts-expect-error` 变成**多余的指令**（TS2578 报错）。
//   我们只需要给 SVG 一个模块声明，就不该顺带改动 `import.meta` 的既有类型环境。
declare module "*.svg" {
  const src: string;
  export default src;
}

/**
 * 由 `vite.config.ts` 的 `define` 注入：值来自 **package.json 的 version**。
 * 界面上凡是需要显示版本号的地方都读它，避免手写字符串后慢慢与真实版本漂移。
 * （构建期被替换成字面量，运行时不存在这个全局变量。）
 */
declare const __APP_VERSION__: string;
