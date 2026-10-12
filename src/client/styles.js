/**
 * 视图样式：以 --dsw-* 语义 token 为主，随主题明暗切换；引用标记取泳道调色板的固定色。
 *
 * 组件自身（Button / Input / Checkbox 等）从 ui-primitives 取得，这里只负责布局与
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
.ggg-sec{border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.ggg-sec-head{cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;user-select:none}
.ggg-sec-head .ggg-chevron{transition:transform 0.15s ease}
.ggg-sec-head.collapsed .ggg-chevron{transform:rotate(-90deg)}
.ggg-sec-head .ggg-count{color:var(--dsw-alias-label-tertiary);font-weight:400}
.ggg-sec-head .ggg-head-actions{margin-left:auto;display:flex;gap:2px}
.ggg-repos{display:flex;flex-direction:column;gap:1px;padding:0 6px 6px}
.ggg-repo{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12px;cursor:pointer;position:relative}
.ggg-repo:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-repo.is-active{background:var(--dsw-alias-interactive-bg-active)}
.ggg-repo.is-missing{opacity:0.55}
.ggg-repo-guide{flex:none;width:12px;align-self:stretch;border-left:1px solid var(--dsw-alias-border-l2);margin-left:3px}
.ggg-repo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ggg-repo-branch{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ggg-repo-chevron{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);transition:transform 0.12s ease}
.ggg-repo-chevron.is-collapsed{transform:rotate(-90deg)}
.ggg-repo-chevron.is-empty{visibility:hidden}
.ggg-repo-kind{flex:none;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.ggg-repo-sync{flex:none;display:inline-flex;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ggg-sec-note{color:var(--dsw-alias-state-warn-primary);cursor:default}
.ggg-sec.ggg-workspace{flex:1 1 auto;min-height:0}
.ggg-sec.ggg-graph-sec{flex:0 0 auto}
.ggg-workspace-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto}
.ggg-workspace-body .ggg-commit-box{border-top:none}
.ggg-sec-resize{flex:none;height:6px;cursor:row-resize;background:transparent;transition:background 0.12s ease}
.ggg-sec-resize:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-sec-resize.is-dragging{background:var(--dsw-alias-interactive-bg-active)}
.ggg-change-group{margin-top:2px;padding-top:2px}
.ggg-change-group + .ggg-change-group{border-top:1px solid var(--dsw-alias-border-l1)}
.ggg-group-root{cursor:pointer}
.ggg-group-root .ggg-group-title{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-weight:600}
.ggg-group-root .ggg-count{margin-left:auto}
.ggg-change-group .ggg-changes{max-height:none}
.ggg-changes{display:flex;flex-direction:column;padding:0 6px 6px}
.ggg-change{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12px;min-width:0}
.ggg-change:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-change.ggg-menu-target{background:var(--dsw-alias-interactive-bg-active)}
.ggg-change-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ggg-change-dir{color:var(--dsw-alias-label-tertiary)}
.ggg-folder{cursor:pointer}
.ggg-folder .ggg-change-name{flex:1 1 auto;direction:ltr;text-align:left;color:var(--dsw-alias-label-secondary)}
.ggg-folder .ggg-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;margin-left:auto}
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
.ggg-row.ggg-menu-target{background:var(--dsw-alias-interactive-bg-active)}
.ggg-lane{flex:none;height:24px}
.ggg-subject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left}
.ggg-author{margin-left:6px;color:var(--dsw-alias-label-secondary)}
.ggg-refs{display:inline-flex;align-items:center;gap:4px;flex:none}
.ggg-ref{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:17px;border-radius:999px;font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.ggg-ref-icon{display:inline-flex;align-items:center}
.ggg-ref-icon svg{display:block}
.ggg-ref-text{min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis}
.ggg-ref-head{padding:0 8px;background:var(--dsw-alias-lane-0,#4f8ff7);color:#0d1116}
.ggg-ref-branch{padding:0 8px;background:color-mix(in srgb,var(--dsw-alias-lane-0,#4f8ff7) 18%,transparent);color:var(--dsw-alias-lane-0,#4f8ff7)}
.ggg-ref-remote{width:17px;background:var(--dsw-alias-lane-4,#9b7bf6);color:#fff}
.ggg-ref-tag{width:17px;background:var(--dsw-alias-lane-0,#4f8ff7);color:#fff}
.ggg-ref-stash{width:17px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-secondary)}
.ggg-ref-wide{width:auto;padding:0 8px}
.ggg-pager{display:flex;justify-content:center;padding:8px}
/* ── 悬停卡片（浮窗外观由 HoverCard 提供，这里只排内容） ── */
.ggg-card{display:flex;flex-direction:column;padding:12px 0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6}
.ggg-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 14px}
.ggg-card-icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.ggg-card-author{font-weight:500}
.ggg-card-time{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ggg-card-message{margin-top:6px;padding:0 14px;max-height:132px;overflow:auto;word-break:break-word}
.ggg-card-stats{margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}
.ggg-card-refs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ggg-card-hash{display:flex;align-items:center;gap:6px;margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.ggg-card-copy{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-card-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
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
