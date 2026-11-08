# 专员活动反馈时机验证

日期：2026-11-05（Asia/Shanghai）。功能提交：`3f0ff89690461f1aedd6d0c9808bf7f3ddda781e`，基于 `origin/develop@caab241e89bc93f38e6395b69f3e85a285637296`。

## 行为与边界

此前侧栏 `running` 只统计持有有效执行租约且目标处于运行状态的 Worker。接单、排队，以及目标仍受阻但实际正在接收新回复的阶段没有转圈；路由决策也没有独立通知侧栏，要等待 Router 后续输出或 2.5 秒轮询。

新增可选的 `preparing` 展示字段，读取准确项目、RoleID、频道来源和待派发记录，不受最近 100 个任务预览限制。角色输入接纳、已提交的新派发及待派发续办立即显示转圈，提示“准备处理”；真实执行或模型回复时提示“执行中”。后台 Worker 的回复活动独立于目标业务状态投影，不因目标仍为 blocked 而遗漏。

已提交派发、角色输入接纳、Worker 开始/确认/结束及频道停止会发出原有的 durable specialist 通知。通知失败不回滚已接纳工作，轮询仍提供恢复；流式文字分块不反复刷新整个工作区。普通 Pilot 输入在角色尚未确定时不猜测或点亮专员。

准备状态不是执行许可。路由失败、取消和结束后的旧收件记录不单独维持忙碌；等待用户保留确认提示。任务、操作、审批、权限、用量和验收的原状态不变，不增加模型或工具循环，无数据迁移。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| 专员/路由相关 Go race | `go test -race ./internal/ai ./internal/web -run 'TestSuper\|TestSpecialist' -count=1 -timeout=15m` 通过：AI 70.384s，Web 24.232s |
| 完整 AI race | 通过，451.960s |
| 完整 Web race | 全部 535 个注册测试方法分三批通过：180 / 180 / 175，分别 297.242s / 385.472s / 342.060s |
| `go vet ./internal/ai ./internal/web` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| 前端类型检查、测试、生产构建 | 源分支通过，589/589；Dev 集成通过，605/605；保留既有 bundle 大体积提示 |
| `git diff --check` | 通过 |

回归覆盖：派发提交后、尚未取得租约或调用模型前即可读到 preparation；通知失败不回滚派发；真实续办和保留的 blocked 输入区分；精确频道/项目归属；实际消息与 canonical 目标不被提升；Worker 状态即时通知仅发给所属 Pilot，文字分块不制造通知风暴；准备、执行、等待确认和完成的界面切换。

首次完整 Web race 命令达到默认 10 分钟的包级总时限，当时执行到 `TestSREFullAgentContinuesBeyondOldUsageToolAndRoundLimits`（该用例仅运行了 5 秒），未出现断言失败。该用例单独复测通过，25.414 秒。随后保持所有测试，用 `go test ./internal/web -list '^Test'` 的实际注册顺序拆成 180 / 180 / 175 个测试方法三批，均使用 `-race -count=1 -timeout=20m`。拆批仅调整测试进程的总时限，不修改产品或任何测试内时限。

复现分批方式：

```python
import subprocess
listing = subprocess.check_output(['go', 'test', './internal/web', '-list', '^Test'], text=True)
names = [line for line in listing.splitlines() if line.startswith('Test')]
for start in range(0, len(names), 180):
    pattern = '^(' + '|'.join(names[start:start + 180]) + ')$'
    subprocess.run(['go', 'test', '-race', './internal/web', '-run', pattern,
                    '-count=1', '-timeout=20m'], check=True)
```

## 界面与 Lake Dev

合成夹具 `web-agent/web/test/fixtures/specialist-activity.html` 使用真实 `usePilotWorkspace`、EventSource 通知路径和侧栏组件，接口返回本地虚构数据，不连接模型或资源。一次本机采样中，接单按钮触发通知到 DOM 出现转圈为 12.5ms；这是本地呈现测量，不包含 Router 识别或模型响应时间。准备/执行标签、需确认停止转圈、完成显示绿色未读均通过；减少动态效果时动画为 none。

截图：[接单转圈](lake-specialist-activity-preparing.png)。窄屏夹具显式使用 sidebar-open，避免实际应用的抽屉隐藏规则遮住测试导航；本轮不把首次被隐藏的窄屏截图计为通过证据。

使用 Node 24.14 和签名的 `scripts/build_lake_desktop.sh --dev --install` 构建并安装。Lake Dev 集成 SHA 为 `26cd60e07a84c819881b2f4614b51bdac272b1f3`，保留已有头像、浮标、会话比例和其他 Dev 候选。集成分支的头像接口在 preparing 阶段同样采用 working 动作；本 PR 不引入 develop 基线中尚无的头像接口。

实际打开 `~/Applications/Lake Dev.app`，在原项目的 Pilot 和专员历史间导航，检查浅色/系统深色侧栏的身份、截断与状态位置，随后恢复“跟随系统”。没有发送新的模型任务或资源操作；原生验证不冒充重新执行旧数据库比较任务。`codesign --verify --deep --strict` 通过，运行后端及服务中的 Web 资源与安装构建一致，见[安装校验](lake-specialist-activity-installed.json)。

安装前后核对 messages、superagentInputs、native_operations、native_approvals、superagent_decisions、superagent_events 六张表的规范化指纹，全部一致。未访问或重启正式版 Lake。

## 回退与未验证项

兼容旧客户端忽略 preparing、旧服务不提供该字段；无迁移，回退 UI/状态投影提交并重新签名构建 Dev 即可，不改动会话与操作账本。Windows 原生未验证，原生窄栏和真实模型派发时延未作本轮测量。

[PR #181](https://github.com/Clean-Lakes/Lake/pull/181) 目标为 develop，未授权合并或生产发布。功能提交后的材料提交不改应用源码。
