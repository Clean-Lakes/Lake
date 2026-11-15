# 专员身份与思考气泡合体验证

按用户截图反馈，将 Pilot 实时专员的身份入口和思考状态合成同一个细边框容器：名称、真实 Agent Logo、入口箭头和思考文案在框内，上边框只保留一只 28px 角色。去掉容器外的重复头像、署名及头像列占位。

## 候选与范围

- 开发基线：`f566a29b84ae86333060ab073e5bce6ec935ef2f`（develop）。
- 实际测试和 Lake Dev 安装源码：`bea87c89094abf8c07d56e97c7094a8e7a1f3b3b`，构建来源 `dirty=false`。
- 分支：`codex/unified-thinking-reply`；普通 PR 目标 `develop`。
- 测试平台：macOS Apple Silicon，签名 Lake Dev 0.3.33 / TypeScript 后端；浏览器补充 Chromium 390px 窄窗口。
- 仅改前端展示与身份入口焦点衔接。专员/Worker/task/SDK root 绑定、路由、权限、持久数据和后台执行逻辑保持原有合同。

## 自动与浏览器验证

| 项目 | 命令或操作 | 结果 |
| --- | --- | --- |
| 前端回归 | 固定 Node 24.14.0，`pnpm --dir web-agent test:frontend` | 866/866 通过；本轮新增 9 项 |
| 类型与 Web 构建 | `pnpm --dir web-agent check`、`pnpm --dir web-agent build:web` | 通过；保留既有大 chunk 提示 |
| 边界检查 | `python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_backend_naming.py` | 通过 |
| 差异检查 | `git diff --check` | 通过 |
| 明暗与窄窗口 | 真实 `PilotSpecialistReplyView` fixture，普通名称/长名称，浅色 hover、深色 390px keyboard focus | 单框、单角色，完整名称可折行，Logo/箭头不被压缩，无横向溢出 |
| 键盘和状态转换 | 原生按钮 Enter 打开准确 role；保持入口焦点并切换思考→正文→思考；主动点击其他控件 | 双向转换保留入口焦点，主动移焦不被覆盖 |
| 动画稳定性 | 无关快照更新、减少动态效果 | 保留角色 DOM 与原 WAAPI 对象；减少动态效果时动画数量为 0 |
| 独立复核 | 只读检查展示、身份、状态及生命周期 | 发现并修复跨容器切换失焦，修复复核通过 |

新增回归覆盖单容器/单角色、原生及 Codex 真实品牌、入口准确回调、live region 与按钮隔离，以及焦点迁移、普通更新、主动移焦、换 Worker/task、入口移除和 DOM 复用。保留原工具、等待、离线、完成、真实正文与 SDK root 相关回归。

## 已安装 Lake Dev 验证

先在日常 Lake Dev 选择“停止内核并退出”，确认 runtime 退出，再通过以下签名入口构建安装：

```sh
npm_config_offline=true scripts/build_lake_desktop.sh --dev --install
node scripts/verify_animal_thinking_dev.cjs /tmp/lake-unified-thinking-native.json
```

离线选项只使用已有完整依赖缓存，仍执行固定依赖安装、构建、来源检查和签名。安装到 `~/Applications/Lake Dev.app`。

复用已提交的本地模型验收脚本启动临时独立 Home/data，不连接业务资源。水獭和猫头鹰使用真实 Worker、SSE 与 Pilot 主对话：

1. 明暗主题下，两个专员都只有同框的身份/状态和一只上边框角色；左右落脚与细边圆角可见且没有裁切。
2. 点击框内猫头鹰名称，进入准确猫头鹰专员任务页，任务记录为 1；返回 Pilot 后保持独立实时回复。
3. 本地模型保持响应打开，水獭实际公开正文到达后恢复原身份头和连续正文，思考框收起；另一位猫头鹰继续思考。读取当前 Worker 快照确认 `replyStatus=running`、正文卡 `running`、241 字符，且卡片 root 与当前 SDK root 一致，见 [stream-check.json](unified-thinking-reply/stream-check.json)。
4. 完成两个 Worker 后，正式报告接替实时发言，思考框和边框动画均无残留。
5. 完成 fixture 并停止对应隔离原生/后端进程；重新打开日常 Lake Dev，恢复“跟随系统”主题、原 HexHub 服务器项目和原 Pilot 会话。临时 Vite 已关闭。

## 截图

- [浅色原生合体布局](unified-thinking-reply/native-light.png)
- [深色原生合体布局](unified-thinking-reply/native-dark.png)
- [真实流式正文与另一位独立思考](unified-thinking-reply/native-stream.png)
- [完成后的正式报告](unified-thinking-reply/native-complete.png)
- [浅色 hover](unified-thinking-reply/fixture-light.png)
- [390px 深色长名称与键盘焦点](unified-thinking-reply/fixture-dark-390.png)

## 限制与回退

Windows/Linux 原生客户端未运行；390px 极窄布局在 Chromium fixture 验证。真实运行使用确定性本地模型，不声称完成真实业务资源验收。无数据库迁移或权限变更，可经新的回退 PR 恢复本次前端改动。本验证不授权合并、生产发布或正式版安装。
