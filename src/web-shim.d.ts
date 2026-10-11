// git-graph web 前端的宿主桥 shim：替换 VS Code 的 acquireVsCodeApi。
// 通过 window.__DSH_GG_BOOT__ 注入 { apiBase, repo, initialState, globalState }。

declare namespace NodeJS { type Timeout = number; type Timer = number }

interface DshGgBoot {
  apiBase: string
  repo: string
  initialState: import('../vendor/git-graph/types').GitGraphViewInitialState
  globalState: import('../vendor/git-graph/types').GitGraphViewGlobalState
}

interface Window { __DSH_GG_BOOT__?: DshGgBoot }

declare const initialState: import('../vendor/git-graph/types').GitGraphViewInitialState
declare const globalState: import('../vendor/git-graph/types').GitGraphViewGlobalState

declare function acquireVsCodeApi(): {
  getState: () => unknown
  postMessage: (message: Record<string, unknown>) => void
  setState: (state: unknown) => void
}
