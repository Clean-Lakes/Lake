---
goal: 准备并接入 100 个不同几何的长期专员头像
version: 1
date_created: 2026-11-04
last_updated: 2026-11-04
owner: Lake
status: 'In progress'
tags: [frontend, avatars, svg]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

将已交付的八种湖生态头像扩展为 100 个命名、可预览及可导出的本地 SVG 图形。不同头像必须具有不同几何，不能只改配色、朝向、标签或编号凑数；继续沿用 RoleID 稳定选择与既有轻动效。

## 1. Requirements & Constraints

- **REQ-001**: `lakeAvatarCatalog.ts` 恰好 100 个唯一 ID、中文名称和不同 SVG 几何；保留原八个形象。
- **REQ-002**: 从原八个生态族内按 RoleID 选具体图形，各入口一致，改名/换任务/重启不随机更换。扩容首次更新允许呈现同族新图形，之后固定目录顺序。
- **REQ-003**: 提供 100 图总览和包含 100 个独立 SVG 的文件包，导出与产品使用同一绘图源；保留浅/深色、闲时/工作/静止和减少动态效果。
- **REQ-004**: 所有头像在真实会话接单、思考、工具执行和流式回复时使用工作动作；侧栏与顶部同步当前来源，等待确认时静止；历史消息不跟随新回复工作。
- **SEC-001**: 只扩充显示资产，不更改项目资源、角色权限、任务、审批、验收或数据库。
- **CON-001**: 使用项目原有矢量绘图，不引入外部图片、生成模型或帧定时器。保留 20/22px 正常界面尺寸。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成目录、共享绘制、分配及导出，再验证交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 `web-agent/web/src/lakeAvatarCatalog.ts` 定义八族 100 个形象；`LakeAvatarFigure.tsx`、`AgentIcon.tsx` 共享绘制；`superAgentPresentation.ts` 在族内稳定选择，`specialistAvatars.css` 让新草木沿用轻摇。 | ✅ | 2026-11-04 |
| TASK-002 | `web-agent/scripts/export-specialist-avatars.tsx` 从相同绘图源生成 100 个 SVG、manifest 和离线总览；导出的离线 `index.html` 使用真实组件绘图总览，验证小尺寸及动效。依赖 TASK-001。 | ✅ | 2026-11-04 |
| TASK-003 | 更新前端身份/几何回归和说明；完成类型检查、完整前端测试、构建与浏览器视觉检查；在保留现有 Dev 候选的干净集成提交签名安装，记录 SHA 后更新原头像 PR。依赖 TASK-002。 | ✅ | 2026-11-04 |

| TASK-004 | `superAgentPresentation.ts` 统一真实回复活动；`App.tsx`、`PilotWorkspace.tsx`、`SpecialistChannel.tsx`、`ReplyIdentity.tsx`、`ReplyDuration.tsx`、`AIPanel.tsx` 接入会话动效。完成身份隔离、历史/等待回归与浏览器、Lake Dev 验证，更新 PR #175。依赖 TASK-003。 | | |

## 3. Alternatives

- **ALT-001**: 原八种图形换色或镜像凑 100 个不能满足不同图形要求，拒绝。
- **ALT-002**: 每次渲染随机分配会破坏身份，拒绝。
- **ALT-003**: 为静态头像新增远程图片生成和下载链路会偏离现有矢量资产体系，不采用。

## 4. Dependencies

- **DEP-001**: 既有 React、AgentIcon、RoleID、SVG 和 CSS 动效，无新依赖。

## 5. Files

- **FILE-001**: TASK-001 的绘图、目录、分配及 CSS 文件。
- **FILE-002**: TASK-002 的导出脚本和离线总览；`dist/specialist-avatars-100/` 为导出产物，不作为第二份绘图源。
- **FILE-003**: `web-agent/web/test/specialist-avatars.test.ts`、`super-agent-presentation.test.ts`、`docs/ui-guidelines.md`、`docs/lake-pilot.md` 与验证记录。

## 6. Testing

- **TEST-001**: 100 个 ID、名称和去掉根 SVG 元数据后的几何字符串均唯一；检查无 NaN、无外部图片及原尺寸。
- **TEST-002**: 确认 100 个图形都可由 RoleID 达到；同 ID 改名外观不变，各入口仍一致。
- **TEST-003**: 浏览器查看 100 图总览和小尺寸，检查浅/深色、窄窗、工作/静止及减少动态效果；归档恰含 100 个 SVG，离线总览无需网络。

## 7. Risks & Assumptions

- **RISK-001**: 22px 下复杂细节可能难辨，使用可读的轮廓及有限线条，并逐行检查总览。
- **RISK-002**: 导出和产品重复维护会分叉，导出直接使用同一目录和 AgentIcon renderer。
- **ASSUMPTION-001**: 用户要为 Lake 准备 100 个可用头像，沿用原动画和分配，不新增手动头像配置流程。

## 8. Related Specifications / Further Reading

- [首版头像](feature-specialist-avatars-1.md)
- [UI 规范](../docs/ui-guidelines.md)
- [开发规范](../CONTRIBUTING.md)
- [100 款验收](../docs/validation/lake-specialist-avatar-library.md)
- [头像 PR #175](https://github.com/Clean-Lakes/Lake/pull/175)
