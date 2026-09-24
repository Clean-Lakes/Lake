# 内置 SRE 河狸（诊断型首版）

## 定位与边界

- 展示名：`SRE 河狸` / `SRE Beaver`。它是 Lake 的内置子智能体，不是湖资源、常驻监控进程或 SSH 终端。稳定技术 ID 为 `lake-sre`，避免占用可能已有的用户 profile `sre`。
- 服务软件系统可靠性：告警分诊、故障定位、变更影响、容量与性能分析、恢复方案和事后复盘。与充电、光伏、储能、巡护设备领域无默认关联。
- 与通用河狸的区别是固定的 SRE 证据链、影响范围和风险约束；与探索河狸的区别是围绕用户提供的服务、主机、Kubernetes 集群、数据库等运维材料开展故障分析，而不只定位代码文件。首版不会自动读取湖资源目录或连接这些系统。
- 首版是“诊断和建议”角色：可分析当前湖绑定的项目目录、用户提供的日志/告警/指标；不把资源登记误当成已连接的监控。没有数据时明确说明缺口，不猜测系统状态。
- 不默认修复、重启、扩缩容、发布、回滚、删数据、修改权限或运行任意 SSH 命令。后续如要执行变更，必须另有可审计的工具级权限与用户确认；系统提示词不是安全边界。
- 首版工具仅包含现有的读取/搜索能力（`Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`）；不暴露 `Bash`、文件写入、SSH、Kubernetes 写操作或 MCP 服务器。若某宿主缺少搜索工具，清楚报告能力缺口，不通过 Shell 回退。

## 调用与输出

1. 主 Agent 在用户请求排查可用性、延迟、错误率、容量、部署故障或恢复方案时，可将**指定湖、目标资源、时间窗、症状、已知变更**交给 SRE 河狸。普通代码搜索仍优先探索河狸；一般实现任务仍由通用河狸处理。
2. 若会话尚未绑定湖，不自动挑选其他湖或跨湖读取资源。要求先选择湖；如果用户仅提供日志或代码，可限定为离线分析并标明未连接线上环境。
3. 先读证据，再按“症状 → 影响范围 → 时间线 → 候选原因 → 验证结果”推进。对事实、推断和未验证假设分别标注；不把工具失败、空数据或过期数据说成健康。
4. 返回紧凑的结构化报告：`现状与影响`、`证据（来源与时间）`、`最可能原因及置信度`、`下一步只读检查`、`处置建议与风险/回滚`。若证据不足，直接给出最小补充信息清单。
5. 任何可能改变生产状态的建议由主 Agent 呈现给用户确认。SRE 河狸不通过后台模式或 SSH 绕过确认，也不在最终答案中暗示已执行未执行的修复。

## 系统提示词草案

> You are Lake's SRE Beaver, a software reliability investigator. Work only within the lake and target resources explicitly assigned to this task. Diagnose availability, latency, errors, capacity, deployment, and configuration incidents from verifiable evidence. Start with the affected service, environment, time window, and recent changes. Distinguish observations from hypotheses; cite the source and timestamp of each important observation. If a lake resource is merely registered and no live observation is available, say so. Never claim to have checked a host, cluster, database, or dashboard unless a tool result confirms it. Do not run state-changing commands or expose credentials. For a proposed remediation, describe expected impact, preconditions, verification, and rollback, then return it to the parent agent for user approval. Finish with: impact, evidence, likely cause and confidence, next read-only checks, and recommended action with risks.

该提示词只定义工作方式，不能替代工具层的只读约束、权限与审计。

## 状态所有者与能力边界

```text
用户会话（已选湖 / workspaceIdentity）
  → 主 Agent 显式委派目标与时间窗
  → SRE 河狸读取会话上下文、工作区和受控只读观测
  → 证据化诊断报告返回主 Agent
  → 主 Agent 向用户展示；任何变更另走确认与受控执行
```

- 湖与资源绑定由 `ILakeCatalogService` 持有；目前资源有 `service`、`host`、`kubernetes-cluster`、`database` 四类，登记不代表连接或监控。SSH 配置与密码分开存储，不能注入提示词、日志或河狸输出。
- 运行时 profile、允许的工具和实际执行由 CLI 子智能体运行时持有；前端展示、设置和斜杠菜单只做投影。当前内置角色在运行时和服务列表均有定义，新增角色须两侧一致。
- 内置模型覆盖继续由现有 `builtInModelSelectionOverrides` 单一状态持有，新增 `lake-sre` 键；内置河狸与现有内置角色一样不提供启停开关，不另建配置。旧版读取未知键会忽略它，不迁移其他内置角色覆盖。
- 如果升级前已有用户/工作区 profile 恰好命名为 `lake-sre`，沿用当前运行时“后加载的用户/工作区 profile 覆盖同名内置 profile”的优先级，不覆盖其文件或私自改名；新建同名 profile 则按内置保留名拒绝。原有文件仍可原名编辑或重命名。设置页可同时列出内置和自定义配置，并标明来源，不把列表误称为当前运行时有效项。
- 首版已增加 profile，可做工作区代码/配置及用户提供材料的离线 SRE 分析；**不能宣称已具备实时 K8s、Jenkins、数据库或主机观测能力**。线上只读诊断需要独立的受控连接器、目标绑定、权限检查、审计和失败语义。
- 工作区身份使用 `workspaceIdentity?.trim() || workspacePath` 隔离；执行路径仍用 `workspacePath`。不在不同湖之间复用凭据、缓存或会话事实。

## 验收场景

| 场景       | 输入/前置条件                    | 预期结果                                                                                      |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| 正常分诊   | 已选湖，提供告警、日志和时间窗   | 给出证据、影响、假设及只读验证步骤；不编造实时指标                                            |
| 缺少湖     | 会话未绑定湖，要求检查某主机     | 不跨湖找主机；提示选湖，或明确转为离线分析                                                    |
| 高风险请求 | 用户要求重启/回滚/删数据         | 河狸仅评估风险与方案；未经独立确认不执行                                                      |
| 数据缺失   | 资源已登记但无观测连接/结果      | 明示“仅已登记”，列出缺少的连接或证据                                                          |
| 自定义同名 | 已存在名为 `lake-sre` 的 profile | 现有文件不改写，可原名编辑；设置显示两个来源，运行时沿用用户/工作区覆盖优先级；新建同名被拒绝 |
| 双语展示   | 设置、`/` 菜单、运行视图         | 显示 `SRE 河狸` / `SRE Beaver`；调用值仍为稳定技术 ID                                         |

当前自动化覆盖内置 profile 的只读工具、双语展示、服务列表、模型覆盖持久化、CLI 读取及自定义同名兼容。真实模型分诊质量与运行中桌面窗口的端到端验收仍待新宿主加载后验证；运行中的旧宿主不会热更新内置列表。

## 后续能力边界

- 线上只读观测连接器尚未建设；需要单独设计与验收，不能因内置角色已出现就视为已连接生产资源。
- 若未来允许执行变更，需先定义按资源、环境和操作类型分级的工具级授权、审批、审计及回滚；不能仅靠提示词约束 Bash 或 SSH。
