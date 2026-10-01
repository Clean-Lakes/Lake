# 授权与迁移回归

| 边界 | 当前证据 |
|---|---|
| 旧库升级、未来版本、私有备份、schema 19 | `packages/lake/test/migrations.test.mjs` |
| 凭据权限、符号链接、输出脱敏 | `vault.test.mjs`、`settings.test.mjs` |
| 显式签名迁移、私有 FD 3、先保存后删除 | `secrets.test.mjs`，使用假迁移入口 |
| 审批、撤权、取消、重复派发、湖志顺序 | `operations.test.mjs`、`conversation.test.mjs` |
| 运维工作流依赖、未知写恢复、冻结范围 | `workflow-run.test.mjs`、`workflows.test.mjs` |
| 计划租约、版本与命令授权、撤权后无派发 | `metadata.test.mjs`、`workflow-run.test.mjs` |
| 原生会话恢复、问题归属、取消启动、只读报告 | `native-agent.test.mjs` |
| 原生文件范围、持续 PTY、内容摘要冲突 | `workbench.test.mjs` |
| 原生 SSH 主机校验与多连接转发 | `native-remote.test.ts` |
| 桌面协议范围、凭据入口拒绝、75 个方法 | `desktop-server.test.mjs`、`client/desktop/bridge_test.go` |

测试均使用合成数据。原生代码工具、插件、浏览器和其他通用能力的权限实现由 ZCode 负责；LAKE 运维工具另外核对自己的资源与工作流范围。
