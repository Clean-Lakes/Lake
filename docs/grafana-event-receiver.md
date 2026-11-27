# 接入 Grafana

## 读取 Grafana

打开目标项目的「资源 → 新建资源」，选择「Grafana」，填写资源名称、Grafana 基础地址和该组织的服务账号令牌。地址可包括反向代理子路径。点击「测试连接」可看到组织以及仪表盘、数据源、告警规则和活动告警接口的读取结果。Lake 将令牌保存在本机私有凭据目录，编辑时可留空保留当前地址的令牌。更换地址时填写对应服务账号的令牌。

打开资源详情时，Lake 自动读取仪表盘、目录、数据源、告警规则和活动告警的概览。点击「活动告警」可在当前页展开告警列表。「打开 Grafana」使用资源已保存的地址。资源详情与侧栏资源的「…」菜单均可打开「编辑连接」。已保存的服务账号令牌默认遮挡。点击眼睛图标可查看或隐藏令牌，关闭窗口或更改地址会恢复遮挡。更新令牌一栏留空时沿用当前地址的令牌。针对具体指标和日志，在对话中引用该资源即可按时间范围查询 Prometheus、兼容的 VictoriaMetrics 或 Loki。每次查询最长 24 小时，单次日志最多返回 200 条。数据范围由服务账号、所属组织、数据源权限和历史保留期决定。

配置后可在项目会话用 `@` 引用 Grafana 资源，让 Pilot 或项目专员按当前 Lake 权限读取相同数据。已有告警收件资源可从详情的「配置连接」补填，资源 ID、接收凭据和投递记录随原资源保留。

从旧版迁移的项目若原本自动继承项目目录，新增 Grafana 可沿用该继承策略执行只读查询。Lake 会核对当前策略与当时生成策略的宿主记录。手动限定的资源范围和读取规则继续生效。

## 接收 Grafana 告警

打开 Grafana 资源详情，点击「Grafana Webhook → 注入配置」。Lake 使用已保存的 Grafana 地址和服务账号令牌，通过 API 配置内置 Alertmanager 的接入点。Lake 自动生成接入点名称和 Webhook 凭据，并使用部署提供的接收地址。服务账号需要该组织的接入点读取和写入权限，权限不足时从「编辑连接」使用有对应权限的令牌。 [Grafana 告警权限](https://grafana.com/docs/grafana/latest/alerting/set-up/configure-roles/)

重新注入会更新同一个接入点。Lake 从 Grafana 读回配置后显示「已接入」。接收地址、重新注入与手动接入集中在「接入详情」。告警规则或通知策略选用该接入点后，可在资源详情按本地日期和接收时间查看投递，展开可核对告警条数、状态、标签和原始通知。 [Grafana 11.1.4 接入点预配 API](https://github.com/grafana/grafana/blob/v11.1.4/pkg/services/ngalert/api/api_provisioning.go)

在可互通的内网，Lake 根据到 Grafana 的网络路径选择本机地址，启动只接收 Grafana Webhook 的端口，并通过 Grafana 的测试 API 验证回调。验证成功后写入接入点。Lake 重启会恢复已登记的监听地址和端口。本机地址变更或原端口被占用时，重新注入会验证新地址并更新同一个接入点。

使用独立入口的部署可以为 Lake 后端进程设置 `LAKE_GRAFANA_RECEIVER_BASE_URL`，值为 Grafana 所在进程可访问的稳定 HTTP(S) 基础地址，可以包含代理子路径。将该地址下的 `/api/ingress/v1/grafana/` 转发给 Lake 接收端。既有反向代理接入可继续沿用已保存的地址。

### 手动接入

「手动接入」仍可生成和复制单独的手动凭据。手动凭据仅在生成或重新生成时显示。

接收配置和投递记录绑定资源 ID。改名或移动目录会保留原配置和记录。资源或所属项目在回收站期间，接收入口暂停。恢复资源后可继续使用原配置。早期的独立 Grafana 来源沿用原接收配置，新接入从资源详情配置。

在 Grafana 的「Alerting → Contact points」使用内置的 Grafana Alertmanager，点击「Add contact point」，将 Integration 设为 **Webhook**。 [Grafana 11.1 接入点说明](https://archive.grafana.com/docs/grafana/v11.1/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/)

| Grafana 设置 | 填写内容 |
| --- | --- |
| URL | Grafana 所在进程能访问的 Lake Webhook 地址 |
| HTTP Method | `POST` |
| Authorization Header - Scheme | `Bearer` |
| Authorization Header - Credentials | Lake 生成的凭据本身 |
| Disable resolved message | 关闭，接收恢复通知 |
| 通知内容 | 默认 JSON |

点击「Test → Send test notification」，在 Lake 的 Grafana 资源详情中查看「接收记录」。展开一条记录可核对批次里的每条告警、状态、标签、详情和时间。测试成功后，可在试点告警规则的 Notifications 中选择该接入点，也可在 Notification policies 中用标签匹配指定通知。 [Grafana 11.1 通知策略](https://archive.grafana.com/docs/grafana/v11.1/alerting/fundamentals/notifications/notification-policies/)

Lake 页面显示的 `localhost` 地址适用于能访问同一回环接口的 Grafana。远端或容器 Grafana 需要另外配置可达地址。桌面 Lake 重启后可能分配新端口。需要固定本机端口进行调试时，按开发规范构建签名的 TypeScript 后端，并使用独立 Home 和空闲端口。 [Lake 开发规范](../CONTRIBUTING.md)

```sh
bin/lake web --dev --home "$HOME/.lake-grafana-dev" --port 4182
```

每次有效请求保存一条投递。不同投递可包含同一告警。列表的「触发通知」「恢复通知」来自 Grafana 批次状态，批次中各告警的原始状态也会保留。Lake 完成 SQLite 提交后返回 HTTP 200，响应提供 `id` 和 `receivedAt`。本期链路到接收记录为止。

如果收件失败，先确认 Grafana 进程能访问该地址。HTTP 401 对应来源凭据错误，403 对应来源停用，400 对应通知格式不匹配，413 对应请求超过 1 MiB。遇到超时或存储失败时应依据 Grafana 发送结果和 Lake 收件记录核对实际投递。

接口适配依据为 Grafana 11.1.4 固定依赖中的 Webhook 配置和发送逻辑。 [认证字段](https://github.com/grafana/alerting/blob/02e012d6dd7f/receivers/webhook/config.go) · [通知发送](https://github.com/grafana/alerting/blob/02e012d6dd7f/receivers/webhook/webhook.go)
