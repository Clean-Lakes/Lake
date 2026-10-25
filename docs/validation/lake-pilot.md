# Lake Pilot 首个工作切片验证

日期：2026-10-25。分支：`codex/lake-pilot-plan-20261025`。目标：`develop`。[草稿 PR #98](https://github.com/Clean-Lakes/Lake/pull/98)。

实际代码提交：`7dc7b083fed33a4d4d8d12e23363087c3c9d7e2d`。后续提交仅补充本文验证记录，不改变已测代码。当前仍是开发中的首个切片，不能视为完整方案验收或合并依据。

## 本地检查

环境：macOS arm64、Go 1.26.6、Node 24.19.0、pnpm 10.33.4。Node 使用 Codex 已有运行时路径；没有修改项目依赖。

| 命令或检查 | 结果 |
| --- | --- |
| `go test ./internal/ai ./internal/web -run 'TestPilot\|TestSRETaskStoreIdempotencyIsolationAndRollback\|TestSREFullRolesInheritNormalToolCatalogAndEnabledExtensions' -count=1` | 通过 |
| `go test -race ./internal/ai ./internal/web -run 'TestPilot' -count=1` | 最终代码通过，ai 1.783s / web 7.146s |
| `go test -race ./internal/ai ./internal/web -run 'TestPilot\|TestSRE\|TestADKSRERole\|TestPlanMode' -count=1` | 实现过程通过，ai 9.194s / web 76.653s；最终另补 Pilot race 回归 |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check` | 通过 |
| `pnpm --dir web-agent test:frontend` | 469 / 469 通过 |
| `pnpm --dir web-agent build:web` | 通过；已有单包大于 500 kB 提示 |
| `scripts/build_lake_desktop.sh --dev` | 最终代码签名构建成功，生成 Dev app、ZIP、DMG；未安装 |
| `codesign --verify --strict bin/lake` | 通过 |
| `git diff --check` / 方案结构、标识符唯一性检查 | 通过 |

### 完整 Go 测试的已有本地失败

`go test ./...` 在本机现有的 `internal/ai/output_recovery_test.go` 失败：`TestOutputLimitRetryUsesCompletedHistoryAndNeverRunsTruncatedCalls`，报告 `retry dropped completed work or used incomplete calls` 和 `incomplete history or cards survived recovery`。该测试文件被 `.gitignore` 的 `output*` 规则忽略，未跟踪，不能作为本 PR 文件提交或删除。

将未修改的 `origin/develop` 提交 `c8c91efaf0ab94ce2aa3a08a701d97bf04d99be3` 导出到独立临时目录，只加入同一个本地测试文件后运行此用例，复现同样的两个失败。没有更改该测试、放宽校验或把完整 Go 测试记为通过。基线临时结果位于 `lake-pilot-baseline-kwhjqrp4/local-regression-baseline-result.txt`。

## 执行与恢复行为

- `TestPilotGuidedAndAutomaticRunThroughRealRoleAndEvidence` 使用隔离本地模型协议夹具驱动原 ADK 专员，同时真实读取临时日志文件。guided 等待时没有资源操作和证据；提交所选操作后原专员继续，证据可通过原接口读取。automatic 没有选择等待，并取得同样的真实来源证据。
- `TestPilotChoiceSurvivesProcessCrash` 在原选择等待处实际中断子进程，重开存储后回复原 request；保留原 attempt，只执行一次真实读取。
- 设置测试覆盖一次性升级关闭、旧值迁移来源、重启不重置、部分字段更新、409 冲突、运行中主开关保护、未来任务策略快照，以及旧 SRE API 不覆盖自动推进。
- AI 策略测试覆盖未选择阻止调用、选项/依赖校验、重复决定幂等、实际依赖完成、参数精确匹配、attempt 隔离、无关任务 revision 不使选择失效、自动推进不提升角色权限、没有实际检查不能完成 observe。

这些是合成模型协议下的真实运行时测试，可以证明等待、派发与证据路径；不证明真实模型推荐方向的质量，也不替代真实故障恢复验收。

## 签名后端隔离冒烟

使用最终 `bin/lake`，显式 `web --home <临时独立目录> --port 0`，临时目录为 `lake-pilot-signed-qa-fgixymv1`。仅使用合成测试令牌，未配置模型、复制凭据或连接生产资源。

实际 HTTP 验证通过：bootstrap；新项目 `{enabled:false,autoAdvance:false,revision:0}`；分别保存主开关和子设置；过期 revision 返回 409；正常停止、重启同一隔离 Home 后保留 `{enabled:true,autoAdvance:true,revision:2}`。后端测试进程已停止。

## 界面组件检查

浏览器页面来自 `web/test/fixtures/lake-pilot.html`，挂载真实 React 组件和原 Lake CSS、湖生态头像。全部请求由夹具拦截；测试记录明确标注为隔离演示，不连接后端或真实资源。

- 初始主开关和子设置均关闭；浅色主开关灰色 `rgb(142,143,144)`，开启后为黑色 `rgb(26,28,31)`。使用文字按钮和 `aria-pressed`，没有滑动开关。
- 自动推进使用原菜单 checkbox 项，保存后主开关值保留；Esc 关闭菜单，焦点返回“Lake Pilot 设置”。
- 四个角色分别显示真实组件中的不同步骤导航和各自分母，复用原头像/消息头。
- 深色主题下检查 390px **内容列**，长命令局部横向滚动，内容列自身无溢出；展开/勾选时请求数为 0，提交选择后只有 1 次决定请求。夹具统计文本也已换行。
- 浏览器原生窗口/viewport 保持 1512px，尺寸仿真没有生效，因此上述窄列结果不能冒充 390px 整窗验收。完整窄窗口、输入法、焦点及长导航仍列为待验收。

![浅色真实组件：Lake Pilot 与自动推进菜单](lake-pilot-controls-light.png)

![深色真实组件：390px 内容列中的方向与命令](lake-pilot-choices-dark-column.png)

## Lake Dev 安装限制与待完成项

`scripts/dev_build_origin.py check` 阻止覆盖已安装 Lake Dev：现有 Dev 来源提交为 `0f1d0d87d59c`，来自另一个工作区，本分支不包含它。遵守来源保护，仅生成签名 Dev 包并使用隔离 CLI Home；没有安装或重启现有 Dev/正式版，没有绕过检查。

待完成：步骤局部“暂停并选择”；方向跨批次持续委托；执行员/验证员多阶段及结构化业务完成条件；真实模型方向质量；Lake Dev 真实故障、变更审批拒绝、独立复测恢复、重启与完整明暗/窄窗口验收。现有自动审批、资源范围、未知操作核实和原验收规则仍保留。

## 迁移与回退

同一 `sreProjectSettings` 增加字段，首次升级将旧 enabled 保存为 `legacyEnabled` 后关闭 Pilot。后续不覆盖明确保存值；旧 API 只改 enabled。历史任务不补造新的选择记录，后台保存工作流保留原自动运行路径。

开发回退前先停止任务并核实在途操作，保留当前数据库、ADK 存储及原账本。旧版本不具备恢复 Pilot 选择等待的能力，不能直接继续新 guided 任务或用旧快照覆盖后续资源效果。此 PR 尚未合并、发布或操作生产。
