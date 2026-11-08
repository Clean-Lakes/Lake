# Pilot 模型错误原因与显式重试验证

日期：2026-11-07。用户在原 Pilot 连续会话中发送续问后，界面只显示 `Turn execution failed`。现场 SDK 记录可定位到 provider 的 stream 阶段，具体底层异常文案未保留，不能从旧记录还原完整原因。

## 改动与边界

原错误投影仅取最外层 `error.message`，丢弃 SDK 包装层下面的原因；通用脱敏又通过 `Object.entries` 把 Error 当普通对象，不能保留非枚举 message/cause，也会破坏 SDK 错误身份。现在保留原型、属性描述符、SDK 标记与原生错误属性，对消息、栈和嵌套原因脱敏，且不修改提供方的原对象。DOMException 的 name/code 单独保存，取消错误保持可读；循环引用有界处理，不接受原型污染。

主执行与 child 使用有界原因投影，公开卡片只包含消息、来源、代码、阶段、HTTP 状态与可重试提示，不序列化请求头、响应体、整个异常或栈。只有在原 SDK 自动重试规则之外收到明确新输入时才继续；本批不增加自动重试、不重派历史业务操作。Router 将脱敏后的失败原因保留到对应 blocked 输入，失败重启不自动变成 routed。

旧失败记录不反向改写。目标、权限、操作、未知副作用、验收和生产后端均未变更；上游源码保持原始固定版本。

## 准确源码与检查

- 功能与安装源码：`2dd9c9751eef669c45c9e40d356d823ff76574ee`，基于 develop `72b0b018233c9f3acb24de251264462981f70d1d`。后续仅补此记录。
- Node 24.14.0；运行时 TypeScript 检查、前端类型检查、React 构建、SDK bundle、命名审计、ADK 边界、差异空白检查通过。
- `node --test runtime/typescript/*.test.cjs`：135/135。
- 在 web-agent 运行 `pnpm exec tsx --tsconfig web/tsconfig.json --test ../runtime/typescript/*.test.ts`：121 通过、3 个现有 Claude-Mem 外部集成跳过。
- 新增回归覆盖 Error 非枚举原因、SDK 标记、原生错误身份、DOMException 取消名称/代码、脱敏栈、循环原因、字段白名单及原型污染。真实 SDK HTTP 401 与 SSE 错误夹具验证脱敏原因、持久化、blocked 输入错误归属、无业务操作、重启不重试，以及显式新输入完成。

## 签名 Lake Dev 与当前模型

通过 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 安装 `~/Applications/Lake Dev.app`，使用持久开发签名、Dev Bundle ID 与 `~/.lake-dev`。来源 dirty=false，后端 SHA-256 为 `47adfb7282c58582398c2caa0a43daa39d8b2106c99b8230ba5df1e78ac608ea`，深度签名检查通过。

使用独立的“模型错误回归 2026-11-07”项目和既有当前模型配置：首次纯文本回复 `LAKE_MODEL_STREAM_OK`；更改本测试会话的运行配置使 SDK Runtime 从同一档案恢复，再发送“再查一下”的纯文本要求，第二个独立 RootTurnID 同样回复该标记。按新 RootTurnID 判断结束，没有把前一轮 completed 快照当作新轮结果。两轮均完成，实际业务 Operation 数为 0。原生界面显示两轮回复、耗时和已结束状态，随后恢复原项目/Pilot 与原主题。

安装前后及回归后，1186 条既有消息、输入、目标、操作、Worker 和命令记录内容摘要一致。原失败请求未自动执行，没有向业务服务器重跑检查。私有应用/数据库备份保留；未读取 Keychain、打印模型密钥或 SSH 私钥。

## 实际限制与回退

旧现场只能确定模型流响应阶段失败；当前真实模型两次调用正常，不能据此断言旧异常的具体服务端原因已被复现或修复。此次修复交付的是完整、脱敏、可继续诊断的错误链及正确失败/重试归属。真实认证错误和 SSE 错误使用隔离夹具验证，没有改动用户的供应商配置来制造故障。

Windows/Linux 原生客户端、真实 Claude-Mem 外部集成及长期供应商稳定性不在此次实机验证范围。可用安装前的私有 Dev 应用备份回退；旧业务记录保留，本批没有数据库架构迁移。PR 保持待评审，未合并到 develop 或发布。
