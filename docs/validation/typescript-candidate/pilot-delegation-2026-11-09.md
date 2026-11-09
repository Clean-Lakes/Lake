# Pilot 默认派工与任务收尾验证

日期：2026-11-09。本记录覆盖 PR #206 最初的派工/收尾修复，功能与签名 Lake Dev 实测提交：`83c77a3b4282c91bccc633d80b25ee68201b5f3e`，基线 `origin/develop` 为 `c015446b0cb0d9ae79d532b4ede6f12a47dcc3d1`。该轮随后只追加验证文档与计划状态；后续 SSH 修复及最终组合提交 `21cf5990de41de998d817811a95029d14da6ed24` 的验证另见 [SSH 恢复记录](ssh-readonly-recovery-2026-11-09.md)。未操作正式应用或重跑截图中的服务器检查。

## 问题与修复

原规则允许 Pilot 自行处理简单工作，因此截图对应请求没有调用创建专员或派单工具，而是创建了一项 inline Pilot 任务。实际 SSH 操作成功；模型先用 `work_update` 验收步骤，再调用 `work_finish`，后者仍要求运行中的步骤，导致收尾失败。两个失败工具卡片不表示 SSH 本身失败。

现在资源工作默认创建或复用稳定专员，短检查与空角色列表也遵循此策略；纯对话和解释结果直接答复。明确要求 Pilot 亲自执行时保留完整工具能力。默认策略进入系统提示和有界请求工作集，不构成权限授权或基于关键词的拦截。

普通 inline Pilot 任务不再暴露 `work_begin/work_update`，统一使用自动记账和 `work_finish(summary, outcome)`；显式 Plan 及已有显式契约保留原协议。旧 host-managed 任务已通过步骤验收时，可以重新核对原证据后完成：要求当前 generation/policy、原始身份/版本/摘要、成功业务回执以及当前资源校验。不会新建 attempt、重发 I/O 或替换原步骤回执。汇总也复核其他已验收步骤。

## 自动回归

使用仓库固定 Node.js 24.14.0，以下 `node` 和 `tsx` 命令均把该目录置于 PATH 首位。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 原故障复现 | `web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test --test-name-pattern='host completion closes' runtime/typescript/tasks.test.ts` | 修复前出现原错误 `Call work_begin, then work_update(running) before resource access`；修复后通过 |
| 类型 | `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| 实际 SDK 构建 | `node runtime/typescript/build.mjs` | 固定 v3.17.2 源码构建通过 |
| TS 源码回归 | `web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts` | 219 项：215 通过，4 条件跳过（3 项可选 Claude-Mem、1 项 Linux 平台扫描） |
| 运行时与上下文 | `node --test runtime/typescript/*.test.cjs` | 177 项全部通过 |
| 最后一次夹具文字调整 | `node --test --test-name-pattern='default resource delegation' runtime/typescript/server.test.cjs` | 通过；只把夹具新请求改为明确的服务器检查，未改运行源码 |
| 运行边界 | `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| 签名 Dev 构建安装 | `scripts/build_lake_desktop.sh --dev --install` | Web 类型检查/构建、签名、安装均通过 |

新增回归覆盖：已验收步骤只完成一次且保留原 attempt/Operation/步骤回执；错误 generation、策略变化、结果篡改、资源版本失效、未决效果和仅发现目录均不能完成。普通 inline 工具协议及 Plan/已有显式契约的协议分别验证。原共同任务、停止、过期、权限与 unknown 防重放回归继续通过。

真实 SDK 集成夹具通过 loopback SSH 服务验证空列表创建、准确 RoleID 复用、独立任务/Session、实际 Bash 结果与验收；Pilot 明确亲自执行的 Bash、子智能体、后台汇合和计划审批继续通过。这些模型回复由夹具控制，不把它们当作真实模型遵循率。

## 真实 Lake Dev

运行 `~/Applications/Lake Dev.app`，Bundle ID `com.cleanlakes.lake.desktop.dev`，Home `~/.lake-dev`。签名产物的 build-origin 为干净提交 `83c77a3b4282c91bccc633d80b25ee68201b5f3e`，TS 后端 SHA256 为 `b1b3bc3c766fcebcf1a25d38d0fe1bfbb9c0aca673396b3e8758ff5e7a1a040d`。

使用已配置的真实模型（界面选择 `gpt-6.1-terra`），新建「Pilot 默认派工回归 1109」项目 `f8e77604-5ff3-4296-a4b9-65ce333d4ca6`。工作区只有本次测试文件 `reboot-fixture.txt`；请求明确禁止访问 SSH、数据库、网络和修改文件。

| 用户输入/变化 | 实际行为 | 原任务结果 |
| --- | --- | --- |
| 普通要求读取本地演练文件，未指定专员或要求委派 | 自动创建 `workspace_reader` 专员并派单；独立 Session 读取文件 | `st_5ecbd5358cf1dc9e844959db130880ed`：completed/pass，返回 `QA_BOOT_A`、3600 秒 |
| 测试方更新文件为 B/7200，再要求重新读取 | 复用相同 RoleID，新 Task/Session 取得新值，不重复旧摘要 | `st_8ee74195d958a64769f5fc7ff0b36e66`：completed/pass，返回 `QA_BOOT_B`、7200 秒 |
| 明确要求 Pilot 亲自读取，不委派、不创建子智能体 | Pilot inline Task 直接 Read | `pilot_task_5d52aff6e7451c417910a50316be42cf`：completed/pass，返回 B/7200 |

只读核对 Dev SQLite：一个长期专员、三个不同执行 Session、三笔 `Read/succeeded`、六张步骤/目标验收回执及三笔交付。没有失败操作。原生工作台实际显示「专员 2」（Pilot 加新专员）、两次专员报告和一次 Pilot 直接报告，最终状态已结束，无收尾失败卡片。测试项目保留供复核。

## 范围与回退

未引入数据迁移、额外许可、另一套完成权威或生产操作。旧任务不会因升级自动完成或重跑。默认委派是模型行为策略；本次真实模型三轮通过不能证明所有模型、复杂任务或外部资源的稳定遵循率。真实云主机未重测，SSH 派工机械链路通过隔离 loopback 服务测试。

回退本 PR 的代码和提示词即可恢复旧策略；不得删除操作账本或把旧的成功验收改成未执行。新 PR 进入 develop 前仍需相应合并授权，当前 Dev 验证不授权正式发布或生产安装。
