# 长期专员管理验收

日期：2026-11-04，macOS arm64。功能源码 `19691440`；验收脚本补充提交 `f68981c0` 仅增加夹具 key 与模型输入断言，应用源码相同。分支 `codex/persistent-specialists`，PR 目标 `develop`；不包含合并或发布授权。

## 行为与边界

- Pilot 经官方 ADK 使用 `list_specialists` 分页读取项目内角色与职责，使用 `manage_specialist` 独立创建/编辑。创建立即建立持久角色频道，Task、Worker、Assignment、Security Task 与操作数量均不增加。
- 管理操作绑定宿主真实来源、已接纳用户事件、原文引用和幂等 part_key。重试返回原提交回执，不覆盖后来编辑。不同正文重放、过期 revision、跨项目、自动来源及 Worker 管理调用均拒绝。
- `route_work(role_id=...)` 复用稳定角色。改名不改变 role_key、RoleID 或频道。每项任务的 Task、Worker、ADK Session 与 RootTurn 独立；创建时冻结名称、职责和修订，编辑只影响后续任务。原任务账本、资源范围、权限和 Memory 门控保留。
- 专员提交后同步 Web 展示 Session，并发出持久 specialist 事件；侧栏监听 Router SSE 立即刷新，保留轮询恢复。投影失败不回滚已经提交的角色资料，后续查询可重建。
- schema4 → schema5 迁移前沿原路径生成私有一致快照，事务添加职责、Worker 角色快照与管理幂等账本；兼容 schema3 的逐步升级，未知版本拒绝。旧 reader 拒绝 schema5，不能直接降级旧二进制。

## 自动检查

| 检查 | 被测源码 | 结果 |
| --- | --- | --- |
| `go test ./... -json -count=1 -timeout=10m` | `19691440` | 2020项通过、15项跳过、0失败，15包完成 |
| `go test -race ./internal/ai ./internal/web ./internal/agent/storage -run 'TestSuper\|TestSpecialist' -json -count=1 -timeout=5m` | `19691440` | 100项通过、0失败 |
| `go vet ./...`、ADK运行边界检查 | `19691440` | 通过 |
| `python3 -m unittest discover -s scripts -p 'test_dev_*py'` | `19691440` | 16项通过 |
| Web 类型检查、`test:frontend`、Vite构建 | `19691440`，后续应用源码未变 | 580项通过、0失败，构建通过 |

详细机器记录见 `specialist-management/checks.json`。覆盖独立建角色、职责编辑、稳定身份、分页/同名独立、重启、旧库升级、项目和频道边界、职责冻结、官方 ADK 工具路径，以及原有 Super-agent 和 Security 回归。

## 签名 Dev 与原生演练

通过 `scripts/build_lake_desktop.sh --dev` 构建 Dev APP、ZIP/DMG；`codesign --verify --deep --strict` 通过。原生候选来源 `f68981c0`，构建清单的 dirty=true 来自当时未跟踪的验证截图；全部应用改动已提交，没有应用源码差异。前端使用 Node 24.14.0、pnpm 10.33.4。

普通安装流程 `scripts/build_lake_desktop.sh --dev --install` 被来源保护拒绝：当前已安装 Dev 来自 `e20ce338`，包含 `develop` 尚无的两条界面改动。没有删改清单、弱化保护或把无关提交夹入本 PR；改用本次签名候选 `dist/macos/0.3.27/arm64/dev/Lake Dev.app`，显式指定两个独立临时 Home 进行 CLI/原生演练。

两次演练均通过以下步骤：

1. Pilot 先列出、创建长期读取专员；零任务、零 Worker，侧栏出现唯一空闲频道。
2. Pilot 再列出并改名/保存职责，RoleID 与频道不变、roleRevision=2。
3. 显式 drain 后冷重启内核；唯一角色、职责、频道和空闲状态完整保留，PID 更换。
4. 向原角色派发 A/B 两项独立要求；仅一条专员导航，两个独立任务/执行上下文。实际模型输入含冻结职责，不含另一 Worker 的文件结果。
5. 沿项目原资源和原权限执行两个真实临时文件读取，没有 policy PUT；两次取证成功、四次原生问答协议确认/人工核实夹具、两个 canonical 目标 completed/pass，报告持久投递。人工答复仅限隔离夹具，不代表真实业务已获授权。
6. 原生窗口确认 DEV 标识、同一频道的两项记录；分别打开 A/B 执行详情，保持频道 URL 并显示各自真实步骤、原始问题和已验收状态。最后显式 drain 并停止夹具。

界面验证使用 ego-browser 技能，检查浅色/深色、900×720 窄窗、长职责省略、悬停/选中/焦点与空闲频道。窄窗 scrollWidth=900，无横向溢出；空闲状态无执行亮点或假任务。截图见 [浅色](specialist-management/idle-light.png)、[深色](specialist-management/idle-dark.png)、[深色窄窗](specialist-management/idle-dark-narrow.png)。

原 `~/.lake-dev` 在演练前后六张 canonical 表完整行摘要一致，schema 保持4；未复制/链接正式版凭据，未启动/安装/重启正式版。已恢复原先的已安装 Dev 窗口。

## 未验证项与回退

未覆盖真实供应商模型对任意自然语言的路由质量、Windows 原生 UI、断电/睡眠。未在当前固定 Dev Home 上执行 schema5 升级，也未覆盖安装现有 Dev；其来源保护限制已如实记录。完整内核的 Memory Worker 知识视图与运维 V2 仍未启用。

角色 metadata 不签发权限，不替代任务验收。回退需停止候选内核，恢复迁移前配套完整数据和旧 reader，或保留 schema5 兼容 reader 向前修复；不得直接以旧版本继续写 schema5。隔离验收 Home 已由夹具关闭并清理；当前已安装应用与原 Dev 数据保留。
