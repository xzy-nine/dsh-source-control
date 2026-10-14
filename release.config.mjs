export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    // npmPublish: false —— 只回写 package.json 版本号；构建与发布由工作流的 publish 任务承担，
    // 那里才装了本项目的依赖。
    ['@semantic-release/npm', { npmPublish: false }],
    ['@semantic-release/github', { successComment: false, failComment: false }],
    [
      '@semantic-release/git',
      {
        assets: ['package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
}
