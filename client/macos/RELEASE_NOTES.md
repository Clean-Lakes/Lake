Lake v0.3.26 · macOS Apple Silicon

- 修复从旧版本升级后，在 Security 只读恢复模式下加载工作台出现“Internal server error”的问题。旧数据库尚无专员元数据表时，继续读取原项目、资源与历史记录。
- 保留已有专员元数据；只读恢复不创建表、不迁移数据库、不启动模型或终端，也不改变原操作、未知结果及安全门禁。

## 下载与安装

本版仅提供 macOS Apple Silicon（M 系列）arm64 的 ZIP、DMG 和 SHA-256，要求 macOS 13+；不提供 Windows 包。

此修复恢复关闭门禁时的工作台读取，不会自动解除安全恢复限制。原 Home 若已处于只读恢复状态，执行仍需按已有管理流程核查；更新不会重放历史命令或代为核实未知结果。

更新前请结束当前操作并保全当前数据。已完成迁移收尾的数据不能直接降级到不支持完成记录的旧版本；出现异常时保留原数据库和控制记录，使用兼容修复版本处理。

macOS 包沿用 Lake Local Development Code Signing 持久证书，尚未使用 Apple Developer ID 公证；自动更新要求相同签名证书。
