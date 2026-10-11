/**
 * 视图样式：只使用 --dsw-* 语义 token，随主题明暗切换。
 *
 * 组件自身（Button / Input / Tag 等）从 ui-primitives 取得，这里只负责布局与
 * 提交图这类没有对应组件的部分。
 */
export const STYLES = `
.ggg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.ggg-bar{display:flex;align-items:center;gap:4px;padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.ggg-bar-item{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ggg-bar-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ggg-bar-item[aria-pressed='true']{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.ggg-bar-spacer{margin-left:auto}
.ggg-settings-backdrop{position:fixed;inset:0;z-index:40;background:var(--dsw-alias-overlay-scrim, rgba(0,0,0,0.32))}
.ggg-settings{position:fixed;z-index:41;top:50%;left:50%;transform:translate(-50%,-50%);min-width:280px;padding:14px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-alias-elevation-3, 0 8px 24px rgba(0,0,0,0.24))}
.ggg-settings-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
.ggg-settings-row{display:flex;align-items:center;gap:12px}
.ggg-settings-label{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.ggg-sec{border-bottom:1px solid var(--dsw-alias-border-l1)}
.ggg-sec-head{display:flex;align-items:center;gap:6px;padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}
.ggg-sec-head .ggg-count{color:var(--dsw-alias-label-tertiary);font-weight:400}
.ggg-sec-head .ggg-head-actions{margin-left:auto;display:flex;gap:2px}
.ggg-repos{display:flex;flex-direction:column;gap:1px;padding:0 6px 6px}
.ggg-repo{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12px}
.ggg-repo:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-repo.is-active{background:var(--dsw-alias-interactive-bg-active)}
.ggg-repo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ggg-repo-branch{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ggg-changes{display:flex;flex-direction:column;padding:0 6px 6px;max-height:38%;overflow-y:auto}
.ggg-change{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12px;min-width:0}
.ggg-change:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-change-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ggg-change-dir{color:var(--dsw-alias-label-tertiary)}
.ggg-change-stat{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ggg-change-btn{display:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-change:hover .ggg-change-btn{display:inline-flex}
.ggg-change-btn:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.ggg-status{flex:none;width:14px;text-align:center;font-weight:600;font-size:11px}
.ggg-status[data-type='M']{color:var(--dsw-alias-state-warn-primary)}
.ggg-status[data-type='A']{color:var(--dsw-alias-state-success-primary)}
.ggg-status[data-type='D']{color:var(--dsw-alias-state-error-primary)}
.ggg-status[data-type='U']{color:var(--dsw-alias-state-success-primary)}
.ggg-status[data-type='R']{color:var(--dsw-alias-brand-primary)}
.ggg-status[data-type='C']{color:var(--dsw-alias-brand-primary)}
.ggg-status[data-type='!']{color:var(--dsw-alias-state-error-primary)}
.ggg-commit-box{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.ggg-empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.ggg-graph{flex:1;min-height:0;overflow:auto;padding:0 0 12px}
.ggg-row{display:flex;align-items:center;gap:8px;height:24px;padding:0 8px;font-size:12px;cursor:default;white-space:nowrap}
.ggg-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-row.is-selected{background:var(--dsw-alias-interactive-bg-active)}
.ggg-lane{flex:none;height:24px}
.ggg-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ggg-refs{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:45%;overflow:hidden}
.ggg-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ggg-hash{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.ggg-pager{display:flex;justify-content:center;padding:8px}
.ggg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.ggg-error{padding:10px 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}
.ggg-detail{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-height:40%;overflow:auto;font-size:12px}
.ggg-detail-title{font-weight:600}
.ggg-detail-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}
.ggg-detail-body{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);line-height:1.6;max-height:120px;overflow:auto}
.ggg-issue-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ggg-issue-link:hover{text-decoration:underline}
.ggg-row-uncommitted{font-style:italic}

/* ── 右键浮层 ───────────────────────────────────────────── */
.ggg-menu-divider{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1)}
.ggg-menu-item{display:block;width:100%;box-sizing:border-box;text-align:left;padding:6px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.ggg-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-menu-item:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.ggg-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.ggg-menu-item-danger:hover{background:var(--dsw-alias-state-error-bg-secondary,rgba(255,0,0,0.08))}
.ggg-menu-item-checked{font-weight:600}

/* ── 设置分区 ───────────────────────────────────────────── */
.ggg-settings{top:8%;left:8%;right:8%;bottom:8%;transform:none;width:auto;max-width:560px;margin:auto;max-height:84vh}
.ggg-settings-body{overflow:auto;display:flex;flex-direction:column;gap:14px;padding:2px}
.ggg-set-section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.ggg-set-section-title{font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ggg-set-row{display:flex;align-items:center;gap:10px;font-size:12px}
.ggg-set-row-inline{cursor:pointer}
.ggg-set-row-text{flex:none;color:var(--dsw-alias-label-primary)}
.ggg-set-row-block{display:flex;flex-direction:column;gap:4px;font-size:12px}
.ggg-set-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.ggg-set-remotes{display:flex;flex-direction:column;gap:4px}
.ggg-set-remote{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.ggg-set-remote-name{flex:none;font-weight:600;font-size:12px}
.ggg-set-remote-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ggg-set-remote-del{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-set-remote-del:hover{background:var(--dsw-alias-state-error-bg-secondary,rgba(255,0,0,0.08));color:var(--dsw-alias-state-error-primary)}
.ggg-set-form{display:flex;flex-direction:column;gap:8px}

/* ── 自建弹窗（Modal 内表单） ───────────────────────────── */
.ggg-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.ggg-field-inline{flex-direction:row;align-items:center;gap:8px;cursor:pointer}
.ggg-field-label{color:var(--dsw-alias-label-secondary)}
.ggg-field-text{flex:1}
`;
