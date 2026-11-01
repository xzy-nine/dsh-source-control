# 提示词基建模板

这套仓库提供 agent 的常驻指令、决策记录、按场景加载的技能与可执行门禁。从本模板建立仓库后，替换实例身份、补写仓库详情，即可把它当作该项目自己的提示词基建。

## 用法

从本模板建立新仓库，然后一次性替换全部身份槽位：

```sh
pnpm install
node scripts/instantiate-template.mjs --instantiate
pnpm run verify-all
```

`--instantiate` 把每个槽位换回 `template.placeholders.json` 里的 `example` 值，并同步重命名含槽位的目录与文件。真实名字不同时，先改映射表的 `example`，再执行替换；不要手工改文本，否则会漏掉目录名与技能 `name` 字段。

替换完成后 `verify-template-placeholders` 报告 `instantiated`，仓库进入正常使用状态。仍需要改名的场景（例如换了 CLI 名）编辑映射表后重跑同一条命令即可。

## 槽位

槽位名由「prompt infra slot」三段加主题名组成，全部小写并以连字符相连；必须落在合法标识符位置的槽位改用同名的全大写下划线形态。映射表是唯一事实来源，每个槽位声明含义、示例值与可选别名。

映射表只声明模板实际用到的槽位：声明而全仓零出现会被门禁拒绝，因为那意味着映射表已经不再描述这个仓库。删除引用某槽位的最后一段内容时，同一次改动里一并删掉该声明。

槽位形态受两条外部约束，改动前必须确认：

- 技能的 `name` 与目录名必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。含大写或下划线的槽位会让该技能被加载器静默忽略——它不会出现在技能目录里，也不会报错，只是消失。
- 出现在 TypeScript 源码标识符位置的槽位不能含连字符，否则替换后是语法错误而不是文案错误。

## 保留的具体内容

模板携带的实例内容不全是身份：示例路径、代码片段、诊断输出逐字示例与示例项目名承担说明作用，保留原样。判断标准是该字符串是否指代**本仓库自身**——指代自身的必须槽位化，只作示例的不动。

## 已有门禁

`pnpm run verify-all` 按依赖顺序运行全部门禁；`pnpm run test:docs` 是同一组快速检查。文档层级、写作规则与预算见 [docs/AGENTS.md](docs/AGENTS.md)，散文标准见 [.agents/skills/source-control-prose-standard/SKILL.md](.agents/skills/source-control-prose-standard/SKILL.md)。
