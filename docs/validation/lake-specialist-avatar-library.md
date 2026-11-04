# 100 款专员头像库验收

日期：2026-11-04。扩容代码验证 SHA：`22f56d021194ee9ab4f247448c5bd5279a181ee8`，在原头像 PR #175 内继续实现；后续提交仅补本记录和计划。

## 交付

`lakeAvatarCatalog.ts` 恰含 100 个唯一 ID、中文名称和不同几何的头像：四族各 13 个（水岸长鸟、湖畔伙伴、浅滩生灵、林间飞羽），四族各 12 个（微光昆虫、湖面游鸟、水中游鱼、岸边草木）。保留原八个图形，新增 92 个轮廓与细节；数量不依赖换色、镜像或标签。

RoleID 先选择生态族，再在族内稳定选择具体形象；当前有限目录仍允许不同角色抽到相同图形。本次扩容会使部分既有角色显示同族新形象，不改变角色身份；扩容后改名、换任务和重启保持固定映射。沿用原轻动效、隐藏冻结、减少动态效果和 20/22px 正常显示尺寸。

导出脚本使用产品同一 AgentIcon 绘图源：

```sh
pnpm --dir web-agent exec tsx --tsconfig web/tsconfig.json scripts/export-specialist-avatars.tsx
```

默认生成 `dist/specialist-avatars-100/`：100 个独立 SVG、manifest、说明及无需网络的 `index.html`。本次另交付 `dist/lake-specialist-avatars-100.zip` 和 `dist/specialist-avatars-100-overview.png`。产物不提交为第二份绘图源；独立 SVG 是静态矢量，运行时动画与主题由 Lake 组件或离线总览提供。

## 检查

| 检查 | 结果 |
| --- | --- |
| `pnpm --dir web-agent check` | 通过 |
| `pnpm --dir web-agent test:frontend` | 源分支 590/590，通过 |
| `pnpm --dir web-agent build:web` | 通过，保留原有 chunk 大小提示 |
| 100 图几何与映射回归 | 100 个 ID、名称和去除根元数据/类名后的 SVG 几何字符串均唯一；100 个图形均可被 RoleID 选择，同一 ID 改名保持一致 |
| SVG/XML 与文件包 | 100 个 SVG 均可解析，归档恰含 100 个 SVG，逐文件字节与当前导出一致 |
| `git diff --check`、计划结构与声明唯一性 | 通过 |

ZIP 大小 77,488 字节，SHA-256：`4d9ff25cd99c79e7eb6732087581c2bd20bc047e2ae06d1b3a9ed5a3ab84839c`。

本轮仅修改前端头像、分配、导出及说明，无 Go、数据库、权限或任务运行代码变化；没有重复运行后端全量。原头像来源投影的 Go 验证保持见[首版头像验收](lake-specialist-avatars.md)。

## 浏览器视觉

用 ego-browser 打开离线总览，检查 1360px 浅色总览、深色 22px 及 520px 窄窗口。100 图均已展示；分类数量之和为 100，分类过滤与键盘焦点可用，无文档水平溢出。所有图形的实际 SVG 几何均落在 24×24 viewBox 内，无零长度主体路径；检查中修正了三叶草及樱花的边缘裁切。

实际 transform 随时间变化，全部 100 个头像可进入工作动效；静止模式及模拟系统减少动态效果后动画数均为 0。浏览器空间已关闭，未升级浏览器工具。

## Lake Dev

最终干净集成 SHA：`7d079c9a6b77d79705472e4a42a91e62493e9776`，macOS arm64，通过 `scripts/build_lake_desktop.sh --dev --install` 签名构建安装。保留此前 Dev 候选，集成类型检查与前端 591/591 通过。

安装验证发现旧 Dev 在本轮应用替换前再次启动，进程仍映射已被替换的旧 bundle，因而实际返回旧页面资源；不能仅凭磁盘上的 build-origin.json 判断运行版本。确认原任务均无活动派发后，通过原宿主 lifecycle drain 接口排空，并仅结束已核对路径的旧 Dev 前端；没有强制结束其他应用或删除运行账本。旧前后端及 runtime 均退出后，从已安装的新包重开。

最终核对实际运行可执行映射位于 `~/Applications/Lake Dev.app`，非旧 backup；HTTP 返回的 `/assets/index-HILlHuSM.js` 含新目录形象，与本次构建一致。后端 Home 是独立 `~/.lake-dev`。原生工作台已观察到新形象，侧栏与顶部一致，现有 4 位专员及原资源目录保留。

安装前后的用户消息、任务输入、原操作、审批、决策和事件逐表指纹一致。32 条专员报告的 RoleID 与原 Worker 对齐；4 个频道中的 49 条历史报告正文保留，Pilot 权限和当前项目继承的全局 MCP 保留。

未进行 Windows 原生验证，未运行真实模型任务或资源查询。原 PR #175 继续以 `develop` 为目标，本次不自动合并或发布。
