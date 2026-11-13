# 专员任务页重连误报修复 · 2026-11-13

正常切换专员时，任务页曾直接把 `connected=false` 解释为断线，短暂显示红色“连接已断开，正在重连…”。该标记同时用于初次连接、切换会话和窗口恢复期间暂停操作，不能单独证明服务故障。已删除这条重复判断；真正的连接告警继续由 App 的会话绑定及持续故障判断负责，频道接口的实际读取错误与“重新获取”入口继续保留。

验证并签名安装的代码提交为 `52bbc588a6d577512a15a6ce0fb610e2f4e93f42`，Lake Dev 0.3.32，构建来源 `dirty=false`。使用 `scripts/build_lake_desktop.sh --dev --install` 安装到 `~/Applications/Lake Dev.app`，保留独立 `~/.lake-dev`。二进制 SHA-256 为 `5b5d9188dd28a7468b8ed5be6b1d96631702d0665174497c9e265545031c9e3a`；深度严格签名校验与 Dev 来源检查通过。

| 检查 | 结果 |
| --- | --- |
| Node 24.14.0 / `pnpm --dir web-agent test:frontend` | 817 项通过；补充暂停连接时不误报、记录保留、已读操作禁用和真实错误可重试的回归 |
| `pnpm --dir web-agent build:web` | 类型检查、构建通过；保留已有的大文件体积提示 |
| 安装后的真实专员切换 | 发布、知识库、数据库、知识库之间切换，DOM 观察没有记录到连接错误提示 |
| 原生 Lake Dev | 发布与知识库专员切换正常，知识库原有 3 条任务可见，无重复重连红字 |
| 频道接口真实错误的展示 | 隔离夹具返回 HTTP 503，错误与重新获取入口可见，34 条任务记录保留；重试失败继续显示，接口恢复后自动清除 |
| 真实 Dev 的持续网络失败 | 浏览器协议阻断网络后切换频道，真实请求失败触发 App 告警与重试入口；缓存的 3 条记录保留；恢复网络并重试成功，无重复重连行 |
| 明暗与窄窗口 | 1110×770 明暗主题、390×844 窄窗口已查看；窄窗口内容宽度 390，无横向溢出；恢复浅色 |

截图：[正常浅色](quiet-reconnect/light.png)、[正常深色](quiet-reconnect/dark.png)、[窄窗口](quiet-reconnect/narrow.png)、[真实连接故障](quiet-reconnect/offline.png)、[夹具 HTTP 503](quiet-reconnect/read-error.png)。截图在窗口尺寸过渡完成后复核。

初次连接、会话切换、窗口挂起/恢复和轮询回退的状态边界由现有 `connection.test.ts` 覆盖并在上述全量测试中通过。浏览器协议切换标签未改变 `document.visibilityState`，因此没有将该操作算作真实后台恢复的集成验证。本次只修改前端提示，不重跑 Go/race/vet、其他桌面平台或新一轮模型/远端业务操作。

安装前应用与 Home 备份位于 `~/Library/Application Support/LakeDevBackups/quiet-reconnect-20261113-142523/`，目录权限 0700。需要回退时先停止 Dev，再成对恢复应用与 Home。正式版未变更；PR #224 继续为指向 develop 的草稿，未合并。验证浏览器与临时 Vite 已关闭，原生 Lake Dev 留在知识库专员页供直接试用。
