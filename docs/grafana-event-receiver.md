# 接收 Grafana 告警

在 Lake 的「设置 → 接入渠道 → 添加连接」选择「Grafana Webhook」，填写名称并绑定项目。创建后复制本机 Webhook 地址和凭据。凭据仅在创建或重新生成时显示。需要更换项目时新建连接。凭据遗失时可以重新生成，并更新 Grafana 的配置。

在 Grafana 的「Alerting → Contact points」使用内置的 Grafana Alertmanager，点击「Add contact point」，将 Integration 设为 **Webhook**。 [Grafana 11.1 接入点说明](https://archive.grafana.com/docs/grafana/v11.1/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/)

| Grafana 设置 | 填写内容 |
| --- | --- |
| URL | Grafana 所在进程能访问的 Lake Webhook 地址 |
| HTTP Method | `POST` |
| Authorization Header - Scheme | `Bearer` |
| Authorization Header - Credentials | Lake 生成的凭据本身 |
| Disable resolved message | 关闭，接收恢复通知 |
| 通知内容 | 默认 JSON |

点击「Test → Send test notification」，在 Lake 的该连接下查看「接收记录」。展开一条记录可核对批次里的每条告警、状态、标签、详情和时间。测试成功后，可在试点告警规则的 Notifications 中选择该接入点，也可在 Notification policies 中用标签匹配指定通知。 [Grafana 11.1 通知策略](https://archive.grafana.com/docs/grafana/v11.1/alerting/fundamentals/notifications/notification-policies/)

Lake 页面显示的 `localhost` 地址适用于能访问同一回环接口的 Grafana。远端或容器 Grafana 需要另外配置可达地址。桌面 Lake 重启后可能分配新端口。需要固定本机端口进行调试时，按开发规范构建签名的 TypeScript 后端，并使用独立 Home 和空闲端口。 [Lake 开发规范](../CONTRIBUTING.md)

```sh
bin/lake web --dev --home "$HOME/.lake-grafana-dev" --port 4182
```

每次有效请求保存一条投递。不同投递可包含同一告警。列表的「触发通知」「恢复通知」来自 Grafana 批次状态，批次中各告警的原始状态也会保留。Lake 完成 SQLite 提交后返回 HTTP 200，响应提供 `id` 和 `receivedAt`。本期链路到接收记录为止。

如果收件失败，先确认 Grafana 进程能访问该地址。HTTP 401 对应来源凭据错误，403 对应来源停用，400 对应通知格式不匹配，413 对应请求超过 1 MiB。遇到超时或存储失败时应依据 Grafana 发送结果和 Lake 收件记录核对实际投递。

接口适配依据为 Grafana 11.1.4 固定依赖中的 Webhook 配置和发送逻辑。 [认证字段](https://github.com/grafana/alerting/blob/02e012d6dd7f/receivers/webhook/config.go) · [通知发送](https://github.com/grafana/alerting/blob/02e012d6dd7f/receivers/webhook/webhook.go)
