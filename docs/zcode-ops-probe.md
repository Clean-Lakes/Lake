# ZCode 接入 LAKE 运维层：实测记录

测试日期：2026-10-01。

**结论：ZCode 调用 LAKE 查询测试湖、查询主机、执行真实 hostname 和读取关联湖志已跑通。完整审批链尚未跑通：安装版 ZCode 能处理自己的工具审批，但没有完成 LAKE 发起的 MCP 表单审批。LAKE 在这种情况下拒绝执行。**

这支持继续二开 ZCode、复用 LAKE 运维执行层的方向。下一步应先补审批交互和结果展示，再扩展运维功能。

## 测试范围与方法

- 使用已安装、未修改的 ZCode Agent CLI **0.16.9**：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。通过实际 `app-server` 协议建立会话、订阅桌面事件、处理工具权限请求。
- 参考 [ZCode 开源源码](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，基线提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；此次未修改 ZCode 源码。
- 模型响应由本机回环 HTTP 服务固定生成。验证的是实际 Agent、MCP、权限和运维调用链，不包含真实模型的规划能力，也不包含桌面审批卡与结果卡的视觉验收。
- ZCode 使用隔离的模型配置、会话数据库和工作目录。模型只能看到本次四个 LAKE 工具；没有向它开放 Shell、文件操作或其他 MCP 工具。
- LAKE 的 `bin/lake` 经 `scripts/build_lake.sh` 构建并签名。真实检查使用已登记、已授权的测试湖主机，正常凭据读取沿用 LAKE 私有文件存储。

## 结果

| 项目 | 实测结果 | 证据与限制 |
| --- | --- | --- |
| 测试湖与主机查询 | 通过 | ZCode 返回绑定的测试湖和主机 ID，与独立 LAKE CLI 查询一致。此原型固定绑定一个湖，尚未实现桌面湖选择器。 |
| ZCode 原生工具审批拒绝 | 通过 | 测试驱动向实际权限请求返回 deny；检查未进入 LAKE 执行器，没有生成运维 run_id。 |
| LAKE MCP 审批批准 | Go 协议测试通过 | 支持 elicitation 的测试客户端批准后，SSH 调用和凭据读取各一次；这是模拟 SSH。 |
| LAKE MCP 审批拒绝、未授权、审批期间撤权 | Go 协议测试通过 | 各场景 SSH 调用和凭据读取均为零，湖志记录拒绝。 |
| ZCode 响应 LAKE MCP 审批 | 未通过 | ZCode 原生工具审批允许后，LAKE 表单审批仍未完成；返回失败和 denied 湖志，没有 started/completed。 |
| 固定只读检查 | 真实 hostname 通过 | 沿用现有只读静默策略，经过 ZCode 工具权限允许；不是 LAKE 表单审批成功的证据。 |
| 工具结果与湖志关联 | 通过 | 真实检查的 MCP 湖志和独立 CLI 湖志均有同一 run_id/action_id、目标和一次 completed。 |
| 命令注入、范围外资源、外部运行湖志 | Go 协议测试通过 | 均拒绝；非法请求未增加 SSH 执行次数。 |
| 桌面审批与结果展示 | 尚未验收 | 已验证协议事件与结果内容，未完成真实桌面点击和视觉验收。 |

### 单次真实检查

| 字段 | 值 |
| --- | --- |
| 目标 | 测试湖/36.151.150.63 |
| 固定检查 | hostname |
| 返回值 | jdy-4c8g-host |
| 退出码 | 0 |
| run_id | d827c6dd-d250-42d2-adef-94a78d051ade |
| action_id | bf3d07bd-9c12-4304-a713-35a02a92b475 |
| 湖志 | requested → started → completed |

本次成功运行只执行了一次真实 hostname。首次真实尝试因测试启动器漏传 HOME，SSH 在派发前失败；补上原 HOME 的透传后复测成功。该失败记录保留在本机湖志，没有将其计为远程执行成功。

用户原有 `silent_ssh_read` 和 `silent_ssh_command` 权限均未修改。绑定湖服务不切换用户当前湖。真实测试中的 ZCode 允许决定由测试驱动返回；不是用户在桌面点选批准。

## 审批缺口及二开边界

ZCode 原生工具权限和 LAKE 运维审批是两层交互。此次原生权限事件有正常的允许/拒绝响应；要求 LAKE 审批时，客户端不能完成服务器的 elicitation，LAKE 返回：

```text
客户端未完成 LAKE MCP 审批；检查未执行
```

二开时需要将客户端审批能力接到桌面交互，展示目标、固定检查、审批状态及运维结果，并把审批响应交给 LAKE。执行前的授权与目标复核、凭据读取和湖志继续由 LAKE 完成。不能把模型输出的“已批准”或普通工具参数当作审批凭据。

结果展示必须使用 LAKE 返回的 `status`、MCP `isError` 和退出码；协议调用结束不等于运维执行成功。拒绝时也要显示对应湖志，避免失败被展示为成功。

此原型使用初始化式 MCP，协议上限为 **2025-11-25**。Go SDK v1.7.0 的更新协议使用可恢复的输入请求；本次没有实现该路径，服务器拒绝更新协议协商。因此，当前代码是可行性验证入口，不是完整的生产协议适配。

## 复测

在仓库根目录执行。第一条构建命令使用持久签名身份；如果身份尚未安装，应先运行 `scripts/setup_lake_signing.sh`。

```sh
scripts/build_lake.sh
go test -race ./lake/opsmcp ./lake/operate
go test ./cmd/lake ./lake/opsmcp ./lake/operate
go vet ./lake/opsmcp ./lake/operate ./cmd/lake
node --check scripts/test_zcode_ops.mjs

# 默认：隔离的临时湖，不连接真实主机。
node scripts/test_zcode_ops.mjs

# 真实模式：测试湖内已授权主机的一次 hostname；要求现有只读静默权限。
node scripts/test_zcode_ops.mjs --real
```

真实模式默认选择测试湖中首个已授权主机。可用 `LAKE_PROBE_LAKE` 指定其他湖，`LAKE_PROBE_ZCODE_CLI` 指定 Agent CLI；改变目标后需要重新确认对应测试授权。

MCP 入口默认要求 LAKE 审批：

```sh
bin/lake ops-mcp --lake 测试湖
```

测试脚本第三个场景使用 `--require-approval=false` 来验证已有只读策略下的执行链。该选项不授予执行权，也不会修改持久权限；不能以此替代尚缺的桌面审批适配。

本次最终验证三个场景均符合预期，模型请求 14 次，额外工具/模型路由请求 0 次。批准、拒绝、撤权的 Go 协议测试及 race 检查通过。

## 文件与证据

- `lake/opsmcp/server.go`、`server_test.go`：四个受限工具、MCP 审批、审计关联及边界测试。
- `lake/operate/ssh.go`：增加单次调用方可要求更严格只读审批的开关，不修改持久策略。
- `cmd/lake/ops_mcp.go`、`cli.go`：绑定湖的 stdio MCP 入口。
- `scripts/test_zcode_ops.mjs`：安装版 ZCode 的可复测集成测试。

原始证据存于本机私有目录（目录 0700、文件 0600），未加入仓库：

```text
/Users/lingyunxieqing/Library/Application Support/Lake/test-reports/zcode-ops-1790863048562/
```

其中 `evidence.json` 保存断言结果、工具结果和独立湖志；各场景目录中的 `protocol.json` 保存实际 Agent 事件。证据包含主机与运维元数据，模型凭据仅为测试用占位值；没有真实模型 API Key 或 SSH 私钥内容。
