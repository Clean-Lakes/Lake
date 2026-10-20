# 第三方组件与许可

Lake 当前客户端使用 Go/React，运行时不依赖 ZCode 或 Node.js。当前分发组件的许可见 [web-agent/THIRD_PARTY_NOTICES.md](../web-agent/THIRD_PARTY_NOTICES.md)，版本以根目录 `go.mod` / `go.sum` 和 `web-agent/pnpm-lock.yaml` 为准。下表列出当前与历史实现涉及的来源及许可，用途栏注明是否参与当前构建。

| 组件 | 用途 | 仓库内许可文本 |
| --- | --- | --- |
| [Eino](https://github.com/cloudwego/eino) | 已移除的早期框架；保留原始许可归属 | [LICENSE-APACHE](../LICENSE-APACHE) |
| [ZCode CLI 0.16.9](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e) | 已移除的历史 Agent/Electron 运行时；源码快照原以 `git archive` 导入，未包含上游 Git 历史 | [Apache-2.0 许可](licenses/zcode-0.16.9-LICENSE)、[NOTICE](licenses/zcode-0.16.9-NOTICE.md)、[历史依赖许可](licenses/zcode-0.16.9-THIRD-PARTY-NOTICES.md) |
| [Node.js](https://nodejs.org/) | 当前仅用于前端构建；不随当前客户端作为运行时分发 | [历史 TypeScript Agent 依赖归属声明](licenses/lake-ts-agent-THIRD-PARTY-NOTICES.md)；旧包内完整许可随当时的分发保存 |
| [Wails v2.15.0](https://github.com/wailsapp/wails) | 历史 Wails 桌面壳；当前 macOS 使用 Swift/WebKit | [Wails MIT 许可](licenses/wails-v2.15.0-LICENSE) |
| [Go MCP SDK v1.7.0](https://github.com/modelcontextprotocol/go-sdk) | 当前 MCP 客户端的 HTTP、SSE 和 stdio 协议支持 | [SDK 原始许可文件](licenses/mcp-go-sdk-v1.7.0-LICENSE)；该版本文件说明 Apache-2.0/MIT 过渡安排 |
| [beUI](https://github.com/starc007/ui-components) | 桌面聊天组件的复制源码 | [beUI MIT 许可](../client/desktop/frontend/BEUI_LICENSE) |
| [json-render core/react v0.21.0](https://github.com/vercel-labs/json-render) | 受组件目录约束的动态报告布局与 React 渲染 | [core Apache-2.0 许可](licenses/json-render-core-v0.21.0-LICENSE)；[react Apache-2.0 许可](licenses/json-render-react-v0.21.0-LICENSE) |
| [A2UI React / Web Core v0.12.0](https://github.com/a2ui-project/a2ui) | 官方 v0.9.1 动态面板处理与 React 渲染 | [React Apache-2.0 许可](licenses/a2ui-react-v0.12.0-LICENSE)；[Web Core Apache-2.0 许可](licenses/a2ui-web-core-v0.12.0-LICENSE) |
| [A2UI markdown-it v0.12.0](https://github.com/a2ui-project/a2ui) | A2UI 包附带的 Markdown 依赖 | [Apache-2.0 许可](licenses/a2ui-markdown-it-v0.12.0-LICENSE) |
| [Zod v3.25.76](https://github.com/colinhacks/zod) | A2UI 组件属性校验，包别名 zod-a2ui | [MIT 许可](licenses/zod-v3.25.76-LICENSE) |
| [DOMPurify v3.4.16](https://github.com/cure53/DOMPurify) | A2UI 附带的净化依赖，固定补丁版本 | [Apache-2.0 / MPL-2.0 许可](licenses/dompurify-v3.4.16-LICENSE) |
| [unified v11.0.5 / remark-parse v11.0.0](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) | 将所有 AI 正文解析为 AST，自动选择 A2UI 展示结构 | [unified MIT 许可](licenses/unified-v11.0.5-LICENSE)；[remark-parse MIT 许可](licenses/remark-parse-v11.0.0-LICENSE) |
| [Zod v4.3.6](https://github.com/colinhacks/zod) | 动态组件属性校验 | [Zod MIT 许可](licenses/zod-v4.3.6-LICENSE) |

ZCode 源码快照、旧 Electron 构建入口、TypeScript Agent、Node Web 后端及相关运行时脚本已移除，历史许可归属继续保留。当前 macOS/Windows 构建使用 Go 后端及内嵌 React 前端，按实际分发的依赖携带 `web-agent/licenses/` 下的许可文件。历史设计可通过 Git 历史查看。

模型供应商品牌 SVG 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的 `@lobehub/icons-static-svg` v1.95.1，采用 MIT 许可；[原始许可](../web-agent/licenses/lobe-icons-MIT) 与 [素材来源和摘要](../web-agent/web/public/providers/provenance.json) 随仓库保存，图标随应用本地分发。
