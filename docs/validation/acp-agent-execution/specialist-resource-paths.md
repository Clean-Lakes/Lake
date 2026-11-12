## 专员任务页移除目录枚举（2026-11-12）

已测试源码与签名 Lake Dev：`409c31ef1cca3325f28de04983511c8d7a54c232`，macOS arm64、Node 24.14.0、独立 `~/.lake-dev`。后续验证文档提交不改变构建输入。

按用户截图移除任务行中的资源目录枚举及右侧详情头部的“资源目录”字段。任务行仍可显示实际活动，执行 Agent、原报告和证据保留；目录继续参与搜索，资源绑定与后端未改。

| 本轮检查 | 结果 |
| --- | --- |
| 前端类型 | `tsc --noEmit -p web-agent/web/tsconfig.json` 通过 |
| 相关前端单元 | `specialist-task-list.test.ts` 8 通过，0 失败/跳过；未新增仅复刻展示实现的测试 |
| 签名构建 | `scripts/build_lake_desktop.sh --dev --install` 通过，包含 Web 类型与生产资产构建；既有大 chunk 提示保留 |
| 浏览器 | 真实 App + 虚构本地 API，1280×900 浅色与 620×800 深色通过；任务行不列目录，详情元数据仅显示执行 Agent，无横向溢出 |
| 目录搜索 | 夹具按“韦二”搜索仍返回 6 项；清除后恢复原 8 项，准确原任务入口正常 |
| 签名与来源 | `codesign --verify --deep --strict`、`dev_build_origin.py check` 通过；manifest 为上述准确 SHA、dirty=false，bundle ID 为 `com.cleanlakes.lake.desktop.dev` |
| 实机 | 正常停止旧 Dev 内核后安装，重新打开原专员的 34 项任务及原任务结果页，两处目录列表均已移除 |
| 数据保护 | 安装前后私有逐条哈希一致：19 项目、151 可见 Worker，161 资源、154 树节点，以及原角色/频道/任务/操作/报告/命令/旧版记录；扩展/Skills 文件与本机 Codex 配置一致 |

已安装后端 SHA256：`d77eb4e3968189e24ed7020aca545527c617afb327673ae0658de16333ecce0c`，与构建来源记录一致，实际进程位于 `~/Applications/Lake Dev.app/Contents/Resources/lake`。仅浏览原任务，没有发送业务 prompt、重试业务操作或连接实际服务器。临时浏览器与夹具 Vite 已关闭；没有创建完整 Home/数据库备份，四处已删除备份根目录仍不存在。

本轮未重跑全部前端、后端单元/宿主/真实 ACP 或其他平台。后端与上一轮 `9dd23954be16411acbed3b55d4665dd9968f2f9d` 一致，历史完整配置回归仍以[其实际记录](pilot-configuration-crud.md)为准。正式版未安装或重启，PR 保持草稿，未合并或发布。

回退只需恢复这两处前端展示并重新签名构建 Dev，无数据迁移或权限变动。
