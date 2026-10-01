# 能力归属

| 能力 | 当前实现 |
|---|---|
| 湖、主机、数据库、Kubernetes、项目登记、历史数据 | LAKE TypeScript 数据层，保留 schema 19 |
| 运维审批、固定检查、运维工作流、计划授权、湖志 | LAKE TypeScript 运维服务 |
| Agent、历史会话、上下文压缩、代码工具、检查点、子 Agent | ZCode 原生 app-server |
| 文件索引、Git、持续本机/远程 PTY | ZCode 原生 services / remote |
| Skills、MCP、插件、Hook 信任、通用自动化 | ZCode 原生 bootstrap / adapters |
| 桌面交互、审批与结果展示 | 当前 LAKE React 前端 |
| 启动、签名、文件与媒体展示、显式旧 Keychain 迁移入口 | Go / macOS 原生边界 |
| 原生浏览器/CUA 的宿主交互 | 当前 Wails 前端尚未接入，调用明确返回不支持 |

通用能力的配置、连接器及平台要求沿用 ZCode。真实远端部署需要相应目标环境；回归测试使用合成数据和本地测试服务。
