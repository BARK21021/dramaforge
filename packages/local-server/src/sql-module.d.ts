// .sql 文件由 esbuild text loader 在构建时内联为字符串（见 index.ts 的 schema 初始化）。
// 此声明让 tsc 接受 .sql 导入，匹配 esbuild 的运行时行为。
declare module '*.sql' {
  const content: string;
  export default content;
}
