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
/* 提交框固定在分区顶部，不随变更列表滚动；只有 .ggg-changes-scroll 滚动。 */
.ggg-workspace-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}
.ggg-workspace-body .ggg-commit-box{border-top:none;flex:none}
.ggg-changes-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}
/* 可拖拽的分界线：4px 命中区骑在分界线上（上下各溢出 2px，不占布局高度），
 * 拖动时显示一条高亮线。 */
.ggg-sec-resize{flex:none;position:relative;height:4px;margin-top:-2px;margin-bottom:-2px;cursor:row-resize;-webkit-user-select:none;user-select:none;touch-action:none}
.ggg-sec-resize::after{content:'';position:absolute;left:0;right:0;top:1px;height:2px;border-radius:2px;background:transparent;transition:background 0.12s ease}
.ggg-sec-resize:hover::after{background:var(--dsw-alias-interactive-bg-active)}
.ggg-sec-resize.is-dragging::after{background:var(--dsw-alias-state-business-primary)}
.ggg-change-group{margin-top:2px;padding-top:2px}
.ggg-change-group + .ggg-change-group{border-top:1px solid var(--dsw-alias-border-l1)}
.ggg-group-root{cursor:pointer}
.ggg-group-root .ggg-group-title{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-weight:600}
.ggg-group-root .ggg-count{margin-left:auto}
.ggg-change-group .ggg-changes{max-height:none}
.ggg-changes{display:flex;flex-direction:column;padding:0 6px 6px}
/* 图形区内的改动文件展开块：左列续画泳道线，右侧排文件树。
 * 内边距与列间距都与 .ggg-row 一致（8px），泳道列与文件树才不会相对提交行位移。 */
.ggg-detail-inline{display:flex;align-items:stretch;gap:8px;padding:0 8px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.ggg-detail-inline .ggg-detail-gutter{flex:none;align-self:stretch;display:block}
.ggg-detail-inline .ggg-detail-body{flex:1 1 auto;min-width:0;padding:4px 0 6px;font-size:12px}
.ggg-detail-changes{padding:0}
.ggg-detail-stat{flex:none;display:inline-flex;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ggg-detail-add{color:var(--dsw-alias-state-success-primary)}
.ggg-detail-del{color:var(--dsw-alias-state-error-primary)}
.ggg-change{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;font-size:12px;min-width:0}
.ggg-change:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-change.ggg-menu-target{background:var(--dsw-alias-interactive-bg-active)}
/* 文件行整行可点即打开；文件夹行仍是展开/收起。 */
.ggg-change-openable{cursor:pointer}
.ggg-change-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ggg-change-dir{color:var(--dsw-alias-label-tertiary)}
.ggg-folder{cursor:pointer}
.ggg-folder .ggg-change-name{flex:1 1 auto;direction:ltr;text-align:left;color:var(--dsw-alias-label-secondary)}
.ggg-folder .ggg-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.ggg-change-stat{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ggg-change-btn{display:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-change:hover .ggg-change-btn{display:inline-flex}
.ggg-change-btn:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
/* 文件状态字符与文件夹数量共用最右一列：定宽使两者左右边界都对齐。 */
.ggg-row-tail{flex:none;width:24px;text-align:center}
.ggg-status{font-weight:600;font-size:11px}
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
.ggg-row{display:flex;align-items:center;gap:8px;height:22px;padding:0 8px;font-size:12px;cursor:default;white-space:nowrap}
.ggg-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-row.is-selected{background:var(--dsw-alias-interactive-bg-active)}
.ggg-row.ggg-menu-target{background:var(--dsw-alias-interactive-bg-active)}
.ggg-lane{flex:none;height:22px;overflow:visible}
.ggg-subject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left}
.ggg-author{margin-left:6px;color:var(--dsw-alias-label-secondary)}
.ggg-refs{display:inline-flex;align-items:center;gap:4px;flex:none}
.ggg-ref{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:17px;border-radius:999px;font-size:11px;font-weight:500;line-height:1;white-space:nowrap}
.ggg-icon{display:inline-flex;align-items:center}
.ggg-icon svg{display:block}
.ggg-ref-text{min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis}
.ggg-ref-head{padding:0 8px;background:var(--dsw-alias-lane-0,#2f7bff);color:#0d1116}
.ggg-ref-branch{padding:0 8px;background:color-mix(in srgb,var(--dsw-alias-lane-0,#2f7bff) 18%,transparent);color:var(--dsw-alias-lane-0,#2f7bff)}
.ggg-ref-remote{width:17px;background:var(--dsw-alias-lane-4,#8b5cf6);color:#fff}
.ggg-ref-tag{width:17px;background:var(--dsw-alias-lane-0,#2f7bff);color:#fff}
.ggg-ref-stash{width:17px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-secondary)}
.ggg-ref-wide{width:auto;padding:0 8px}
.ggg-pager{display:flex;justify-content:center;padding:8px}
/* ── 悬停卡片（浮窗外观由 HoverCard 提供，这里只排内容） ── */
.ggg-card{display:flex;flex-direction:column;padding:12px 0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6}
.ggg-card-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 14px}
.ggg-card-icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.ggg-card-author{font-weight:500}
.ggg-card-time{color:var(--dsw-alias-label-tertiary);font-size:11px}
/* 提交信息：首行是标题，沿用卡片自身字号与行距；其余是正文，字号更小、行距更紧。
 * MarkdownText 的 compact 变体自带 font-size 与 line-height，段距仍有 4px；
 * 用 data-markdown-variant 属性（MarkdownText 在 compact 时输出）在卡片内覆盖。 */
.ggg-card-message{margin-top:6px;padding:0 14px;max-height:132px;overflow:auto;word-break:break-word}
.ggg-card-title{font:inherit}
.ggg-card-body{font-size:11px;line-height:1.35}
.ggg-card-body [data-markdown-variant='compact']{font-size:11px;line-height:1.35}
.ggg-card-body [data-markdown-variant='compact'] :is(p, ul, ol, blockquote){margin:0}
.ggg-card-body [data-markdown-variant='compact'] p + p{margin-top:2px}
.ggg-card-stats{margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}
.ggg-card-refs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ggg-card-hash{display:flex;align-items:center;gap:6px;margin-top:8px;padding:8px 14px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.ggg-card-copy{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-card-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ggg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.ggg-error{padding:10px 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}
.ggg-issue-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ggg-issue-link:hover{text-decoration:underline}
.ggg-row-uncommitted{font-style:italic}

/* ── 右键浮层 ───────────────────────────────────────────── */
.ggg-menu-divider{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1)}
.ggg-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:6px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.ggg-menu-chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary)}
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

/* ── 仓库行右侧操作 ───────────────────────────────────────── */
.ggg-repo-icon{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.ggg-repo-branch-icon{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.ggg-repo-more{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ggg-repo-more:hover{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}

/* ── 提交输入框 ───────────────────────────────────────────── */
.ggg-commit-input-wrap{position:relative;display:flex;align-items:stretch}
.ggg-commit-input{flex:1;min-height:52px;max-height:160px;padding:6px 28px 6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;resize:none;outline:none}
.ggg-commit-input:focus{border-color:var(--dsw-alias-brand-primary)}
.ggg-commit-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ggg-commit-input-actions{position:absolute;right:4px;top:0;bottom:0;display:flex;align-items:center;gap:2px}
.ggg-commit-input-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ggg-commit-input-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* ── 图标按钮（无常驻边框与背景） ─────────────────────────── */
.ggg-icon-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;transition:background 0.1s ease,color 0.1s ease}
.ggg-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ggg-icon-btn:disabled{opacity:0.5;cursor:default}

/* ── 图形区标题栏仓库名（图标+名称） ─────────────────────── */
.ggg-head-repo{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;padding:0 4px}

/* ── 仓库行分支名可点击 ───────────────────────────────────── */
.ggg-repo-branch.is-clickable{cursor:pointer;border-radius:3px;padding:0 2px}
.ggg-repo-branch.is-clickable:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* ── 引用筛选弹窗 ─────────────────────────────────────────── */
.ggg-filter-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3)}
.ggg-filter-dialog{width:420px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);overflow:hidden}
.ggg-filter-top{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ggg-filter-search{flex:1;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.ggg-filter-search:focus{border-color:var(--dsw-alias-brand-primary)}
.ggg-filter-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.ggg-filter-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 4px;border-radius:9px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600}
.ggg-filter-quick{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ggg-filter-quick-item{display:flex;align-items:center;gap:6px;cursor:pointer}
.ggg-filter-quick-label{font-size:12px;color:var(--dsw-alias-label-primary)}
.ggg-filter-quick-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ggg-filter-list{flex:1;overflow-y:auto;padding:4px 0}
.ggg-filter-row{display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer}
.ggg-filter-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ggg-filter-row.is-checked{background:var(--dsw-alias-interactive-bg-active)}
.ggg-filter-icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.ggg-filter-name{font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ggg-filter-hash{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-alias-font-mono,monospace)}
.ggg-filter-kind{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary);padding:0 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}

/* ── 静音合并提交 ─────────────────────────────────────────── */
.ggg-row-muted{opacity:0.5}

/* ── 悬停卡片头像 ─────────────────────────────────────────── */
.ggg-card-avatar{flex:none;width:20px;height:20px;border-radius:50%;object-fit:cover}

/* ── 远程配置编辑按钮 ─────────────────────────────────────── */
.ggg-set-remote-edit{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ggg-set-remote-edit:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ggg-set-form-actions{display:flex;gap:6px;margin-top:6px}
.ggg-dialog-hint{white-space:pre-wrap;line-height:1.6;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:8px}

/* ── 侧边栏差异查看页 ─────────────────────────────────────── */
.ggg-diff-tab{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
.ggg-diff-tab-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.ggg-diff-tab-path{font-size:12px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-alias-font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ggg-diff-tab-hash{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-alias-font-mono,monospace);margin-left:auto;flex:none}
/* 差异页正文：作为复制来的 FileDiff 的弹性父容器，滚动由后者自己承担。 */
.ggg-diff-tab-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.ggg-diff-tab-toggle{flex:none;margin-left:8px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.ggg-diff-tab-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ggg-diff-tab-toggle[aria-pressed='true']{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}

/* 差异视图的样式来自 ./file-diff.module.css（复制自 DSH ui-deliverables 的
 * FileDiff.module.css，MIT 许可），由构建脚本把 esbuild 产出的样式内联进包。 */

/* ── AI 提交信息 ─────────────────────────────────────────── */
.ggg-commit-input-btn.is-busy{opacity:0.5;pointer-events:none}
.ggg-ai-loading-bar{height:2px;width:100%;background:transparent;overflow:hidden;position:relative;flex:none;border-radius:1px}
.ggg-ai-loading-bar::after{content:'';position:absolute;top:0;left:-40%;height:2px;width:40%;background:var(--dsw-alias-color-success,#22c55e);border-radius:1px;animation:ggg-ai-slide 1.2s ease-in-out infinite}
@keyframes ggg-ai-slide{0%{left:-40%}100%{left:100%}}
.ggg-commit-ai-warning{font-size:11px;color:var(--dsw-alias-label-warning,var(--dsw-alias-label-secondary));padding:2px 0}
.ggg-commit-ai-stats{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0;font-family:var(--dsw-alias-font-mono,monospace)}
.ggg-set-ai-model{display:flex;flex-direction:column;gap:6px}
.ggg-set-row{display:flex;align-items:center;gap:8px}
.ggg-set-label{font-size:12px;color:var(--dsw-alias-label-secondary);width:56px;flex:none}
.ggg-set-select{flex:1;min-width:0;font-size:12px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary)}
.ggg-set-textarea{flex:1;min-width:0;font-size:12px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);resize:vertical;font-family:inherit}
`;
