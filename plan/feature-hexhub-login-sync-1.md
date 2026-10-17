---
goal: HexHub 导入同步本机登录信息并支持批量勾选
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [feature, import, hexhub]
---
# Introduction

![Status: In progress](https://img.shields.io/badge/status-Completed-green)

从 HexHub 导入时只读本机当前资产存储，按名称、目录、端点唯一匹配并保存凭据；预览支持全选与全不选。

## 1. Requirements & Constraints

- **REQ-001**: 保留 MCP 资产范围与不支持代理/隧道的校验，同步 SSH 用户名、密码、内嵌/引用私钥和口令，以及数据库/Redis 保存的登录信息。
- **REQ-002**: 全选只选无错误行；全不选清空，零选择禁用导入，忙碌时禁止更改。
- **REQ-003**: 导入可补齐已有缺少登录信息的 SSH、数据库和 Redis 连接，保留 ID、目录、会话历史；在线连接/项目 AI 运行时拒绝更新；完整连接跳过。
- **SEC-001**: 不读取 Keychain、Cookies、模型凭据或运行真实 SSH；不输出密码/私钥；本地存储只读、解析失败明确告知，凭据写入 Lake 私有文件，不推送。
- **CON-001**: 读取 active manifest、SST、WAL 最新版本与墓碑，限定 assets store，限制文件/记录大小和解析深度，不打开生产 LevelDB 或产生磁盘副本。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成自动同步及 UI 批量选择。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/hexhub_local_storage.go 只读当前表/日志与 V8；hexhub_local.go 解析和唯一匹配当前资产，凭据引用按 type 校验。 | Yes | 2026-10-13 |
| TASK-002 | resource_import.go 接入登录信息、缺失连接更新及空闲保护；ResourceImport.tsx 全选/全不选和同步结果。依赖 TASK-001。 | Yes | 2026-10-13 |
| TASK-003 | hexhub_local_test.go 验证删除/覆盖/损坏/凭据引用/泄漏/同步空闲检查；Web race、签名构建，更新 localhost:4180 并验证真实预览不提交。依赖 TASK-002。 | Yes | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: MCP 不提供登录凭据，因此仅用于授权资产范围；不通过模型推测凭据。
- **ALT-002**: 原生备份接口会写入且格式另有加密，选择当前 IndexedDB 资产快照。

## 4. Dependencies

- **DEP-001**: goleveldb table/journal 只读解析与 snappy，现有字段级 AES 解码和私有文件凭据流程。

## 5. Files

- **FILE-001**: internal/web/hexhub_local_storage.go、hexhub_local.go、hexhub_local_test.go、resource_import.go、hexhub_mcp.go、server.go。
- **FILE-002**: web-agent/web/src/ResourceImport.tsx、styles.css、api.ts、web-agent/shared/contracts.ts。

## 6. Testing

- **TEST-001**: 合成当前 manifest/SST/WAL 数据，覆盖旧版本/墓碑/无效加密/引用缺失/重复匹配/损坏校验。
- **TEST-002**: HTTP 测试补齐连接但保留 ID，活动终端/AI 拒绝；预览与计划不泄漏秘密；真实本机只读统计及浏览器批量勾选。

## 7. Risks & Assumptions

- **RISK-001**: HexHub 存储升级或多个人资料可能不兼容，明确降级为清单并提示，禁止凭据猜测匹配。
- **ASSUMPTION-001**: 自动同步指本次导入操作读取当前保存的登录信息，非持续后台监控或覆盖完整已配置连接。

## 8. Related Specifications / Further Reading

[终端配置编辑](feature-terminal-config-edit-1.md)
[Chromium IndexedDB](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/indexeddb/docs/idb_data_path.md)
