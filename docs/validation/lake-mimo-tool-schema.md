# MiMo HTTP 400 工具 schema 修复

日期：2026-10-14。

`objectSchema(props, required ...string)` 在无必填参数时把 nil slice 放进 `required`，JSON 编码为 `null`。todo_read、load_skill、list_workflows、schedule_list 等新增工具因此含有 `required:null`。MiMo 拒绝整个请求，并返回 `Xiaomi MiMo: Invalid request parameters`。

此次失败会话的请求历史只有 system/user 消息，未执行到工具或 MongoDB 检查；不是工具调用历史缺失 reasoning_content 导致。模型通过已有本机网关访问。

修复：无必填参数时省略 required；有必填参数时仍输出字符串数组。工具权限、处理逻辑和用户会话未改变。

使用同一已配置 MiMo 接口，以合成文本和工具定义做对比；不发送业务历史、资源列表，不执行工具，不输出密钥：

| 请求 | 结果 |
|------|------|
| 无工具的普通对话 | 通过 |
| 单个合法工具 | 通过 |
| 修复前 core 完整工具集 | HTTP 400 |
| 单个工具含 required:null | HTTP 400 |
| 同一工具含 required:[] | 通过 |
| 完整工具集删除 required:null | 通过 |
| 修复后原始 core 工具集 | 通过 |

`catalog_schema_test.go` 将三个工具 profile（含记忆/委派工具）实际序列化到 OpenAI Chat、Responses、Claude、Gemini、Ollama 请求，递归检查每个 required 字段为数组，防止内部校验容忍 null 而掩盖 wire schema 问题。

`go test -race ./internal/ai -timeout=90s` 通过。`scripts/build_lake_desktop.sh --dev` 生成签名 Lake Dev App/ZIP/DMG，通过 strict/deep 签名校验。尚未替换正在运行的 Lake Dev；安装并重启后生效。

官方工具请求格式参考：[MiMo Chat API](https://mimo.mi.com/docs/en-US/api/chat)。根因和修复效果以以上实际对比请求为依据。
