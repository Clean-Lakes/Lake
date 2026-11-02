# 旧账本未决操作的只读核查

日期：2026-11-01。这是 Lake Security 第一阶段的管理查询能力，不代表逐资源核实完成或任务授权已上线。

## 使用方式

先正常停止目标 Home 的后端，再用签名构建的 CLI 查询明确的 Home：

```sh
bin/lake security risks --home "$HOME/.lake-dev" --limit 100
```

命令输出 JSON，不启动工作台、Engine、SDK 迁移、模型、终端、记忆 worker 或调度器。它持有与执行运行时相同的 Home/DataDir owner 锁；有活跃 owner 或尚未核实的存活 PID 时拒绝。`--home` 必填，拼错或尚无有效 control 的目录不被初始化；`--limit` 默认 100，范围 1–1000，按源库分别限制。

既可核查有效、已初始化且停服的 open Home，也可核查保留有效身份的 closed Home。不改变 gate，不归档/删除 pending，不标记任何操作成功、失败或已撤销，不开闸或重试。Web 只读恢复依然只接受 closed Home；允许 CLI 核查 open Home 不扩大 Web 恢复入口。

## 返回结构

| 字段 | 含义 |
| --- | --- |
| `formatVersion` | 报告格式版本 1，不是数据库 schema 版本 |
| `storeID/recoveryEpoch/gate` | 本次核对过的控制身份与门禁状态，不是授权凭证 |
| `limitPerStore` | 每个源库最多返回多少条未决记录 |
| `resourceMapping` | 固定为 unverified；不从旧 target 文本推断可信资产身份 |
| `stores[].legacyStoreID` | 规范源路径的稳定命名空间，与迁移清单对应 |
| `stores[].view` | current 为当前规范库；archived 为旧 stdio 一致归档基线，不表示旧源库当前实时状态 |
| `operations/unresolved` | 该视图全部操作数与未决数；只有 succeeded、failed、not_executed 是已登记终态 |
| `effectReview` | 未决中记录风险不是 readonly，或状态不属于已认识的 unknown/dispatched/running 的数量；只是保守诊断分组，不授予执行资格 |
| `truncated` | 返回清单短于未决总数时为 true；不能据此忽略剩余风险，本批不提供跨调用一致分页会话 |
| `risks[].operationRef/sessionRef/toolRef/targetRef` | 按源命名空间和字段种类计算的 SHA-256 引用，不是原 ID、可信 resourceID 或已核实资产映射 |
| `risks[].status` | 已认识状态或 unrecognized；NULL/新状态保持未决，不猜测为失败 |
| `risks[].recordedRisk` | 已登记 readonly/write/dangerous，或 unclassified；不证明实际副作用 |
| `risks[].hasHandle` | 是否登记过 handle；不能据此断言进程仍运行、已停止或操作已完成 |

不返回源路径、原始 ID、命令参数、目标文本、结果正文、handle 或连接凭据。缺少旧 Config 时，也不依赖凭据正则猜测字段是否安全；任意旧元数据仅投影为命名空间引用、封闭枚举或布尔值。

## 来源与一致性

1. 读取现有 control，持有相同 owner 锁并核对 RuntimeRoot、guard、reader 与恢复身份；不构造普通 Store/Engine。
2. 验证清单版本、storeID、epoch、策略、源 namespace、允许的快照位置、摘要和操作计数；最多接受规范库与旧 stdio 两个源，不混并主键。
3. 归档使用不可变只读 SQLite 视图，拒绝符号链接和未纳入摘要的 WAL/journal，读后复核摘要。规范库用包含已提交 WAL 的只读连接，每库在同一只读事务取得计数及清单。
4. 规范库归档验证迁移基线，并核对原操作身份仍存在于当前库；缺表或删除旧身份后另增同数量记录不能冒充风险消除。报告显示当前规范库，避免将已核实的当前状态与旧归档重复计数；旧 stdio 显示经校验的归档视图。
5. 只有旧 stdio 的初迁移可在尚无规范库时核查归档，不创建规范 DB。已初始化库丢失、清单中的规范库消失或出现未登记的迟到旧库时拒绝。
6. 输出前再次核对 control。同一操作 ID 在两个源中保持不同引用；核查不自动清除记录。

缺少必要 id/status、重复/空/非文本身份或过大元数据返回错误。可选旧列缺失时保持未知分类，不为查询运行 AutoMigrate。取消、损坏、版本不支持及 owner 冲突不会产生假装完整的成功报告。

## 后续边界

本批是基于原权威账本的只读投影，不新增可独立修改副作用状态的风险表。尚未交付：可信逐资源映射、跨归档显式核实、资源级解锁、owner 租约/孤儿取消、通用跨设备恢复、TaskGrant 和逐派发事务。

truncated=true 时清单不完整；resourceMapping=unverified 时不能按 targetRef 自动绑定资产或解除阻断；archived 仅代表归档基线。完整核实需关联真实资源、原操作及独立证据，不能修改报告、删清单或手动改 gate。

继续遵循 [Security 设计](../design/lake-security-v1.md)与[实施计划](../../plan/feature-lake-security-1.md)，保持 Items 管资产、Security 管安全判定、任务运行层管目标/验收、Memory 由 bearqy 维护的分工。

## 验证入口

- `internal/ai/security_risks_test.go`：双库同 ID、当前/归档去重、敏感字段不输出、限量、NULL/未来状态、缺列旧库、stdio-only、摘要/计数/身份损坏、journal、symlink、owner、迟到旧库、取消与初始化拒绝。
- `cmd/lake/security_recovery_test.go`：显式 Home、参数及离线查询。
- `internal/web/security_readonly_test.go` 与 `dynamic_port_test.go`：恢复读写边界、Start/Close 生命周期及重复启动拒绝。
- `scripts/verify_security_runtime_dev.py`：签名后端及可选原生 Dev 的隔离 Home 验收，核对账本/control/inventory/pending/快照摘要不变。

不需要产品 UI 改造；该能力的开发不授权操作生产 Home 或发布新版本。
