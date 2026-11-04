Lake v0.3.27 · macOS Apple Silicon

- 新增受控启动恢复工具，处理已完成初始迁移、但仍停留在只读恢复模式的旧基础库。核验并明确确认后，可以恢复 Pilot、模型对话和正常任务入口，无需删除原数据。
- 恢复前验证历史完整性、原操作身份、未决状态及独占运行条件；保留原有未知结果、审批、权限和防重放保护，不重放历史命令。备份恢复、已启用域级运行或存在在途任务等其他状态继续使用各自的恢复流程。

## 下载与安装

本版仅提供 macOS Apple Silicon（M 系列）arm64 的 ZIP、DMG 和 SHA-256，要求 macOS 13+；不提供 Windows 包。

已经恢复正常的客户端可直接更新使用。仍显示“安全迁移尚未完成”的客户端，需要先按[启动恢复说明](https://github.com/Clean-Lakes/Lake/blob/master/docs/security/checkpoint-and-recovery.md#已收尾初始迁移的启动恢复)进行只读预检、验证当前配对备份，并明确确认恢复；安装更新本身不会自动打开门禁，也不会代为核实未知结果。

更新前请结束当前操作并保全当前数据。已完成迁移收尾的数据不能直接降级到不支持完成记录的旧版本；出现异常时保留原数据库和控制记录，使用兼容修复版本处理。

macOS 包沿用 Lake Local Development Code Signing 持久证书，尚未使用 Apple Developer ID 公证；自动更新要求相同签名证书。
