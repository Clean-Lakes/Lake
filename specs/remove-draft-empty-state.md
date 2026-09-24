# 草稿态不再渲染问候语与 Logo 空态

状态：本地定制（相对上游 ZCode 的有意偏离）
影响面：`packages/ui`（Desktop / Web / 手机远控共用）

## 产品规则

草稿态（未打开项目、也还没有会话内容）不再显示"时间问候语 + ZCode Logo"这一整块空态。
草稿区因此只剩输入区与其下方的建议提示，界面不再出现 ZCode 品牌标识与问候文案。

## 状态与所有者

- 本次不引入任何状态，也不改变任何状态所有者。
- 被移除的是纯展示组件 `packages/ui/src/v4/ConversationDraftEmptyState.tsx`（问候语分档、字号自适应、Logo 三段渲染都在该文件内，无对外状态）。
- 唯一挂载点：`packages/ui/src/v4/SessionPane.tsx` 传给 `ConversationTimeline` 的 `emptyState`。该 prop 现在恒为 `null`，与"非草稿态"路径同值，因此下游 `ConversationTimeline` 不需要任何改动。
- `centerEmptyStateWithDock={isDraft}` 保持原样：输入区在草稿态的垂直位置与改动前一致，避免"去掉问候"顺带改变输入区布局。

## 接口影响

- 删除导出 `ConversationDraftEmptyState`，仓库内无其他引用（手机远控此前复用的也是同一个挂载点）。
- 删除随之失去引用的资源 `packages/ui/src/assets/Z.svg`。
- i18n key `chat.empty.greeting.*` 与 `chat.empty.greeting.office` 暂不删除：它们只是文案数据，删除会牵动两份 locale 文件，且对行为无影响。
- `@zcode/shared` 的 `TID_CHAT_EMPTY` 常量保留导出，但不再出现在 DOM 中；仓库内没有测试依赖该 testid。

## 验收场景

1. 打开客户端、不选择项目：草稿区不再出现 `[data-v4-draft-greeting]` 与 `[data-v4-draft-logo]`，也不再有 `chat-empty` testid 节点。
2. 同一视图下输入区仍可见可用，"选择项目"、"向 ZCode 提问" 等占位与建议提示不变。
3. 非草稿态（已有会话）行为不变。

## 不覆盖 / 后续注意

- 不改输入区、建议提示、插件流程等相邻组件。
- 同步上游时注意：本次是"删除文件 + 改一处 prop"，上游若修改 `ConversationDraftEmptyState.tsx` 或该 `emptyState` 挂载点会直接冲突，需人工决定取舍。
