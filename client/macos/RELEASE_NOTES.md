Lake v0.3.23 · macOS Apple Silicon

- 调整工作区侧栏、输入框引用与光标，精简回复耗时及执行状态展示；计划与执行收进悬浮检查卡片，执行详情默认跟随最新轮次。
- 改善长任务继续、运行中补充消息接入、任务目标绑定与 Kubernetes 受控操作。
- 统一 Web / stdio 的 Home 与运行账本，增加独占 owner、存储身份和 reader 检查，保留旧操作证据与防重保护。
- 修复初始安全迁移中断导致工作区只能查看的问题，提供离线受控单库续跑；未知操作不会被批量判为成功或自动重放。
- 更新 README 浅色/深色演示截图与 Lake Security 五模块设计、七条内置 SOP 规划。完整任务级授权、孤儿租约治理及 SOP 清单界面仍在实施中。

## 下载与安装

本次仅发布 macOS Apple Silicon（M 系列）arm64，要求 macOS 13+。提供 ZIP、DMG 及 SHA-256 校验文件；不提供 Windows 包。

更新前请结束当前操作并备份数据。已有会话、资源和凭据继续保留；初始迁移异常时先保全账本并停止对应后端，再按实际状态使用离线恢复命令，不删除控制文件或重放未知操作。新存储协议不支持直接降级到不认识 reader guard 的旧版本。

macOS 包沿用 Lake Local Development Code Signing 持久证书，尚未使用 Apple Developer ID 公证；自动更新要求相同签名证书。
