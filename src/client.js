window.__ModuleLoader__.load({
  id: "dsh-dev-git-graph",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    // ============ dsh-dev-git-graph client：Git Graph 提交图（内置右侧栏页） ============
    // 内容面：内置右侧 Sidebar 的页类型（ctx.sidebarRightTabs.register），正文注册在键为该
    //   类型 id 的 sidebar.right.pane.tab 席位，chip 标题注册在 sidebar.right.pane.tab.title。
    // 打开方式一：引导页（tab 条 + 控件）中本类型贡献的「Git Graph」入口胶囊。
    // 打开方式二：会话 header 右侧 utilities（conversation.session.header.utilities）的图标按钮。
    // repo：该会话工作区 cwd，由席位标准 hook useSessions 提供并跟随会话更新。
    // 数据源：宿主路由 /dsh-dev-git-graph/gg/（入口）+ /dsh-dev-git-graph/gg/api（消息）。
    // 主题：从父页读真实 --dsw-alias-* 解析值 + body[data-ds-dark-theme]，postMessage 同步进 iframe。

    var TAB_ID = "dsh-dev-git-graph/git-graph";
    var TAB_KIND = "devGitGraph";
    var TAB_TITLE = "Git Graph";
    var HEADER_ACTION_ID = "dev-git-graph";
    // 会话 header 右侧 utilities 升序排列，order 0 为更多操作菜单，-5 位于其左侧。
    var HEADER_ACTION_ORDER = -5;

    // 与 scripts/pack-web.mjs 的 MAP 对齐：需要透传给 iframe 的 DSH alias token。
    var THEME_TOKENS = [
      "--dsw-alias-font-family",
      "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2",
      "--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary",
      "--dsw-alias-border-l1", "--dsw-alias-border-l2",
      "--dsw-alias-interactive-bg-active", "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-brand-primary",
      "--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
      "--dsw-alias-button-elevated-fill", "--dsw-alias-button-floating-hover", "--dsw-alias-button-contrast-fill",
      "--dsw-alias-fill-l2",
      "--dsw-alias-state-error-primary", "--dsw-alias-state-error-secondary",
      "--dsw-alias-state-warn-primary", "--dsw-alias-state-success-primary",
      "--dsw-alias-shadow",
      "--dsw-alias-bg-highlight", "--dsw-alias-border-highlight"
    ];

    // apply 写入、组件读取：iframes 的 repo 回退探测需要 ctx.sessions。
    var ctxRef = { current: null };

    function readThemeTokens() {
      var out = {};
      var cs = getComputedStyle(document.body);
      for (var i = 0; i < THEME_TOKENS.length; i++) {
        var v = cs.getPropertyValue(THEME_TOKENS[i]);
        if (v && v.trim() !== "") out[THEME_TOKENS[i]] = v.trim();
      }
      return out;
    }

    function isDark() {
      return !!(document.body && document.body.hasAttribute("data-ds-dark-theme"));
    }

    function postTheme(frame) {
      if (!frame || !frame.contentWindow) return;
      try {
        frame.contentWindow.postMessage(
          { type: "dsh-dev-gg-theme", dark: isDark(), tokens: readThemeTokens() },
          window.location.origin
        );
      } catch (e) { /* ignore */ }
    }

    function sessionCwd(ctx, sessionId) {
      var sessions = ctx.sessions || (ctx.get ? ctx.get("sessions") : undefined);
      if (!sessions) return null;
      try {
        var b = sessions.binding(sessionId);
        var s = b && b.session && b.session.getSnapshot ? b.session.getSnapshot() : null;
        if (s && s.cwd) return s.cwd;
      } catch (e) { /* ignore */ }
      try {
        var snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
        return (snap && snap.byId && snap.byId[sessionId] && snap.byId[sessionId].cwd) || null;
      } catch (e) { return null; }
    }

    // IconProps：size 为方形边长（默认 16），className 供调用方定位，颜色随 currentColor。
    function GitGraphIcon(props) {
      var size = props && props.size ? props.size : 16;
      return React.createElement(
        "svg",
        {
          width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor",
          className: props && props.className ? props.className : undefined,
          "aria-hidden": "true", focusable: "false"
        },
        React.createElement("path", { d: "M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6A1 1 0 005 9.5v1.878a2.251 2.251 0 11-1.5 0V4.622a2.251 2.251 0 111.5 0v1.58A2.49 2.49 0 006 7h4a1 1 0 001-1v-.578A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" })
      );
    }

    function GitTreeView(props) {
      var sessionId = props.sessionId;
      var repoHint = props.repoHint || null;
      var frameRef = React.useRef(null);
      var statePair = React.useState({ phase: "loading", url: null, err: null, cwd: null });
      var state = statePair[0], setState = statePair[1];

      React.useEffect(function () {
        var alive = true;
        Promise.resolve().then(function () {
          var cwd = repoHint || sessionCwd(ctxRef.current, sessionId);
          if (!cwd) { if (alive) setState({ phase: "err", err: "该会话没有工作区目录", url: null, cwd: null }); return; }
          if (!alive) return;
          setState({
            phase: "ok",
            cwd: cwd,
            err: null,
            url: "/dsh-dev-git-graph/gg/index.html?repo=" + encodeURIComponent(cwd)
          });
        });
        return function () { alive = false; };
      }, [sessionId, repoHint]);

      // iframe 就绪 + 宿主题切换时，把真实 token 值与暗色标记推进 iframe。
      React.useEffect(function () {
        if (state.phase !== "ok") return undefined;
        var frame = frameRef.current;
        var push = function () { postTheme(frame); };

        var obs = new MutationObserver(function (muts) {
          for (var k = 0; k < muts.length; k++) {
            if (muts[k].type === "attributes" && muts[k].attributeName === "data-ds-dark-theme") push();
          }
        });
        if (document.body) obs.observe(document.body, { attributes: true });

        if (frame) {
          frame.addEventListener("load", push);
          try { if (frame.contentDocument && frame.contentDocument.readyState === "complete") push(); } catch (e) { /* ignore */ }
        }
        return function () { obs.disconnect(); if (frame) frame.removeEventListener("load", push); };
      }, [state.phase, state.url]);

      if (state.phase === "loading") {
        return React.createElement("div", { className: "dsh-dev-git-graph-hint" }, "正在加载 Git Graph…");
      }
      if (state.phase === "err") {
        return React.createElement("div", { className: "dsh-dev-git-graph-hint err" }, state.err);
      }
      return React.createElement(
        "div",
        { className: "dsh-dev-git-graph-root" },
        React.createElement("iframe", {
          ref: frameRef,
          className: "dsh-dev-git-graph-frame",
          src: state.url,
          title: "Git Graph"
        })
      );
    }

    // 页正文：取该席位的 sessionId。useSessions 是 session 作用域席位的标准 hook；
    // 宿主未提供该 hook 时退回一次性 sessions 读取（两个分支各是一个稳定组件）。
    function GitGraphTab(props) {
      if (typeof props.useSessions === "function") return React.createElement(GitGraphSessionTab, props);
      return React.createElement(GitGraphStaticTab, props);
    }

    function GitGraphSessionTab(props) {
      var sessionId = props.sessionId;
      var cwd = props.useSessions(function (sessions) {
        var entry = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
        return entry ? entry.cwd : undefined;
      });
      return React.createElement(GitTreeView, { sessionId: sessionId, repoHint: cwd });
    }

    function GitGraphStaticTab(props) {
      return React.createElement(GitTreeView, { sessionId: props.sessionId, repoHint: null });
    }

    // chip 标题：类型未注册标题席位时用打开时捕获的 TAB_TITLE。
    function GitGraphTitle() {
      return React.createElement(
        "span",
        { className: "dsh-dev-git-graph-chip" },
        React.createElement(GitGraphIcon, { size: 16 }),
        React.createElement("span", null, TAB_TITLE)
      );
    }

    // 会话 header 图标按钮：打开（已存在时聚焦）本类型的页。
    function GitGraphHeaderAction(props) {
      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-dev-git-graph-open",
          title: TAB_TITLE,
          "aria-label": TAB_TITLE,
          onClick: props.open
        },
        React.createElement(GitGraphIcon, { size: 16 })
      );
    }

    function ensureStyle() {
      if (document.getElementById("dsh-dev-git-graph-style")) return;
      var st = document.createElement("style");
      st.id = "dsh-dev-git-graph-style";
      st.textContent = [
        ".dsh-dev-git-graph-root{box-sizing:border-box;width:100%;height:100%;min-height:0;flex-direction:column;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base)}",
        ".dsh-dev-git-graph-frame{flex:1;border:none;width:100%;min-height:0}",
        ".dsh-dev-git-graph-hint{padding:24px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
        ".dsh-dev-git-graph-hint.err{color:var(--dsw-alias-state-error-primary)}",
        ".dsh-dev-git-graph-chip{display:inline-flex;align-items:center;gap:6px}",
        ".dsh-dev-git-graph-open{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
        ".dsh-dev-git-graph-open:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
      ].join("\n");
      document.head.appendChild(st);
    }

    function apply(ctx) {
      ensureStyle();
      ctxRef.current = ctx;

      // 响应 iframe 启动时的主题请求（见 vendor utils.ts 的 dsh-dev-gg-theme-init）。
      window.addEventListener("message", function (e) {
        if (e.source === window || !e.source) return;
        var data = e.data;
        if (data && data.type === "dsh-dev-gg-theme-init") {
          var frames = document.querySelectorAll("iframe.dsh-dev-git-graph-frame");
          for (var i = 0; i < frames.length; i++) postTheme(frames[i]);
        }
      });

      var slots = ctx.slots || (ctx.get ? ctx.get("slots") : undefined);
      if (!slots || !slots.inject) return;

      // ============ 右侧栏页类型（本插件唯一内容面） ============
      // 定义与正文两阶段注册：定义进 ctx.sidebarRightTabs，正文与 chip 标题按定义 id 进
      // 带键席位。guide 条目让引导页（tab 条 + 控件）出现打开入口。
      var rightTabs = ctx.sidebarRightTabs;
      if (rightTabs && typeof rightTabs.register === "function") {
        var disposeType = rightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: function () { return TAB_TITLE; },
          guide: [{
            id: TAB_ID,
            order: 30,
            title: function () { return TAB_TITLE; },
            description: function () { return "当前会话工作区的提交图"; },
            icon: GitGraphIcon
          }]
        });
        ctx.effect(function () { return disposeType; });
      }

      ctx.effect(function () {
        return slots.inject("sidebar.right.pane.tab", function () {
          return slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, GitGraphTab);
        });
      });
      ctx.effect(function () {
        return slots.inject("sidebar.right.pane.tab.title", function () {
          return slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, GitGraphTitle);
        });
      });

      // ============ 会话 header 打开入口 ============
      var sidebarRight = ctx.sidebarRight;
      if (sidebarRight && typeof sidebarRight.openTab === "function") {
        ctx.effect(function () {
          return slots.inject("conversation.session.header.utilities", function () {
            return slots.register({
              name: "conversation.session.header.utilities",
              id: HEADER_ACTION_ID,
              order: HEADER_ACTION_ORDER,
              label: function () { return TAB_TITLE; },
              inject: function () {
                return {
                  open: function () {
                    // 无屏幕会话时右侧栏命令 throw；该按钮仅在会话页 header 渲染。
                    try { sidebarRight.openTab(TAB_KIND); } catch (e) { /* ignore */ }
                  }
                };
              }
            }, GitGraphHeaderAction);
          });
        });
      }
    }

    exports.apply = apply;
    exports.inject = ["sessions", "slots", "sidebarRight", "sidebarRightTabs"];
    return module.exports;
  }
});
