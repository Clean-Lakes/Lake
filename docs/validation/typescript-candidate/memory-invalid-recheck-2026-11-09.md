# 记忆失效后的独立只读复查验证

功能及签名 Lake Dev 提交：`7873b3b7b7160a2494d3210343859de3b837aba3`。后续只更新本验证说明和计划状态。

## 真实故障

截图对应旧任务 `st_39bbd8864757f39c01831e28eba96189`。新一轮没有业务工具调用；Worker 在请求前因原记忆依赖不可用失败。其历史中另有一笔 unknown Bash，通用报告优先显示“有一项操作的结果还需核实”，掩盖了本轮真正的 Memory 错误。这里的失效不证明用户主动删除过记忆；权限、来源与资源变化同样会使来源不可用。

修复没有清除旧上下文、改写 unknown 或连接用户服务器。旧任务、Worker、原操作、记忆读取依赖及报告共 9 条原始记录，在安装和复核后 SHA-256 全部保持不变。原生 Dev 中旧报告已按准确宿主错误显示“原上下文使用的记忆已失效，续查尚未开始……”，原始数据库文字保留。

## 新行为和边界

新的真实 followup 对于符合条件的旧普通单专员任务，转为同 RoleID 的独立只读 Task/Worker/SDK Session。以当前人类输入、原人类要求和原明确资源为起点，沿用原截止时间，不复制旧报告/任务上下文/引用/工具句柄或长期知识。请求与 part 重试幂等。TaskLedger 在业务 I/O 前拒绝写入、opaque 调用及临时 child 的非只读操作；只读标记与截止时间不能被迟到快照删除或延长。

显式计划、共同任务、已终结/到期、原执行仍活跃、角色不匹配或明确范围不可核验时不自动改合同。新复查完成不验收其来源任务，也不解除原未知操作。普通任务的完整 Agent 能力保持；限制只属于这一独立复查。

## 自动验证

固定 Node `24.14.0`，使用仓库 TS/tsx 和原生 SDK。

| 检查 | 结果 |
| --- | --- |
| TS 类型检查、runtime bundle、前端类型检查 | 通过 |
| `tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts` | 236 项：232 通过，4 条件跳过（可选 Claude-Mem 和 Linux 扫描器） |
| `node --test runtime/typescript/*.test.cjs` | 180 项全部通过 |
| `tsx --tsconfig web-agent/web/tsconfig.json --test web-agent/web/test/*.test.ts` | 765 项全部通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `scripts/build_lake_desktop.sh --dev --install` | macOS arm64 签名构建安装通过 |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | 通过 |

真实 SDK 的受控供应商测试先让 Worker 实际读取有效记忆，随后遗忘合成来源，并为原任务保留一笔合成 unknown。人工 followup 经真实 route_work 建立新的只读复查，Provider 请求不包含撤回标记；实际 Write 被账本拒绝，没有产生文件，随后 Read 取得合成当前数据并验收本次复查。旧 Goal/Worker/memoryReads/unknown 原样保留。这个协议夹具不代表真实模型必定选择某一工具。

生命周期测试还覆盖幂等重入、不同 part 的准确重试、角色/范围/期限/活跃/显式计划/共同任务拒绝，以及不会把新结果当成旧验收。报告投影测试拒绝模型文字、跨 Task/Role/Session/root、没有准确 outbox 或错误卡片的推断，不写回历史。

## 真实模型与原生 Dev

使用独立项目“记忆失效只读复查 QA 1109” (`023ddfa3-60e8-4f8b-8624-43e1b6e87254`)，仅有自动创建的本地工作区，未访问 SSH、数据库或网络业务服务。

1. 在配置好项目权限后保存合成记忆。第一轮要求专员只列目录并提交 partial，以制造尚未结束的旧任务。实际 `memoryReads` 记录一条来源，旧任务 `st_c0ad50e5193542c4983c3ab99c3c93f4` 暂停。
2. 通过正常 Memory 管理 API 遗忘这一条 QA 来源，发送“再查一下当前工作区……仍由刚才的文件检查专员继续”。真实模型提交 followup，宿主建立 `st_6f8f74bdacba6d6d9dd452ffc9c62941`，`readOnlyRecoveryOf` 指向原 Task。同角色、不同 Session、相同截止时间 `2026-11-10T03:44:33.001Z`。
3. 新上下文实际列目录成功，报告文件数量 0，列表未截断。模型沿用了夹具第一轮的 partial 停止要求，因此没有把它冒充第一次即自动验收完成。
4. 在原生 Dev 当前对话明确本次复查只需目录结果、取得真实回执即可完成。模型在同一复查 Task 再列一次目录，以 `work_finish(outcome=completed)` 正常提交；状态 `completed/pass`，界面显示“只读复查结果：当前工作区目录为空，实际文件数量为 0；目录列表未截断”。

原 QA 来源任务的 Goal/Worker/Operation/Attempt/memoryReads 共 5 条记录在这两次复查后哈希不变；新复查两笔 `list_project_files` 均 `succeeded/readOnly=true`。未复制旧上下文，也未宣称新检查完成了原任务的其余工作。QA 项目保留便于复核；正式 Lake 应用与数据未改动。

安装位置 `~/Applications/Lake Dev.app`，bundle ID `com.cleanlakes.lake.desktop.dev`，Home `~/.lake-dev`。`build-origin.json` 为上述提交、`dirty=false`、TypeScript；后端 SHA-256：`72977eea2729a2498b7cb37116d6ca8c2640638a510c690a931293e436015643`。

## 回退与未验证项

回退实现与提示词，保留新增可选字段、原始操作和读取依赖；不能通过清理账本回退。未对用户故障服务器执行实际日志续查；原 unknown 的执行效果仍需单独核实。Windows、外部 Claude-Mem 及 Linux 专属扫描本次未验证。不包含合并 PR 或正式发布。
