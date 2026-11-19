# Agent Note: SSH 认证判定取退出码

Status: implemented

## Problem

gitee 在横幅里给词上色：`Hi \x1b[36;01myang(@xzy_nine)\x1b[0m! You've \x1b[32msuccessfully\x1b[0m authenticated, but GITEE.COM does not provide shell access.`。颜色码把 `successfully` 与 `authenticated` 分开，以「好句子出现过」为判据的匹配在原文里找不到它，插件因此把已认证的 gitee 判成未认证，协议切换与发布都被拦下。

措辞、颜色与退出码都由远端决定：同一份判定还要覆盖 GitHub（认证通过时退出码为 1）、GitLab、Bitbucket 与自建服务。以横幅文字为判据的写法会跟着对方改，且失配方向是「已认证被判成未认证」，直接挡掉用户的操作。

## Decision

认证只看退出码。给了远程地址时跑 `git ls-remote --heads <SSH 地址>`，退出码 0 即通过；只有主机名时跑 `ssh -T git@<host>`，255 表示 ssh 自身出错（man ssh：ssh exits with the exit status of the remote command or with 255 if an error occurred），其余退出码是远端命令的状态，即认证已经通过。

有地址时的探测走 git 真实取数路径，本机 git 与 ssh 配置、代理与传输设置都参与其中；地址尚不存在的场合（发布到 GitHub 新仓库）退回握手探测。结果按探测目标缓存：给地址时按地址，否则按主机名。

未就绪的说明就是探测输出原文，界面不再按 ssh 的措辞把它归到指纹、公钥或网络某一类。

弹窗正文按 ANSI 上色渲染（`src/client/ui/ansi.ts` 的 `parseAnsi` 与 `AnsiText`）：SGR 序列转成颜色、加粗、暗淡、斜体与下划线，其它控制序列丢弃，文本一字不改。

## Alternatives considered

**剥掉 ANSI 序列后继续按文案匹配。** 否决：剥色只解决这一次的 gitee 横幅，判定仍依赖远端措辞，换个语言或换个服务就会再次失配。

**只看 `ssh -T` 的退出码。** 否决：它回答「能不能登录」，回答不了「这个远程能不能取数」；有地址时直接跑 `git ls-remote` 得到的才是与后续操作一致的结论。

**只看 `git ls-remote` 的退出码。** 否决：新建仓库的发布流程里地址还不存在，探测必然失败，会把可用的 SSH 判成不可用。

**把未就绪原文做成模板化的三类中文原因。** 否决：归类仍然是对远端措辞的正则匹配，而它只影响一句提示；原文加颜色渲染给的信息不比归类少。

## Consequences

认证判据与远端措辞解耦，gitee、GitHub 与后续接入的托管方共用一条判据。代价是失败说明不再是一句中文提示，原文里的英文要用户自己读；弹窗标题仍点明「SSH 未就绪」。

探测多了一条路径（`git ls-remote`），缓存因此从「按主机」变成「按探测目标」：同一主机下不同仓库的结论互不顶替。
