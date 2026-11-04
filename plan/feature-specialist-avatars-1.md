---
goal: 为长期专员提供稳定且有轻动效的湖生态头像
version: 1
date_created: 2026-11-04
last_updated: 2026-11-04
owner: Lake
status: 'Completed'
tags: [frontend, specialists, animation]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

专员原来只按名称关键词落到少数几个头像，多数自定义名称都显示鹭鸟。扩充共享湖生态矢量形象，以准确 RoleID 确定图形、配色和细节；闲时眨眼，真实执行时轻动，暂停和减少动态效果时静止。

## 1. Requirements & Constraints

- **REQ-001**: 新建且尚无任务的专员立即具有头像；同一 RoleID 在改名、换任务、重启和各显示入口保持外观一致。
- **REQ-002**: 使用八种湖生态形象及配色/细节组合，有限形象库允许同物种重复，不再把所有未匹配名称设为调查鹭鸟。
- **REQ-003**: 闲时轻眨眼；实际运行才启用工作动作，暂停/停止为静态；隐藏页面冻结动画，减少动态效果时取消动画。
- **SEC-001**: 头像只表示外观，不能修改角色、任务、权限、审批或验收。报告 RoleID 从原 Worker/outbox 关联投影，不能由正文推断。
- **CON-001**: 不迁移数据库，不添加头像设置流程，不引入图片网络请求、帧定时器或另一个运行状态权威；保留现有尺寸、独立状态标记和无底板头像。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成共享头像、身份与状态接线，再验证各入口。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `AgentIcon.tsx` 扩充湖生态 SVG，`superAgentPresentation.ts` 用 RoleID 计算稳定形象组合；`SuperRoleAvatar.tsx` 和独立 CSS 实现可冻结的轻动效。 | ✅ | 2026-11-04 |
| TASK-002 | 在 `PilotWorkspace.tsx`、`App.tsx`、`ReplyIdentity.tsx`、`SuperTaskInspector.tsx` 传递同一 RoleID 和真实运行状态；`superagent_reply_authors.go`、共享 contracts 补充只读 RoleID 投影。依赖 TASK-001。 | ✅ | 2026-11-04 |
| TASK-003 | 补充身份/状态回归和浏览器夹具，验证明暗、窄窗、静止/运行、减少动态效果及隐藏；签名安装保留此前候选的 Lake Dev，记录实际 SHA，提交独立 develop PR。依赖 TASK-002。 | ✅ | 2026-11-04 |

## 3. Alternatives

- **ALT-001**: 随机每次渲染会让轮询、切换会话和重启更换身份，拒绝。
- **ALT-002**: 按当前任务标题或角色名称分配会随任务/改名漂移，仅在缺少 RoleID 的旧兼容输入中使用名称种子。
- **ALT-003**: 为外观增加新数据库权威或模型生成图片流程超出本次需求；使用共享本地 SVG 和稳定种子。

## 4. Dependencies

- **DEP-001**: 现有 React、AgentIcon、Super-agent RoleID 与原状态投影，不增加依赖。

## 5. Files

- **FILE-001**: `web-agent/web/src/AgentIcon.tsx`、`SuperRoleAvatar.tsx`、`superAgentPresentation.ts` 及头像 CSS。
- **FILE-002**: TASK-002 的入口、`web-agent/shared/contracts.ts`、`internal/ai/superagent_reply_authors.go` 和相关测试。
- **FILE-003**: `web-agent/web/test/fixtures/`、前端回归、`docs/ui-guidelines.md`、`docs/lake-pilot.md` 与 Dev 验证记录。

## 6. Testing

- **TEST-001**: 相同 ID 改名/换任务外观不变；多个不同 ID 得到多种图形；无任务专员、报告和导航使用同一身份。
- **TEST-002**: 真正运行、待确认、暂停、完成的动效不混淆；原状态点、名称、导航与任务验收保持。
- **TEST-003**: 前端类型与完整测试、相关 Go/race/vet；在真实浏览器检查动画变化、暂停、隐藏、减少动态效果以及明暗窄窗的裁切/焦点。

## 7. Risks & Assumptions

- **RISK-001**: 过强动效会分散注意力，限制到眼睛及小幅局部动作，不旋转整只头像或添加背景光圈。
- **RISK-002**: 历史报告未包含 RoleID，宿主从持久来源补充；旧服务缺字段仍可按名称显示本地图形。
- **ASSUMPTION-001**: 用户需要自动区分头像，不要求本次增加手动头像编辑器或无限唯一物种。

## 8. Related Specifications / Further Reading

- [UI 规范](../docs/ui-guidelines.md)
- [长期专员](../docs/lake-pilot.md)
- [开发规范](../CONTRIBUTING.md)
- [验证记录](../docs/validation/lake-specialist-avatars.md)
- [头像 PR #175](https://github.com/Clean-Lakes/Lake/pull/175)
