# 长期专员头像与动效验收

日期：2026-11-04。功能代码 SHA：`d0b0b97ae309d0aa9b286232cba0bebfada073e5`，基于 `origin/develop` 的 `caab241e89bc93f38e6395b69f3e85a285637296`。后续提交仅更新计划和验证记录。

## 行为

专员原来按名称关键词匹配调查、执行或复核图形，未匹配的名称全部显示同一只鹭鸟。现在共享 AgentIcon 提供鹭鸟、水獭、龟、翠鸟、蜻蜓、鸭、鱼及莲花八种本地矢量形象，用准确 RoleID 组合形象、四档主题配色、朝向和水纹细节。有限形象库允许同物种重复，不承诺无限唯一图形。

新建且没有任务的专员立即有头像；改名、换任务和重启保持同一 RoleID 的外观。侧栏、顶部、任务检查及 Pilot 报告都传递该身份。报告作者新增可选 `roleId`，仅由既有 Worker/outbox 关联投影；旧客户端可忽略，旧服务缺字段时新客户端按名称种子兼容。不迁移数据库，不新增头像配置流程、外部图片请求或帧定时器。

闲时轻眨眼或轻摇莲叶；真实运行才增加小幅身体、翼肢和水纹动作，暂停、停止、失败和受阻时静止。历史报告不会跟随当前任务一起做工作动作。页面隐藏冻结当前相位，系统减少动态效果时取消动画。沿用原 20/22px 尺寸、状态标记和确认入口；头像不修改任务、权限、审批或验收。

## 源分支检查

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/web -count=1` | 完整包通过，244.711 秒 |
| 报告身份与频道来源 race | Web 通过，4.221 秒；同次命令的 AI 包没有匹配测试，不将其计作 AI 回归覆盖 |
| `go vet ./internal/ai ./internal/web` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | 通过，590/590 |
| `pnpm --dir web-agent build:web` | 通过，保留既有 chunk 大小提示 |
| `git diff --check`、实施计划结构和唯一声明 ID | 通过 |

相关 race 命令：

```sh
go test -race ./internal/ai ./internal/web -run 'TestSuperReportsProjectOriginalSpecialistIdentity|TestSuperChannelProjection' -count=1
```

回归覆盖同 RoleID 改名/换任务外观不变、尚无任务的角色立即展示、多个 ID 分散到八种图形、导航/报告/任务详情身份一致，以及原验收和状态语义。报告来源测试确认 RoleID 来自准确 Worker，而非正文或当前选择。

## 浏览器界面检查

使用 `ego-browser` 打开独立 Vite 夹具 `web-agent/web/test/fixtures/specialist-avatars.html`，仅渲染真实共享组件，不连接模型或项目资源。1360px 与 520px、浅色与深色截图均已检查：八种形象可区分，窄窗头像不被裁切，无文档水平溢出；选中角色与标题的头像配色一致。

通过实际 CSS transform 随时间变化确认工作动作；暂停状态的头像动画数为 0，模拟系统减少动态效果后动画数同样为 0。新建预览专员立即有头像和“暂无任务”，没有执行转圈。

该浏览器环境切换受控页面时 `document.hidden` 仍为 false，因此隐藏路径通过隔离夹具模拟 `visibilitychange` 验证：所有头像带冻结标记、眼睛动画暂停，恢复后解除。此结果不等同于已测试所有平台原生最小化行为。浏览器空间和专用 Vite 进程已关闭；工具提示有可用更新，本次未升级。

## Lake Dev

macOS arm64 最终干净集成 SHA：`e50e700e01134fade2bcdb797eff582fab53fe59`。通过 `scripts/build_lake_desktop.sh --dev --install` 签名构建安装，先在 Dev 原生菜单“停止内核并退出”，再启动 `~/Applications/Lake Dev.app`。后端来自新安装目录，Home 为独立 `~/.lake-dev`。

保留此前 Dev 候选，包括普通任务自动推进、权限继承、专员删除、任务资源解耦及报告尾注移除。集成 #171 时发现派单的 @专员 小头像仍只传名称，已在该 PR 以 `5c0f4081ba3fa2bcc4c680f988f0c725ce5f7ec4` 补充准确 RoleID，并通过其独立类型检查与 589/589 前端测试；该派单改动不混入本头像 PR 的 diff。两者在共享头像参数处的合并保留了实际 RoleID 与动效实现。

集成检查：相关 Web race 7.768 秒通过，最终类型检查和前端 591/591 通过，最终签名桌面构建成功。原生深色工作台显示现有四位专员分别为龟、鹭鸟、翠鸟和鸭，发布专员顶部与侧栏一致，原名称、任务、资源目录及状态保留。浅/深色与窄窗口的详细形态检查在上述浏览器夹具完成，未修改用户的实际 Dev 主题或窗口尺寸。

只读核验确认：32 条 Pilot 专员报告的作者 RoleID 与原 Worker 完全一致；4 个频道中的 49 条旧报告仍显示原正文。安装前后消息、任务输入、原操作、审批、决策和事件账本的逐表指纹一致。原 14 条 Pilot 派单及 2 条数据库专员派单无重复；Pilot 权限及当前项目的全局 MCP 继承保留。

本次未执行真实模型任务、MCP 查询或数据库操作，未进行 Windows 原生验证。回退代码恢复原名称匹配头像，不需要回滚数据。普通 PR 目标为 `develop`，未自动合并或发布。
