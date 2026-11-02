/**
 * 面板的三个分区：存储库、更改（含提交框）、图形。
 *
 * 每个分区只接收已算好的数据与回调，状态与数据加载由面板主体持有。
 * 实现按分区拆在同目录的 sections/ 下，本文件只做再导出。
 */
export { RepoSection } from './sections/repo.ts';
export type { RepoSectionProps } from './sections/repo.ts';
export { ChangesSection } from './sections/changes.ts';
export type { ChangesSectionProps, CommitBoxProps, ChangeListsProps } from './sections/changes.ts';
export { GraphSection } from './sections/graph.ts';
export type { GraphSectionProps } from './sections/graph.ts';