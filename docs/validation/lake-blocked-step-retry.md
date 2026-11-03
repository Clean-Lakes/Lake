# 受阻步骤恢复与真实只读执行验收

2026-11-03，macOS arm64；最终被测源码及干净签名 Dev：`a014091b427f9126f431cc489c64c955ff5512d4`。后续仅补充验证文档。

## 原因与修复

真实“优刻云”任务已经确认了原目标、资源及人工验收契约；原步骤因准备阶段的安全拦截变成 blocked，没有登记任何原生资源操作，但留下 prepared 尝试。模型再次激活步骤时，`beginWorkAttempt` 要求整个目标先是 running，且旧 prepared 尝试没有安全重试终态，因此持续返回 `active versioned work and execution task required`。`work_update running` 还会在旧尝试同 root 时直接返回，忽略目标已经 blocked。

现在通过现有 `work_update running` 激活原步骤：允许受阻目标进入受校验的步骤重试，全部成功后再原子改为 running。仅 prepared、规范操作计数为零、原契约版本匹配且原 task 属于当前 store/epoch 的尝试可记为 not_executed/reconciled；同一派发屏障内追加宿主审计并创建带 retryOf 的替代尝试。后续真实轮次还会为全部已成功的、冻结 descriptor 可证明只读且资源连接仍匹配的观测建立新尝试；原尝试只归档执行事实并保留关联，不产生业务验收。通用 Shell 的旧 risk 标签不能代替已校验的固定诊断效果描述。既有操作的 risk/status/result/descriptor 不修改；unknown、dispatched、未结束、真正写入或描述不完整的操作不能走只读继续路径。新的尝试不授予权限、不扩大资源范围、不续期、不产生业务验收。幂等激活同时要求当前目标、实际 running 步骤及 task/root 匹配。

该资源还没有受控 OS 诊断登记。用户本轮明确确认 Linux 后，使用既有 command-targets 管理 API 配置当前连接版本的 `disk_usage/process_snapshot`，revision=1、enabled=true、services=[]，没有改项目权限或补造具体服务定义。

## 检查

| 检查 | 结果 |
| --- | --- |
| 全量 Go | `go test ./... -json -count=1 -timeout=12m`：1,962 项通过、15 项跳过，11 个包通过、4 个包无测试，0 失败 |
| Race | `go test -race ./internal/ai ./internal/web -run 'TestWork\|TestSecurityInspectHost\|TestSecurityManagedSSH\|TestSuper' -json -count=1 -timeout=8m`：126 项通过、1 项跳过，2 个包通过，0 失败 |
| 静态检查 | `go vet ./...`、ADK runtime boundary、`git diff --check` 通过 |
| 新增集成回归 | 受阻目标通过实际 work_update 路径恢复，替代旧的空 prepared 尝试；真实 loopback SSH 派发固定进程命令，取得返回，旧全局 unknown 写风险保持；重复激活不新增尝试；新的有效执行 owner 可在成功诊断后再取得新的只读 permit，覆盖旧 Shell risk=write 标签，且不产生人工 pass |
| 拒绝回归 | 原尝试存在 unknown/dispatched、成功写入或失败且尚未核实的操作时，不作为空尝试或已完成只读观测退休；拒绝后原尝试、目标 revision、状态及 activeAttempt 不变 |
| 前端 | 本轮未改前端；沿用 `faec0e44` 的 580 项回归。签名桌面构建重新执行 Web 类型检查与构建 |
| Dev | 干净上述 SHA 经 `scripts/build_lake_desktop.sh --dev --install` 安装，应用及后端严格验签通过；只使用固定 `~/.lake-dev` |

## 真实 Dev 执行

通过原专员消息 API 向原任务提交一次明确的继续只读检查要求，读取当前目标并激活原检查步骤，执行已登记的 inspect_host 固定 Linux process_snapshot；没有新建目标或修改资源绑定。首次进程检查使用 `cdcdfe75`；第二次磁盘检查使用 `b9fddb45`；在磁盘诊断的旧 Shell risk=write 标签之后，最终 `a014091b` 再次通过同一专员取得新的进程快照。

实际账本三次分别建立新的 retryOf 尝试，均沿用原目标、原步骤与当前有效 task/root。每次 list_assets 及对应诊断均为 succeeded，分别追加原 nativeEvidence。inspect_host descriptor 的 proof 为 command_profile，probeId 为 command.process_snapshot，最长 5 秒；真实 SSH 返回退出码 0、stdout 3,025 字节，追加原 nativeEvidence。第二次固定 disk_usage 退出码 0、stdout 437 字节：根文件系统约 40 GiB、使用率 10%；第三次固定 process_snapshot 同样退出码 0、stdout 3,025 字节，并新增独立原 nativeEvidence。旧 Shell 行的 risk=write 原标签与其 command_profile/disk_usage 描述均保留；真实注册命令是只读诊断。SSH 密钥交换算法提示没有改变这些调用的退出码，不作为服务健康失败结论。

专员已返回包含 nginx、x-ui、xray、Docker、sshd 的实际进程快照说明，并明确本次不能证明整体负载、磁盘或具体服务健康。原目标没有被伪造为已验收完成；三次限定的只读诊断已成功，不等于整个检查目标完成。manual pass 数量仍为 0，目标及计划契约 revision 均保持 1。

真实 Dev 的 93 条无安全描述历史 unknown，执行前后对 `id/session_id/tool/risk/status/handle/result` 按 id 排序、以 UTF-8 紧凑排序键 JSON 序列化的 SHA-256 均为 `7febc651775d1508f03366beebab306e4e1c40549ee6a02104674993b8fc16a5`。这是本轮固定投影的对比，不与历史使用其他序列化方式的摘要混用。没有清除原风险、重放写操作或代替用户验收。

最终安装后端 SHA-256 为 `00d5de69cf0ff5c77fe78373891f98d9b08fb119efc8b23733dd5bbbc40aea35`。最终源码另经 `scripts/run_lake_dev.sh` 启动签名后端完成 API 复验，来源 dirty=false、源码 SHA 同为 `a014091b`，运行后端 SHA-256 为 `98a07a7930ba19abd6a856754c9e1a812c8f11b9c5fc58e5e321948a47b5842a`；两个构建的时间不同。Mac 在后续安装时锁屏，窗口未能重新打开；固定 Dev Home 的终端托管后端保持运行，解锁后已安装 Dev 可按仓库流程连接它。下一次迭代前须先正常停止这个后端，不能再启动第二个同 Home 后端。本机测试日志与脱敏测量位于 `/tmp/lake-blocked-task-*`、`/tmp/lake-work-continuation-*` 和 `/tmp/lake-typed-read-*`，不提交真实连接、凭据、进程正文或认证令牌。生产应用未更动；PR #142 目标 develop，未合并或发布。其他旧任务的独立冻结范围与验收约束保持原样。
