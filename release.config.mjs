export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/npm', { npmPublish: true }],
    ['@semantic-release/github', { successComment: false, failComment: false }],
    [
      '@semantic-release/git',
      {
        // pnpm-lock 的根 importer 不记录包版本，回写只涉及 package.json。
        assets: ['package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
}
