/**
 * 宿主 API 客户端：把命令发到 POST /dsh-source-control/gg/api。
 *
 * 命令集覆盖提交图查询、分支/标签/贮藏操作、仓库配置与工作区变更。
 * 所有调用都以 JSON 往返，失败以抛出携带 error 文本的 Error 表示。
 * 实现按命令域拆分在 ./api/ 下，本目录的 index.ts 是唯一入口。
 */
export * from './http.ts';
export * from './repos.ts';
export * from './working-tree.ts';
export * from './ignore.ts';
export * from './commits.ts';
export * from './branches.ts';
export * from './tags.ts';
export * from './remotes.ts';
export * from './github.ts';
export * from './ai.ts';
