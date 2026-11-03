# Lake v0.3.25 本地整合预验证

日期：2026-11-03。**整合预验证通过，尚未合入develop，也未创建生产发布PR。** 本地干净候选`e03fa6a6c810f75bd7b449598eeaa37179d46255`，完整tree为`5fc7a9d0667a4118c802a3b4e89aef8a96ea454e`，保存在`codex/v0325-integration`。它是合入前的预验证提交，不能替代后续实际develop候选SHA。

## 整合来源与顺序

从`origin/develop`的`2b233a4ad9d405e5b7bf4705359303b31bcde652`建立本地验证分支，依次合入下列来源；没有向develop/master直接推送。

| 顺序 | 来源 | 准确head | 结果 |
| --- | --- | --- | --- |
| 1 | PR #143 · 标题宽度稳定 | `baf1c4b2841dd0d281e17a89bc502e891c8deff8` | 无冲突 |
| 2 | PR #142 · 长期专员频道与执行/UI修复 | `98bf19d78cb1207acad4d8b2789af581b8e259d2` | 无冲突 |
| 3 | PR #144 · 版本与生产历史同步 | `57ce9461cc8a362f803770704e831f8213060521` | 无冲突，保留master祖先 |
| 4 | 准备分支说明增量 | `56380da035766e7eb1729c0196d7336d55c6e495` | 补齐拟合入的频道/UI变更说明，无应用代码变更 |

#143的`WorkbenchIsland.tsx`、`workbenchIsland.css`、`readme-workbench.tsx`与#142逐文件完全一致；二者重叠不是不同实现。顺序合入后，相对#142的差异只有VERSION、macOS发布说明、验证文档和发布计划，没有新增Go/前端/原生应用代码。#144后续仅补充本记录，不改变被测应用源码。建议正式合入顺序为#143→#142→#144；#144必须使用merge commit，保留生产历史，不能squash/rebase。

## 本候选的检查结果

| 检查 | 结果 |
| --- | --- |
| `go test ./... -json -count=1 -timeout=10m` | 1987项通过、15项跳过、0失败 |
| AI/Web/Security/CLI扩大定向race | 215项通过、0失败；完整命令见JSON |
| `go vet ./...` | 通过 |
| ADK入口/provider AST及Security目录/边界 | 通过；附带AI/Security检查通过 |
| 前端测试 | 579项通过、0失败 |
| `scripts/build_lake_desktop.sh --dev --install` | 类型检查、Vite、签名构建、安装通过，严格签名通过 |
| 版本/来源/包摘要 | 0.3.25、Dev bundle ID、source=e03fa6a6、dirty=false；ZIP/DMG SHA-256校验通过 |

全量与定向测试使用各自隔离fixture，不访问生产Home。没有删除或放宽覆盖测试，也没有依据“无CI”推断成功；当前普通develop PR按规则没有自动CI。

## 真实Dev启动

在无活跃调查或待审批会话时，正常停止Lake Dev后安装并打开同一`~/.lake-dev`。原生工作台及真实专员频道可见，聊天定位在末尾；可见目录139项资源，当前项目135项，两个准确角色频道保留。API进一步核对：

| 任务 | 状态 | 验收 | 修订 |
| --- | --- | --- | --- |
| A3 | paused | insufficient | 15 |
| B3 | paused | insufficient | 10 |
| C4 | completed | pass | 78 |

Dev的Security清单仍是format2/finalized，在历史迁移归档已经删除的状态正常启动。没有发起新的主机命令、创建测试业务任务或改动上述验收。退出前的历史消息包含模型网络连接错误，原文仍保留；本轮没有发送新模型请求，不宣称外部provider可用性已验证。

本次安装的backend SHA-256为`c8e3edaf3d2be650cca6a537e5bdc3fdbf9374374466449ab466ea9c94a1822f`。原生包和backend沿用持久签名身份。ZIP摘要`12cf0071d01a19e4b57df69dbb822e9222f0730d5ff03873179f20b99371ca7e`，DMG摘要`1851376e60156f25d190e0ac61fe77f039c291df2a462735ce757cb86b2d5493`。`dist/macos/0.3.25/arm64/dev/`同名产物已替换最初863d2d9f准备包；最初摘要只作为历史验证记录，当前产物以上述整合摘要为准。Dev包不得作为正式Release资产上传。

## 下一道授权与发布边界

三项PR仍开放，用户此前授权仅为发布准备及继续核对。合入develop需要用户对这组具体PR明确授权；不能将本地merge当成已经完成GitHub合入。后续实际develop SHA须重新记录和验证，源码变化时重新跑相关检查。

本地整合分支用于保存被测提交，不创建第四个待合入功能PR；它不替代上述三个PR的评审。正式版Lake.app没有安装或重启，原0.3.24 reader仍不兼容当前生产迁移记录。创建develop→master发布PR、合并生产、发布/标签以及正式安装/重启继续各自受授权、CI与独立评审约束。

机器记录见[lake-v0325-integration.json](lake-v0325-integration.json)，整体准备与回退方案见[发布准备](lake-v0325-preparation.md)。
