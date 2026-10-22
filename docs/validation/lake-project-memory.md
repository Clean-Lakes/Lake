# Lake 项目记忆代码层验证

日期：2026-10-13。实现仍在工作区，`plan/feature-project-memory-1.md` 保持 **In Progress**。

当前链路：成功的主 Agent 轮次将脱敏快照与 AI 状态原子保存为 outbox；SQLite 按项目、会话和轮次幂等入队；后台 worker 认领带租约的任务，使用原轮次模型的现有凭据发送无工具提取请求；来源、epoch、版本和租约通过后，在一个事务内提交记忆与任务回执；Markdown 文件由 SQLite 重建。项目侧栏提供记忆面板，输入区提供本轮忽略选项。项目归档及资源归档会使旧任务失效。

已执行检查：

- `go test ./... -count=1`：通过。
- `pnpm --dir web-agent check`：通过。
- `pnpm --dir web-agent test:frontend`：88 项通过。
- `scripts/build_lake.sh`：成功构建 `bin/lake`；`codesign --verify --strict bin/lake` 通过，签名身份为 `Lake Local Development Code Signing`。
- 使用签名二进制和隔离临时 home 创建项目、写入记忆、重启后读取：返回 1 条记忆。没有使用生产模型凭据。

新增的 Go 测试覆盖旧库迁移前备份、跨项目隔离、手工版本冲突、忘记与显式恢复、符号链接投影防护、outbox 去重、自动提取与跨会话读取、同步记忆工具、未授权记忆工具写入、单轮忽略、项目开关、原模型解析、失败任务重试、项目归档失效以及 UTF-8 分页。

尚未完成方案中的所有验收项：六种模型协议的提取请求尚未逐一用伪 provider 捕获；Windows 权限与替换流程尚未实测；前端项目快速切换和请求取消尚缺专门 UI 测试；自动事实的语义稳定性主要由提取提示词与来源校验约束，仍需真实场景观察。人工重试保留原轮次的知识基线，避免覆盖后来修改或遗忘的条目。
