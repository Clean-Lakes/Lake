# 任务 Worker 原生子智能体与第三联验证

日期：2026-11-06。测试源码：`ffcbc00a2711dddf74652eadaf92fe512b9dfe1f`；实现提交 `d43433d4`，历史只读投影与回执修正 `ffcbc00a`。[PR #183](https://github.com/Clean-Lakes/Lake/pull/183) 已经用户明确授权合入 `develop`，集成提交为 `c3076dae12f30b78fb7a66b96934c9f340cc186b`；原远端及本地工作分支 `codex/zcode-backend-3172` 已清理。

## 已验证行为

- Worker 使用公开 ZCode 3.17.2 AgentRuntime、SubagentPort 和原生 runner 创建独立 child Session。Pilot 无 Agent 工具；子不获得父任务结清、路由或递归能力。
- 临时 child 绑定原 Task/Worker；真实工具调用继承当前权限、审批、范围、owner/generation 和原账本。调用 ID 按准确 child Session 命名空间隔离。同 Task 实际业务派发串行，子模型与后台调查可并行。
- 原生后台调用通过 TaskOutput 汇合；活跃 child 阻止 work_finish。提前返回或用户停止经原生端口取消并等待实际子执行退出。根 Worker 与子实例累计最多 8 个，继续/失败/重启不重置记录。
- 子纯文字、Agent 启动回执与目录发现不能制造目标验收；拒绝、权限收窄和停止后的旧批准不能写入，unknown 保留且禁止重放。
- 原生 child 的真实状态、工具输入/输出及原始调用来源进入 AgentRun；原始模型推理不显示到第三联或父对话。
- 任务清单选中后收起，准确任务在第三联展示，中间频道/对话保留。Task 为主体，Worker 标为“由 Lake 分配”；长期专员仅作为任务来源。
- 执行树使用项目 resourceTree 与准确资源 ID。嵌套目录与同名资源不合并；跨资源/无资源/未知实例在任务层仅显示一次。未决工具结果向资源及祖先目录传播并默认展开，普通成功不能掩盖 unknown。
- 旧 TS 卡片从同项目、同 Session 的原操作记录只读关联；子卡额外核验 Task 与 child Session。四个读取/分页入口均不改写原 view、Goal、operation 或 acceptance，不启动模型，不补造历史执行。
- 结果页仅列当前任务具有可信 operation ID 的回执并去重；没有账本来源的原文仍可在执行历史查看。控制工具不计为业务回执。

## 自动检查

构建与测试使用固定 Node 24.14.0。模型夹具是本地合成 OpenAI SSE 服务，实际执行的是打包后的 ZCode AgentRuntime、原生 Agent 工具及真实临时文件/SSH 测试服务，没有替换模型/工具循环。

| 检查 | 结果 |
| --- | --- |
| `node .../typescript/bin/tsc -p runtime/zcode/tsconfig.json` | 通过 |
| `node runtime/zcode/build.mjs` | 通过，固定上游源与许可证 |
| `node --test runtime/zcode/server.test.cjs` | 63/63 通过，无跳过 |
| `tsx --test runtime/zcode/tasks.test.ts runtime/zcode/activity.test.ts runtime/zcode/assets.test.ts` | 25/25 通过 |
| `pnpm --dir web-agent test:frontend` | 644/644 通过 |
| `pnpm --dir web-agent build:web` | 类型检查与生产 Web 构建通过；保留既有 bundle size 提示 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `git diff --check` | 通过 |

新增集成覆盖独立 Session、原 Task 真实 Read 回执、无业务工具的拒绝验收、两个 child 使用相同原始 callId、越界读取、Write 审批/拒绝/权限变化、前台/后台停止、后台并行与汇合、父提前结束、实例上限及重启不重放。历史投影使用 SQLite 原始 JSON value 字节比较，验证读取不改写原记录。

合并后在准确集成提交 `c3076dae12f30b78fb7a66b96934c9f340cc186b` 上重跑后端 63/63、前端 644/644、TypeScript 类型检查及 ADK 边界检查，均通过。该提交与已安装签名 Dev 的 `ffcbc00a` 运行代码一致，其间仅增加验证文档。

## 界面与 Dev

- 合成多资源夹具检查浅色/深色、嵌套目录、子工具展开、结果页、键盘左右键切换与关闭后保留中间对话。1512px 宽窗和 900px 窄窗检查均无页面横向溢出；窄窗使用既有覆盖式第三联布局。空态与 unknown 修正另有模型/组件回归。
- 截图仅含合成资源和数据：[浅色执行树](light.png)、[深色结果](dark-results.png)、[深色执行页复核](dark-execution.png)、[浅色执行页复核](light-execution.png)。复核截图为 1512px；不将它们标作窄窗截图。
- `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 成功。Dev 0.3.27 已安装并重新启动，来源为干净 `ffcbc00a`，`backendRuntime=typescript`，二进制 SHA-256 与 build-origin.json 一致，严格签名校验通过。
- 原生窗口在首个实现提交 `d43433d4` 已实际验证：点击服务器专员、任务清单、已验收任务，清单关闭并在第三联显示准确任务/Worker；中间原频道保留。旧任务没有虚构 child。
- 2026-11-06 用户手动解锁后，完成最终签名 Dev 的原生重复检查：在服务器专员任务清单中点击“分析京东云服务器整体情况”，清单收起，第三联显示准确任务、验收状态与“任务 Worker · 由 Lake 分配”；中间原频道 URL 保持不变。展开资源后显示 3 条真实主机检查，单次检查可查看调用参数和实际结果；“结果与证据”仅显示 3 条业务工具回执，控制工具留在执行历史。关闭详情后重新从任务清单打开，仍定位原任务与频道；没有矛盾的“本轮尚无执行记录”空态。浅色原生界面的树层级、详情面板圆角和内容裁切正常。未将含实际资源数据的原生截图提交仓库。
- 最终 Dev 的实际只读 API 检查确认 ZCode 3.17.2 正在运行：原“分析京东云服务器整体情况”任务准确恢复 3 个历史操作回执和 1 个资源绑定，原任务仍为 0 个原生子实例；没有补造子任务或重执行。

## 边界与回退

本次功能在已授权 TS/ZCode Dev 预览内交付，不表示 PR #183 的完整迁移等价门禁已通过。未使用真实供应商重新执行多资源 child 业务任务；原生子执行使用上述合成供应商验证，未重放用户旧任务。其他平台与完整 Memory/工作流/终端等迁移仍按原计划验收。

本次仅按用户授权经 GitHub PR 合入 `develop`；未改变正式 Lake 或正式 Home，未读取/复制正式凭据，未创建 Release/标签或绕过保护。仓库 `develop` 的服务器分支保护查询返回 404（未启用），已向用户报告；文档约束不等于服务器强制保护。签名安装前退出 Dev 时确认无 active/queued Worker，通过鉴权 drain 正常停止，无强杀；安装继续使用持久开发签名。回退应保留新原生 child 与原操作/unknown 记录，停止 Dev 后更换兼容候选程序；不能清理账本或用旧结果重放操作。
