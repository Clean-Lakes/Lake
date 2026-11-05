# 会话头像和气泡比例验证

日期：2026-11-05（Asia/Shanghai）。

## 变更范围

会话头像使用 28px 显示区域，头像与气泡间隔 12px；气泡内边距为纵向 13px、横向 18px，署名 14px，正文 15px / 1.55 行高。会话正文气泡最多 720px，宽度受当前会话栏约束。

同一用户轮次中连续的 Pilot 文字回复只在首条显示头像和署名，后续气泡正文对齐、间距 8px，并保留供辅助技术读取的作者。工具、错误、用户输入和专员报告中断分组；已折叠的首条回复不会移除最终可见回复的身份。专员报告保留独立身份和跳转入口，专员频道延续不占头像列的布局。

仅调整呈现，保留消息、作者、任务和流式节点，不改变权限、资源操作、模型请求或上下文处理。

## 已测试版本

| 项目 | 版本或环境 |
| --- | --- |
| 源分支 | `codex/conversation-proportions`，基于 `origin/develop` 的 `caab241e89bc93f38e6395b69f3e85a285637296` |
| 已测试功能提交 | `6e608162f26d307f4516431173c22caa8b4318dc`；其后的提交仅添加本验证材料 |
| Lake Dev 安装提交 | 私有本地集成分支 `codex/dev-specialists-install` 的 `a1583a071aa199bc3ebd2afb77e43916a67af7b6`，包含上述功能提交 |
| 平台与隔离 | macOS，`~/Applications/Lake Dev.app`，`~/.lake-dev` |

Dev 集成保留本机已有的专员头像动画和湖面浮标思考动画。适配了集成分支的头像状态归属：连续回复隐藏第二个头像后，进行中的动画仍作用于该组可见的首个头像。该动画接口不在本 PR 的 develop 基线内；本 PR 不引入其尚未合并的接口。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir web-agent check` | 通过 |
| `pnpm --dir web-agent test:frontend` | 源分支 591/591 通过；Dev 集成分支 604/604 通过 |
| `pnpm --dir web-agent build:web` | 通过；保留原有大体积 bundle 提示 |
| `git diff --check` | 通过 |
| `scripts/build_lake_desktop.sh --dev --install` | 签名构建、安装和启动通过 |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | 通过 |

浏览器使用 `web-agent/web/test/fixtures/reply-proportions.html` 中的真实会话组件和合成数据，未接入模型或资源操作。验证了恢复后的消息、流式回复到完成、工具边界和专员频道：

- 头像区域及 SVG 宽度均为 28px，正文实测 15px / 23.25px；连续两条正文起点相同，气泡间距实测 8px。
- 流式到完成保持同一个回复 DOM 节点；被折叠回复实际高度为 0，最终回复恢复可见身份。
- 390px 窄屏无横向溢出，头像未被旧窄屏样式压回 18px；专员频道头像列为 0。
- 浅色和深色下检查气泡圆角、背景裁切、文字及署名对齐。

原生 Lake Dev 中检查了真实 Pilot 历史会话：新比例、连续回复单次署名和正文对齐均生效；打开/关闭执行检查栏后布局正常。切换深色主题检查气泡和头像，Tab 焦点可见，随后恢复原有“跟随系统”设置。保留原会话，没有发送新的模型任务或资源操作。

安装前后核对 `messages`、`superagentInputs`、`native_operations`、`native_approvals`、`superagent_decisions`、`superagent_events` 六张表的规范化指纹，结果一致。运行中的原生后端与安装包一致，服务中的 Web 资源与该次构建一致；哈希证据见 [安装校验](lake-conversation-proportions-installed.json)。

合成数据截图：[浅色](lake-conversation-proportions-light.png)、[深色窄屏](lake-conversation-proportions-dark-narrow.png)。真实会话截图不提交到仓库。

## 边界与回退

未验证 Windows 原生客户端；本次没有 Go/权限/持久化变更，未重复运行后端测试。原生验证读取已有历史，不代表截图中旧任务或上下文错误已修复。

无数据迁移。回退本 PR 的 UI 提交后重新签名构建 Lake Dev 即可，不需要改动会话数据。PR 面向 develop，尚未授权合并或发布。
