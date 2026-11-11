# SSH 首次后台信任验证（2026-11-11）

已测试源码与签名 Lake Dev：`603d4491f7f9083112537e3154e48d7aadcb9187`，macOS arm64，固定 Node 24.14.0。实施见[计划](../../../plan/refactor-ssh-first-use-trust-1.md)，结构化结果见[验证 JSON](ssh-first-use-trust.json)。

## 行为与范围

按用户明确要求，TypeScript 的 SSH 首次连接在后台自动保存观察到的公钥并继续认证，不发布首次指纹弹窗。实现复用 `LakeSSH.authorize -> decide` 原接受路径及 Home 内私有 known_hosts 文件的原子写入，保留项目归属、配置/凭据版本、信任记录摘要和全局状态校验。只在没有已存公钥时自动接受；匹配的已存公钥直接复用，已有不同公钥仍须准确确认，不静默覆盖。

这是首次使用信任，不提供首次连接前的独立服务端身份核对。主机信任不替代资源权限、Pilot 操作偏好、任务资格、停止和结果验收。终端、Pilot、Worker、任务内 child 和 ACP 工具桥继续共用同一 LakeSSH，不增加前端自动点击、额外开关或模型授权入口。旧待确认或超时的业务调用不因安装而自动重跑。

取消测试还发现：连接已经销毁后，延后的 hostVerifier 回调继续进入 ssh2 协议，会触发失效协议对象异常。现在连接结束后丢弃这类回调；保留原取消与失败结果，不继续认证。

## 检查

Node 命令使用固定 Node 24.14.0；TS 单元设置 `TSX_TSCONFIG_PATH=runtime/typescript/tsconfig.json`。

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端类型及构建 | `tsc --noEmit -p runtime/typescript/tsconfig.json`、`node runtime/typescript/build.mjs` | 通过 |
| 后端单元 | `node --import ./web-agent/node_modules/tsx/dist/loader.mjs --test runtime/typescript/*.test.ts` | 272 通过，4 项既有可选跳过 |
| 完整宿主 | `node --test runtime/typescript/server.test.cjs` | 196 通过，0 失败/跳过；真实 loopback SSH、实际 PTY、SDK 和原任务验收 |
| 固定真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node <Node24> --test runtime/typescript/acp.integration.test.cjs` | 4 通过；adapter 2.2.2 / engine 0.160.1，本地合成 Responses，无真实外网推理 |
| 边界及命名 | `check_adk_runtime_boundary.py`、`check_backend_naming.py`、对应 Python 命名单元 | 通过 / 0 违规 / 5 通过 |
| 签名 Dev | `scripts/build_lake_desktop.sh --dev --install` | 通过；准确来源 SHA、dirty=false、Dev bundle ID、后端哈希及深度签名核对通过 |
| 原生应用 | 启动 `~/Applications/Lake Dev.app`，打开原专员页 | 正常显示 34 项任务，原执行 Agent 与待核实状态保留 |
| 数据与配置 | 安装前后逐条记录哈希、本机 Codex 配置全文哈希 | 完全一致；没有新建完整 Home/数据库备份 |

## 协议回归

1. 首次真实 SSH 连接在服务端收到认证之前已存在私有信任文件，权限为 0600；整个过程中未发布 HostKeyTrust。实际 PTY 可执行测试指令并保持 Shell 状态，重启后沿保存记录复用，密码不进入公开响应。
2. 故障注入使信任写入失败：零认证、零远程命令、没有遗留指纹弹窗，也没有落盘信任。恢复写入后新终端可按首次路径连接，不伪造旧连接成功。
3. 两个独立会话并发首次连接同一端点，只保留一条信任记录；两条真实远程连接均成功，无需手动指纹请求。
4. 在宿主验证入口受控暂停后取消连接：不保存公钥，不发送认证或远程命令；延后的协议回调不再造成异常。
5. 服务端换钥后仍在认证前暂停。错误指纹与拒绝不改变信任；明确接受准确新指纹后才继续。已有真实操作权限、配置漂移、SSH 失败恢复、后台汇合与任务验收测试继续通过。

故障注入只修改 Lake 自有宿主边界，没有替换上游 SDK 内部实现。服务器、公钥、密码、资源和工作目录均为隔离测试数据。

## Dev 与保留

安装前确认无活动 Worker、频道、Router、ACP 或 running 命令，正常停止 Dev 内核并退出；从干净提交签名构建、安装后启动。正式版不安装或重启。按用户最新磁盘清理要求，本轮只留小型私有哈希审计文件，没有重新创建此前删除的四处备份目录或完整 Home/数据库副本。

19 个项目、151 个可见 Worker 保留。逐条核对 129 条 TS Worker、129 条目标、183 条尝试、400 条规范操作、162 条验收、175 条报告、5 条 ACP 运行及 287 条命令记录不变；14 类共 689 条 legacy 记录不变。本机 Codex 配置哈希一致，原 max 继承不改。

## 限制与回退

本轮没有连接截图中的实际服务器，没有新建、重试或重放真实业务任务；实机检查只验证安装、启动与原页面加载。首次无弹窗和认证顺序由真实本地 SSH 协议测试覆盖。其他平台、Go 后端和完整迁移等价未重测；无自动 CI、合并或发布操作。

前端源码未改，签名脚本重新通过 Web 类型检查与构建；798 项前端单元及原交互验证保留其原 SHA，未标为本轮重跑。原 Vite 分包及 Swift build-system 提示保留。

代码回退可恢复首次人工确认，但不会删除已经保存的公钥、改写旧操作或自动重放连接。其余边界见[兼容记录](compatibility.md)。
