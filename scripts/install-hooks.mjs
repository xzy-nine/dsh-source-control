/**
 * 把仓库的 git hooks 指向 `.githooks/`。
 *
 * hook 脚本随仓库提交，靠 `core.hooksPath` 生效；`pnpm install` 的 prepare 阶段会自动调用本脚本，
 * 因此克隆后无需额外步骤。在 git worktree 里 `core.hooksPath` 由各 worktree 共享的配置承载，
 * 相对路径以各 worktree 根解析，因此同一条设置对主检出与所有 worktree 都成立。
 *
 * @returns 无。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hooksDir = join(root, '.githooks')

if (!existsSync(hooksDir)) {
  console.error(`[dsh-source-control] 未找到 hooks 目录：${hooksDir}`)
  process.exit(1)
}

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' })
} catch {
  // 不在 git 仓库里（例如从 tarball 安装）：静默跳过。
  process.exit(0)
}

const current = (() => {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

if (current === '.githooks') {
  console.log('[dsh-source-control] git hooks 已指向 .githooks')
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' })
console.log('[dsh-source-control] 已把 core.hooksPath 设为 .githooks')
