---
goal: 修复本机状态查询的目标误判与模型空转
version: 1
date_created: 2026-10-09
last_updated: 2026-10-09
owner: Lake
status: 'Completed'
tags: [agent, latency, tools, cli]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

用户会话 0e59c031-6d92-5563-b36f-b920c81073ff 历时约140秒、14次模型调用、零实际行动。缺少 Power/profile 清单导致虚构ID反复失败；本机状态误解为项目文件调查。用户已明确目标为当前 Mac。

## 1. Requirements & Constraints

- **REQ-001**: 提供固定的本机 CPU、内存、磁盘、负载与运行时间读探针，使用已有本地资源授权与证据路径。
- **REQ-002**: 主会话可直接执行简单只读检查，专员初始化即获得与工单资源匹配的 Powers；上下文提供准确能力和profile清单。
- **REQ-003**: 参数schema限制Power/profile ID；目标不明时请求输入，避免猜终端与空转。
- **REQ-004**: CLI显示模型/专员活动及经过时间，模型正文使用用户语言；status直查保持零模型调用且持久验收。
- **SEC-001**: 无任意shell、进程argv、环境变量、凭据读取或新的资源授权；秘密不进入记录。
- **CON-001**: 保持复杂任务的多专员、授权、锁和验收门；macOS只能规定脚本签名构建。

## 2. Implementation Steps

- **GOAL-001**: 简单本机查询以真实读行动交付，能力发现与等待不消耗猜测轮次。

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | 新增固定本机状态adapter与local-files读能力，接入gateway验证和来源证据。 | Yes | 2026-10-09 |
| TASK-002 | 明确Powers/profiles元数据与枚举，自动初始化兼容能力，开放主会话只读工具。 | Yes | 2026-10-09 |
| TASK-003 | 新增等待用户信息工具，优化提示与CLI活动耗时；显示资源范围。 | Yes | 2026-10-09 |
| TASK-004 | 真实本机探针、能力安全边界和确定性Agent闭环测试；签名构建与DS端到端测试。 | Yes | 2026-10-09 |

## 3. Alternatives

- **ALT-001**: 不以更换Flash掩盖空转；保留用户Pro默认，首先修正工具协议和任务范围。
- **ALT-002**: 不加入通用exec或猜测注册远端服务器。

## 4. Dependencies

- **DEP-001**: Node24内置os/fs接口与现有Power、gateway、SQLite、CLI。

## 5. Files

- **FILE-001**: adapters/host-status.ts、builtin/powers/local-files.json、app/application.ts、builtin/prompts、domain/events.ts、surfaces/cli-chat.ts及测试。

## 6. Testing

- **TEST-001**: 真实本机状态数值、CPU采样与磁盘来源；未授权/跨资源读拒绝。
- **TEST-002**: 第一次模型请求已有合法能力、enum和profile；主会话只读两轮完成且不spawn；专员保留授权校验。
- **TEST-003**: 用户问题一次调用进入等待，后续输入可恢复；CLI活动显示不含隐藏思考。
- **TEST-004**: 既有集成与业务验收、签名分发；DS真实本机状态查询记录耗时与调用数。

验证：check通过；单元7/7、集成51/51、业务验收13/13；DS Pro本机查询4.189秒/2轮、模糊目标8.724秒/1轮请求输入；签名status冷启动2.785秒、后台就绪1.263秒，检查分别186/166ms，零模型。详见 [验证记录](../docs/validation/lake-ts-agent-v0.0.1.md)。

## 7. Risks & Assumptions

- **RISK-001**: OS空闲内存口径随平台变化，报告明确口径，不仅凭空闲量判定内存压力。
- **ASSUMPTION-001**: 用户授权对当前Mac进行只读状态检查；不切换默认模型或读取生产目标。

## 8. Related Specifications / Further Reading

[CLI](../docs/lake-cli-compatibility.md) · [v0.0.1](architecture-lake-ts-agent-v0.0.1.md)
