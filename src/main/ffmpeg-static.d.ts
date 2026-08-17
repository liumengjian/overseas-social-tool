// ffmpeg-static 自带类型不全，这里补一个最小声明，使主进程在打包/安装前也能通过 tsc。
// 运行时由用户 npm install 拉取真正的 ffmpeg 静态二进制（见 package.json dependencies）。
declare module 'ffmpeg-static' {
  /** 静态 ffmpeg 可执行文件路径；未安装时为 null */
  const path: string | null;
  export default path;
}
