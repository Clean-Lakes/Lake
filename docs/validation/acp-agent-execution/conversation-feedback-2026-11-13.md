# 过程样式与报数收尾修订

已测试并签名安装的源码：`b674ff4b1ed340e71c065512fb6f917445a3cc58`，后续提交仅补充文档和证据。依据用户对先前截图的反馈，本记录取代[初次集成验收](pilot-conversation-integration-2026-11-13.md)中“每次报数必有 Pilot 总结”的行为。

等待/回应状态及耗时元信息使用共享过程样式：13px、450 字重、主题次要色、1.6 行高；正式正文保持 15px、500 字重。干员标题下只显示“正在回复…”或“等待回应”，不重复姓名。原路由“用时 8 秒”不再夹在成员回复之间，以轻量“执行过程”入口保留详情。

召集默认 `summarize=false`：收件人结清后直接 completed，不额外调用 Pilot；失败与未回应仍按真实成员状态显示。只有用户明确要求综合意见/比较时，才设置 `summarize=true` 并使用独立 Pilot 上下文。旧自动总结从主对话展示隐藏，原消息保留；显式请求的综合结论以及普通 Pilot 回复继续显示。不以报数关键词正则控制模型或改写历史正文。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 后端类型 | 通过 |
| 全量源码测试 | 309 项：305 通过、0 失败；3 项可选 Claude-Mem 和 1 项 Linux scanner 跳过 |
| 全量 HTTP/SDK 回归 | 259 项：253 通过、0 失败；6 项固定 Codex opt-in 测试未在本次重跑 |
| 前端测试 | 816 项通过，0 失败/跳过 |
| Web 类型与生产构建 | 通过，保留既有 chunk 大小提示 |
| ADK runtime boundary | 通过 |
| 标准签名 Dev 构建/安装、严格签名、干净来源 | 通过 |

新增回归验证默认召集只调用成员、不生成总结，即使调度容量为零也能结清；显式综合仍生成一条带请求来源的总结；配置失败不被代答；隐藏旧总结不改变输入快照及普通回复。测试基于真实 HTTP/SDK 和原生/ACP 混合夹具。

## 实际 Lake Dev

通过原生“停止内核并退出”停止旧 Dev，完整备份应用和 Home 到 `~/Library/Application Support/LakeDevBackups/dialogue-feedback-20261113-114402/`（0700），再执行 `scripts/build_lake_desktop.sh --dev --install`。使用安装包内后端和固定 `~/.lake-dev`，没有另起共享 Home 的后端。后端 SHA256：

`0c2a6ac4acc0566f4b45133ab420267d389b3d473de9a6890b9c04ebcbe45dd1`

原生窗口实际发送“全部干员给我报数！”。六名既有干员各自使用 Codex 独立会话返回简短编号/姓名/报到确认，轮次完成后只有一行“6 / 6 位干员已回应”。宿主 summaryRequested=false，无 summaryMessageId、总结模型 View 或总结消息。旧长总结仍在数据库中，实际主对话不再显示。

与本次安装前备份逐条比较，130 Goal、130 Worker、403 Operation、162 历史 acceptance 的 ID 和内容均完全一致。未创建业务任务或资源操作；所有六个新外部运行均 completed，无活动外部运行。见[来源与字体指标](conversation-feedback/evidence.json)。

已目视检查真实进行中的 3/6 状态、浅/深色 1280px 宽窗以及浅/深色 390×844 窄窗。过程字体实测 13px/450，正文 15px/500。窄窗 scrollWidth=innerWidth=390，末尾状态右边界 358px；干员身份、头像、Agent Logo、输入框和执行详情入口均保留。浏览器已关闭，原生 Lake Dev 保持在这轮新报数结果，草稿为空。

- [浅色进行中](conversation-feedback/light-running.png)
- [浅色完成](conversation-feedback/light-completed.png)
- [深色完成](conversation-feedback/dark-completed.png)
- [浅色窄窗](conversation-feedback/light-narrow.png)
- [深色窄窗](conversation-feedback/dark-narrow.png)

本次未改 ACP 工具桥、业务权限或本机 Codex 配置；没有重跑 Windows/Linux 桌面或真实业务资源操作。原集成 PR 继续指向 develop 并保持草稿，未授权合并或发布。回退前先停止 Dev，再成对恢复备份应用和 Home，不能在运行中的数据库上恢复。
