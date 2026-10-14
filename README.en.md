# dsh-source-control

A [DeepSeek Harness](https://github.com/DeepSeek-ai/deepseek-harness) (dsh) plugin that adds a **Source Control page** to the DSH Web GUI's built-in right Sidebar: the commit graph, the working-tree changes list, and a commit box. Its controls come from DSH's own components, so it looks and behaves like the rest of the Harness. The repository is bound automatically to the current session's workspace; no manual repo selection is needed.

[中文文档](README.md)

## Features

- **Commit graph**: a lane graph of commits and ref markers, with automatic paging, hover cards, in-place changed-file expansion, and right-click checkout, branch, and tag actions.
- **Changes and commits**: the working-tree change list is grouped and can be staged or discarded, and the commit box supports Enter to commit, amending the last commit, and AI-generated messages.
- **Diff page**: side-by-side or unified views, word wrap, and git-hunk-only rendering.
- **GitHub integration**: create and push a repository, and create pull requests, through the `gh` CLI, degrading gracefully when it is missing, logged out, or short of scopes.
- **Remote protocols**: a remote address can be switched between HTTPS and SSH in both directions, checking the local SSH status before switching to SSH.
- **Safety and feedback**: destructive actions ask for confirmation, and failed actions explain themselves as a notice.

The complete description of every feature is in [doc/功能说明.md](doc/功能说明.md) (Chinese only).

## Entry points

Both entries come from this plugin and open the same page; no third-party sidebar plugin is required:

| Entry | Behaviour |
|---|---|
| Guide entry capsule | Open the right Sidebar's `+` control, then pick the **Source Control** capsule |
| Session header icon | Opens the page, or focuses the open one |

Switching to another sidebar page or workspace and coming back leaves the page as it was — it neither reloads nor loses its expanded state.

## Working with dsh-better-sidebar

When [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed, its capabilities are preferred; when it is absent or the relevant type is turned off, this plugin falls back automatically. Neither case needs configuration.

An optional dependency — this plugin works on its own.

## Install

```sh
dsh plugin --profile web add dsh-source-control
# restart `dsh web`; the right Sidebar's `+` → guide page shows Source Control, and the session header gains an icon
```

## License

This project's own code is MIT. See [LICENSE](LICENSE).
