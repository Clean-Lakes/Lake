# 第三方组件与许可

Lake 保留 Go 默认构建，并通过显式选项提供 TypeScript Dev 后端。macOS 使用 Swift/WebKit 客户端和 React 界面；TypeScript 候选通过 Node SEA 分发固定版本的运行时。实际分发组件的许可见 [web-agent/THIRD_PARTY_NOTICES.md](../web-agent/THIRD_PARTY_NOTICES.md)，版本以根目录 `go.mod` / `go.sum` 和 `web-agent/pnpm-lock.yaml` 为准。下表列出当前与历史实现涉及的来源及许可，用途栏注明是否参与当前构建。

| 组件 | 用途 | 仓库内许可文本 |
| --- | --- | --- |
| [Eino](https://github.com/cloudwego/eino) | 已移除的早期框架；保留原始许可归属 | [LICENSE-APACHE](../LICENSE-APACHE) |
| [ZCode CLI 0.16.9](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e) | 已移除的历史 Agent/Electron 运行时；源码快照原以 `git archive` 导入，未包含上游 Git 历史 | [Apache-2.0 许可](licenses/zcode-0.16.9-LICENSE)、[NOTICE](licenses/zcode-0.16.9-NOTICE.md)、[历史依赖许可](licenses/zcode-0.16.9-THIRD-PARTY-NOTICES.md) |
| [Node.js](https://nodejs.org/) | 前端构建及 TypeScript 候选的签名 SEA 运行时；候选包附带固定 Node 原始 LICENSE | [历史 TypeScript Agent 依赖归属声明](licenses/lake-ts-agent-THIRD-PARTY-NOTICES.md)；旧包内完整许可随当时的分发保存 |
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

旧 Electron 构建及早期源码快照已移除，历史许可归属继续保留。当前 TypeScript 候选使用公开 Agent SDK；依赖版本、原始仓库、归档摘要与工具链固定在 [上游清单](../runtime/typescript/upstream.json)，通过 [SDK 绑定](../runtime/typescript/sdk.ts) 接入。候选随包携带原始 LICENSE、NOTICE、Node LICENSE 和依赖许可；构建时逐文件核对下载源码。项目名称与运行时标识统一使用 Lake / TypeScript，依赖的真实名称及版权归属保留在集成边界。普通 Go 构建与完整切换门槛见 [候选说明](../runtime/typescript/README.md)。

模型供应商品牌 SVG 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的 `@lobehub/icons-static-svg` v1.95.1，采用 MIT 许可；[原始许可](../web-agent/licenses/lobe-icons-MIT) 与 [素材来源和摘要](../web-agent/web/public/providers/provenance.json) 随仓库保存，图标随应用本地分发。
