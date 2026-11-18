Lake v0.3.34 · macOS Apple Silicon

- 修复旧项目安全策略迁移后服务资源无法保存或测试的问题：仅适配已确认、恢复身份一致且相关规则明确允许的 legacy 策略；原策略与历史资源范围保留。
- Kubernetes 连接支持新增、编辑和显式测试，接受 API Server/Token 或内嵌 YAML/JSON Kubeconfig，支持 Context、命名空间、超时与 TLS 设置。沿用 CA、客户端证书和服务名验证，不执行认证插件或读取外部凭据文件。
- Redis 连接测试使用兼容旧服务的 RESP2 AUTH、SELECT 和 PING；保留 ACL 用户名、认证、TLS、超时及策略检查。
- 外部 Agent 可通过有范围限制的 MCP 入口向项目 Pilot 或专员提交任务、补充信息和查询实际状态；消息身份、重试与任务归属继续校验。
- 本机 Codex 接入改用官方 App Server，复用已有登录与配置，保留真实线程、轮次和工具桥边界。Pilot 支持连续任务输入与交接；专员正文、最终结果和执行过程的更新更连贯。
- 优化专员思考状态、原位结果显示和设置视图尺寸。macOS 继续内置签名 TypeScript 运行时，无需安装 Node；本批仅面向 Apple Silicon。

## 已知范围

本版并非旧版功能完整替代：附件/图片、上下文压缩/回退、文件恢复、Kubernetes Agent 查询/操作工具、工作流运行与日程、完整安全管理/恢复、部分 Agent 的同轮补充消费确认及其他平台仍有未完成项。Kubernetes 连接配置和版本测试不代表 Agent 操作工具已经迁移。准确能力及分阶段证据见 [TypeScript 说明](https://github.com/Clean-Lakes/Lake/blob/master/runtime/typescript/README.md) 和 [等价矩阵](https://github.com/Clean-Lakes/Lake/blob/master/runtime/typescript/parity.json)。

新范围的记忆积累/使用默认关闭，旧 Go Memory 不自动导入。旧策略的拒绝、确认要求、未支持限制及恢复身份继续生效；新增连接不会自动扩大旧任务的执行权限。历史失败与 unknown 操作保留，不自动重放。保存的配置不代表连接成功或业务服务健康。

## 升级与回退

要求 macOS 13.5+ 与 Apple Silicon（M 系列）。沿用 Lake Local Development Code Signing 持久证书；尚未使用 Apple Developer ID 公证。

升级前结束当前操作并备份自己的 Lake Home。安装器正常退出旧后端，在准确生产 Home/data 以不启动任务的模式准备独立 TS 数据库；准备失败或新 UI 未在限定时间就绪时恢复旧应用。原 Go 数据库不改写，未知操作不重放。正式版与 Dev 的 Home、凭据和运行内核继续隔离。

需要回退时先正常停止当前内核，再使用备份的兼容旧应用；保留安全与历史操作记录，不混用 Dev 数据。TS 新会话不会反向同步到 Go；存在分支历史时应先核对，不能直接覆盖或盲目重迁。安全迁移已收尾的数据不能降到不支持该记录的版本。
