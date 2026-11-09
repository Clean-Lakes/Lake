# SSH 只读诊断与未派发失败恢复

日期：2026-11-09。功能及签名 Lake Dev 实测提交：`21cf5990de41de998d817811a95029d14da6ed24`，包含 PR #206 之前的 Pilot 派工/收尾修复。后续仅追加验证文档和计划状态；未运行生产主机检查或改写原故障账本。

## 行为

截图中的 `date -Is`、`last`、`journalctl` 查询没有取得只读分类，连接失败后因可能有写入被保留为 unknown。修复按程序及参数识别受支持的字面量查询：ISO 时间显示、重启/关机记录和禁用分页的 journalctl 读取。设置时间、journal 维护/清理、分页、动态 Shell、输出文件重定向、未知参数及自定义程序路径不会获得只读证明。不是把整个 journalctl 程序加入无条件白名单。

SSH 宿主保存 `not_sent → exec_requested → channel_open`；先持久化 exec_requested 再进入传输方法。只在终态宿主记录与原 Task/Worker/Session、generation、调用 ID、资源及配置版本准确匹配时，才把 not_sent 失败记为 failed。允许当前权限内的新调用和新 attempt，原调用 ID 不重放，原失败不改成成功。显式计划仍沿原步骤、确认及验收契约推进。

exec 已请求后，即使未打开 channel、没有输出或抛出 spawn_error，也不能当作未执行。原未知调用保留，冲突变更和目标验收继续阻断；新的独立只读查询可以取得证据。旧记录缺少阶段证明时不靠错误文字或新命令成功自动结清。

## 自动验证

固定 Node.js 24.14.0，命令中的 node/tsx 使用仓库缓存 Node PATH。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| TS 类型 | `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| 固定 SDK 构建 | `node runtime/typescript/build.mjs` | v3.17.2 构建通过 |
| 源码回归 | `web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts` | 227 项：223 通过，4 条件跳过（可选 Claude-Mem / Linux 平台） |
| 运行时回归 | `node --test runtime/typescript/*.test.cjs` | 179 项全部通过 |
| 前端/共享策略 | `web-agent/node_modules/.bin/tsx --tsconfig web-agent/web/tsconfig.json --test web-agent/web/test/*.test.ts` | 764 项全部通过 |
| 前端类型 | `pnpm --dir web-agent check` | 通过 |
| 运行边界 | `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| 签名安装 | `scripts/build_lake_desktop.sh --dev --install` | Web 构建、签名、Dev 安装通过 |

新增 `execution-dispatch.test.ts` 的 8 项宿主/SQLite 测试覆盖：连接失败后准确的新调用、显式计划原契约、exec 同步抛错、请求后断线、channel 后断线、后台结算、发送前取消、缺失/错属宿主证明和模型伪造标签。重开数据库保留未知及原阶段；原调用仍不可重放。成功替代只验收新 attempt 的实际证据。

两项真实 SDK + loopback SSH 用受控模型回复验证：连接被拒后重连，同一 opaque 命令第一次未发出/failed、第二次实际执行/succeeded，目标通过；另一项在服务器收到 exec 后断线，原操作 unknown，新的 journal 查询实际收到合成日志，目标仍 blocked/未验收。该日志由测试服务器提供，不冒充 macOS 本机或云服务器日志。

## 签名 Lake Dev 与真实模型

运行 `~/Applications/Lake Dev.app`，Home `~/.lake-dev`，build-origin 为干净提交 `21cf5990de41de998d817811a95029d14da6ed24`。TS 后端 SHA256：`1f822ec6ba9d25fe41036a239fab4cca686d44cee988f9d67ecbe36e9b8ffa40`。

新建「SSH 只读恢复回归 1109」项目 `20f7f261-392d-432e-ae9d-54b5033eadc3`，只有本机与「QA 合成 SSH（仅回环）」资源。使用当前真实模型 `gpt-6.1-terra`，测试项目允许普通命令；不修改既有项目权限。SSH 服务监听随机 loopback 端口，只返回带 `QA_ONLY_SYNTHETIC_LOG` 的合成文本，不执行模型提交的命令。

1. 要求查询引用端点的上一次启动日志，原文指定 `journalctl -b -1 -n 100 --no-pager -o short-iso`，禁止其他端点和变更。Pilot 自动派给新专员。
2. 夹具故意在首次连接的认证前断开。真实模型报告连接失败并提交部分结果，没有在此轮自行重试；原任务 paused。Operation 为 `failed/readOnly=true`，宿主阶段 `not_sent`。
3. 向 Pilot 输入「继续检查。」；沿同一 Task/Worker/Session、原期限续接，generation 由 1 变为 2。首次访问夹具的主机公钥经 QA 与 loopback 服务核对后登记信任，没有更改真实服务器信任。
4. 第二次 Bash 返回合成上一轮启动日志。Task `st_573ec12dc0d925b02f57d5327c8e4a44` 为 completed/pass；第二笔 Operation `succeeded/readOnly=true/channel_open`。两笔原记录均保留。

原生 Dev 界面可见首次失败说明、继续查询过程和最后实际合成日志报告，状态「已结束」，没有出现需要解除执行核查的拦截。只读 SQL 核对同一 Task 的上述两笔操作及验收状态。测试项目保留；自建 loopback 夹具在验证后停止，不能把其连接元数据当作仍在线服务。

## 边界与回退

这次证明的是只读判定、准确派发记账与允许恢复，不承诺真实模型遇到所有网络错误都会在同一轮自动重试。真实模型本次通过后续「继续检查」恢复；自动新调用由 SDK 夹具覆盖。

生产应用未重启，未连接截图中的实际服务器，未修改旧 unknown、权限、指纹或凭据。无数据库迁移；缺失阶段的旧记录保守兼容。回退代码不删除新阶段或原结果，旧 reader 忽略新增可选字段；不能以回退或上下文清理释放未决操作。

[实施计划](../../../plan/refactor-ssh-readonly-recovery-1.md)；交付在 [PR #206](https://github.com/Clean-Lakes/Lake/pull/206)，目标 develop，未合并、未正式发布。
