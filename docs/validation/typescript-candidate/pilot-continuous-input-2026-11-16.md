# Pilot 持续接单与准确来源验收

用户在 A 执行期间继续发送 B，B 可以创建独立任务、补充原任务，或同时安排同一/不同专员的多项工作。原调用继续，Router 按来源顺序协调，补充沿准确旧 Task/Worker 的安全续接边界处理。不是把整个项目等空闲后再接单，也不把仅已记录的补充当成模型已消费。

## 提交与本地检查

- 产品、协议、回归与验收 fixture 提交：`5395e43fdde0579b46428a97f58b6b82f9f7e994`。
- 签名安装 Lake Dev：同一提交，`dirty=false`，0.3.33 / TypeScript。之后只追加本验收文档与合成证据。
- 前端 TypeScript 检查通过；全量前端 **948/948**。
- 后端 TypeScript 检查通过；源代码回归 **334 通过 / 4 跳过**，打包后协议回归 **280 通过 / 6 跳过**，共 **614 通过 / 10 跳过**。跳过项沿用真实 Codex、Claude-Mem 和 Linux 平台门控，没有用模拟测试冒充其通过。
- Web、后端和原生构建、`scripts/build_lake_desktop.sh --dev --install`、`codesign --verify --deep --strict`、ADK 边界检查与 `git diff --check` 通过。

## 接单与归属

TypeScript Pilot 的普通发送立即保存真实用户消息和 `superInputs`，不因 Router 忙碌或旧待发送草稿而转为可编辑队列。显式排队仍可用；暂停的旧草稿不自动发送。Router 每轮只处理一个来源，后台 Worker 仍使用原有全局/项目并发上限。

新目标创建独立 Task/Worker/Session；同一 RoleID 也可以同时持有不同任务。一项共同交付可以分配多个角色。旧任务补充记录准确 Task 与角色，保留期限、范围、历史和原调用；尚未被当前执行读取的补充阻止旧报告抢先结清，再由同一任务续接处理。没有新增模型循环，也没有把整段对话广播给所有 Worker。

Router 把真实来源消息交给现有 SDK 入口；运行视图、公开卡片和最终消息保留来源。Pilot 针对 A 的回复在 B 到达之后继续输出时，其正文、思考/工具过程和最终答复仍归 A。每轮用时保存真实起止，不以 B 的提交时间截短 A 的过程；重启保留已完成用时，将未结记录标为中断，不恢复或重放模型请求。

回归覆盖：忙碌期间 B/C 的持久接单、来源 FIFO、同角色独立任务、旧任务续接、一条消息混合补充和多人新任务、多任务分别接收同一补充、旧草稿保持暂停、SSE 首包来源、最终副本去重、分页恢复、旧记录回退、用时范围及结算空档中的冷恢复。

## 浏览器

真实 `App` 使用隔离内存 transport，保留一条暂停的旧草稿。分别在 1440×1000 浅色、1100×700 深色、390×844 深色操作真实输入框与发送键，共发送 B、C 六次。

- 普通消息没有 `enqueue:true`，直接出现在主会话；停止请求数为 0。
- A 的发言、正文及输入框节点保持原对象；A 的公开进度始终只有一份。
- B 开始回复后，C 仍可发送；A/B 各留在自己的来源消息下面。
- 旧草稿仍在暂停队列，输入框显示新任务/补充提示；没有横向溢出。

证据：[发送与节点数据](pilot-continuous-input/browser.json)、[浅色桌面](pilot-continuous-input/browser-light.png)、[深色桌面](pilot-continuous-input/browser-dark.png)、[深色窄窗口](pilot-continuous-input/browser-narrow.png)。

## 真实接口与 SDK

隔离 HTTP 回归持有 A 的真实 SDK 模型请求，再发送 B/C。两条都立即得到真实消息 ID，A 仍保持原请求；暂停的旧草稿不被新发送带走。释放 A 后，A、B、C 分别进入三次准确来源的协调轮次，每个来源只有一份正式答复与自己的完整用时。重启后这些关联保留，旧草稿仍暂停，没有重复模型请求。

本机 SQLite 与真实 Host 的回归另外验证同一角色的 A/B 同时执行，C 只进入指定旧任务；一条消息可以同时补充 A 并创建两位专员的共同任务。补充跨过完成边界后，原 Task/Worker 不变，下一次执行读取准确补充；原角色的其他任务不受影响，没有取消调用或将 SDK 队列回执当成实际消费。

## 签名 Lake Dev

使用独立临时 Home/Web data、两位 Native 专员和确定性回环模型，未接入业务资源或真实模型服务。

1. A 开始并持有模型流。在原生输入框发送 B，同一水獭专员出现“2 项执行中”。A/B 的 Task、Worker、Session 各自独立，原 A 请求仍存活。
2. 在原生输入框发送 C：“给 A 补充日志；再请水獭和猫头鹰共同整理 C”。原 A/B 继续，两位 C 参与者共享一个公共任务、各有自己的执行实例，按原项目容量等待空位。
3. 释放已有调用。A 第一段的结束被宿主保留为待续接，未交付旧结论；A 在同一 Task、Worker、Session 和原期限内启动第二次执行，准确读取一条 C 补充。B 只有一次执行，未收到 C 的旧任务补充。
4. 四位 Worker 均完成。A 最终只有一份正式报告，明确包含补充要求；B 独立交付，C 的两位专员分别提交自己的报告。报告与当前实际 SDK root 相符。
5. 从 A 的报告打开“执行过程”，标题仍为原“独立样例 A”，四条思考/公开记录保留。Pilot 的四条人工来源各有一份准确协调答复和已结束用时。

证据：[构建、前后任务和实际调用数据](pilot-continuous-input/native-proof.json)、[A/B 并行](pilot-continuous-input/native-b.png)、[补充与多人任务](pilot-continuous-input/native-c.png)、[包含补充的结论](pilot-continuous-input/native-completed.png)、[原 A 过程](pilot-continuous-input/native-process.png)。

浏览器、Vite、临时任务和隔离原生内核已结束。已恢复日常 Lake Dev 原 Pilot 会话和 gpt-6.1-sol，日常数据/凭据未复制进测试 Home，正式版 Lake 未操作。

## 范围与限制

新增兼容的来源与用时字段，不改数据库表结构，不迁移或重写旧报告。旧数据缺少来源时保留原时间顺序回退。快速连发的消息由同一 Router 顺序协调；不承诺并行运行多个 Pilot 推理。补充在原任务安全续接边界消费，不宣称已即时插入正在执行的工具或外部 Agent。

真实 Native 与本机 UI 已验证；真实 Codex/Claude-Mem 及 Windows/Linux 原生本轮未运行。普通 develop PR 无自动 CI。尚未合并、发布或操作生产。
