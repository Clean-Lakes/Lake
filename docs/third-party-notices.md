# 第三方组件与许可

Lake 在仓库内保留 Eino 的 [Apache License 2.0](../LICENSE-APACHE) 文本。以下是本次迁移直接使用或复制的组件，版本以 `go.mod`、`client/desktop/go.mod` 和两个前端的锁文件为准。

| 组件 | 用途 | 仓库内许可文本 |
| --- | --- | --- |
| [Eino](https://github.com/cloudwego/eino) | Go Agent 框架与本仓库底座 | [LICENSE-APACHE](../LICENSE-APACHE) |
| [ZCode CLI 0.16.9](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e) | 桌面主 Agent 的源码运行时 | [Apache-2.0 许可](../third_party/zcode/LICENSE)、[NOTICE](../third_party/zcode/NOTICE.md)、[依赖许可](../third_party/zcode/THIRD-PARTY-NOTICES.md) |
| [Node.js 24.14.0](https://nodejs.org/) | 运行源码构建的 Agent | 固定 npm Node 发行包附带的 LICENSE，构建时复制到 zcode/NODE-LICENSE |
| [Wails v2.15.0](https://github.com/wailsapp/wails) | macOS 桌面壳 | [Wails MIT 许可](licenses/wails-v2.15.0-LICENSE) |
| [官方 Go MCP SDK v1.7.0](https://github.com/modelcontextprotocol/go-sdk) | MCP 客户端 | [SDK 原始许可文件](licenses/mcp-go-sdk-v1.7.0-LICENSE)；该版本文件说明 Apache-2.0/MIT 过渡安排 |
| [beUI](https://github.com/starc007/ui-components) | 桌面聊天组件的复制源码 | [beUI MIT 许可](../client/desktop/frontend/BEUI_LICENSE) |
| [json-render core/react v0.21.0](https://github.com/vercel-labs/json-render) | 受组件目录约束的动态报告布局与 React 渲染 | [core Apache-2.0 许可](licenses/json-render-core-v0.21.0-LICENSE)；[react Apache-2.0 许可](licenses/json-render-react-v0.21.0-LICENSE) |
| [A2UI React / Web Core v0.12.0](https://github.com/a2ui-project/a2ui) | 官方 v0.9.1 动态面板处理与 React 渲染 | [React Apache-2.0 许可](licenses/a2ui-react-v0.12.0-LICENSE)；[Web Core Apache-2.0 许可](licenses/a2ui-web-core-v0.12.0-LICENSE) |
| [A2UI markdown-it v0.12.0](https://github.com/a2ui-project/a2ui) | A2UI 包附带的 Markdown 依赖 | [Apache-2.0 许可](licenses/a2ui-markdown-it-v0.12.0-LICENSE) |
| [Zod v3.25.76](https://github.com/colinhacks/zod) | A2UI 组件属性校验，包别名 zod-a2ui | [MIT 许可](licenses/zod-v3.25.76-LICENSE) |
| [DOMPurify v3.4.16](https://github.com/cure53/DOMPurify) | A2UI 附带的净化依赖，固定补丁版本 | [Apache-2.0 / MPL-2.0 许可](licenses/dompurify-v3.4.16-LICENSE) |
| [unified v11.0.5 / remark-parse v11.0.0](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) | 将所有 AI 正文解析为 AST，自动选择 A2UI 展示结构 | [unified MIT 许可](licenses/unified-v11.0.5-LICENSE)；[remark-parse MIT 许可](licenses/remark-parse-v11.0.0-LICENSE) |
| [Zod v4.3.6](https://github.com/colinhacks/zod) | 动态组件属性校验 | [Zod MIT 许可](licenses/zod-v4.3.6-LICENSE) |

React、Vite、Motion、Lucide 等前端依赖及其他 Go 依赖由各自的锁文件固定，具体许可文本随对应源包提供。仓库保留 ZCode 完整源码快照，桌面应用仅构建并打包 Agent CLI 依赖图，前端使用 LAKE 的 Wails/React。ZCode、Node 和未打入 CLI 单文件的运行依赖许可随 zcode/ 运行目录分发；发布到仓库外时，应随应用分发本页所链接的许可文本，并按实际打包依赖核对其许可文件。
