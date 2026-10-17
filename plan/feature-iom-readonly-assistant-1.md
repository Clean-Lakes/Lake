---
goal: 将 Lake 对话引擎接入 IOM 原生只读运维助手
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
owner: Lake / IOM
status: In progress
tags: [feature, integration, iom]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户选择 IOM 内置助手，复用项目、资产、告警；当前 IOM 无统一登录和项目权限，用户明确选择先只读，权限层完成后再开放执行。IOM 源码位于 `/Users/lingyunxieqing/Desktop/iom-systemmonitoring-product`。复用 Lake Go 引擎，新增 Vue 页面与已有 `iom-sre-agent` HTTP 接口，原有 Eino 巡检/诊断保留。

## 1. Requirements & Constraints

- **REQ-001**: 原生 Vue 助手按平台数据源和项目创建持久会话，流式显示回答、工具证据和结束状态，支持取消与重启恢复。
- **REQ-002**: 模型配置复用 IOM SRE 服务已有配置；客户端只能提交文本和资源引用，不能提交模型密钥、工具定义、系统提示或权限。
- **SEC-001**: Lake 提供仅宿主注册工具的独立引擎模式，拒绝内置 shell、文件、SSH、SQL、导入及委派工具；宿主只调用固定 GET API。
- **SEC-002**: 项目范围由服务端固定在会话，资源从项目端点关联及 systemId 解析；每次工具调用重新校验归属，告警/日志校验项目。项目范围不是用户权限；本版不声明用户隔离。
- **SEC-003**: 密钥不进入输出、日志或会话元数据；工具结果有大小限制并脱敏；客户端不接收真实凭据。
- **CON-001**: 保留两个仓库既有未提交改动；macOS 用户 `bin/lake` 只能用签名脚本生成。
- **PAT-001**: 经现有 `/sre-agent/` 同源反代接入，使用 `{data: ...}` 成功信封和 `{code,message}` 错误形状。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 提供安全的宿主只读引擎 API。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 Lake `internal/ai/hosted.go` 实现宿主工具目录与调用隔离，在 `pkg/agent/readonly.go` 提供 Configure/Chat/Snapshot/History/Abort/Close；更新 `engine.go`、`catalog.go`、`tools.go` 的 hosted 分支。 | | |
| TASK-002 | 为宿主白名单、参数校验、禁止原生执行、流式工具调用、落盘恢复和密钥脱敏编写测试。依赖 TASK-001。 | | |

### Implementation Phase 2

- **GOAL-002**: 接入 IOM 项目范围与原生页面。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 在 IOM `iom-sre-agent/internal/sreagent/assistant*.go` 新增助手会话 API、元数据落盘、固定 GET 工具和 SSE；接入 Service 生命周期和 RegisterRoutes。依赖 TASK-001。 | | |
| TASK-004 | 在 IOM `web/src/api/core/assistant.ts` 和 `web/src/views/sre-agent/assistant.vue` 新增流式客户端、项目与资源选择、历史恢复、停止及工具证据展示；在 sre-agent 路由新增入口。依赖 TASK-003。 | | |
| TASK-005 | 更新 IOM SRE Go 依赖和 Docker 构建上下文，文档明确 Lake 源码依赖、只读边界和未实现用户权限。依赖 TASK-003。 | | |
| TASK-006 | 运行 Lake hosted 测试、IOM SRE 回归、Vue 类型检查与前端测试；用合成 IOM/模型服务验证完整调用，不执行生产变更。依赖 TASK-002、TASK-004、TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: iframe 嵌入 Lake 本机工作台：其启动令牌和本机执行范围与 IOM 原生项目数据不匹配。
- **ALT-002**: 复制引擎源码到 IOM：形成两套实现；选择独立公开宿主 API 和构建时源码上下文。

## 4. Dependencies

- **DEP-001**: IOM 已有 `iom-sre-agent` Go 服务、数据源配置、LLM 配置与同源反代。
- **DEP-002**: Lake 源码 checkout；本地 Go replace 和 Docker named context 均引用同一源码，发布镜像无需源码。

## 5. Files

- **FILE-001**: Lake `internal/ai/{hosted,engine,catalog,tools}.go`、`pkg/agent/readonly.go` 及相关测试。
- **FILE-002**: IOM `iom-sre-agent/internal/sreagent/assistant*.go`、`service.go`、`handlers.go`、`cmd/iom-sre-agent/main.go`。
- **FILE-003**: IOM `web/src/api/core/assistant.ts`、`web/src/views/sre-agent/assistant.vue`、`web/src/router/routes/modules/sre-agent.ts`。
- **FILE-004**: IOM `iom-sre-agent/{go.mod,go.sum,Dockerfile,README.md}`、`docker-compose.yml`。

## 6. Testing

- **TEST-001**: 合成模型提出 shell/文件/未知工具或越项目目标均被拒绝，平台 mock 只收到固定 GET 请求。
- **TEST-002**: 流式多轮工具调用、停止、同会话并发冲突、刷新与重启恢复；配置/工具输出中的合成密钥不出现在客户端和会话文件。
- **TEST-003**: 现有 SRE 服务测试通过，Vue 类型检查和助手状态测试通过。

## 7. Risks & Assumptions

- **RISK-001**: IOM 没有统一鉴权；会话是现有控制台访问范围内的共享数据，不能宣称按用户隔离。执行功能不实现。
- **RISK-002**: 源码构建需同时获得两个 checkout；Docker 使用额外 Lake 上下文，离线分发使用已构建镜像。
- **ASSUMPTION-001**: 平台数据源由现有 SRE 配置选择；本版不新建用户体系或修改生产部署。

## 8. Related Specifications / Further Reading

- [Lake 当前后端](../web-agent/README.md)
- [IOM 已有 SRE 服务](/Users/lingyunxieqing/Desktop/iom-systemmonitoring-product/iom-sre-agent/README.md)
