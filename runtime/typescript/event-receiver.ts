import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { GrafanaDelivery, GrafanaDeliveryDetail, GrafanaDeliveryPage, LakeEventSource, LakeEventSourceResult } from '../../web-agent/shared/contracts';
import { HttpError, id, LakeStore, now } from './store';

type Source = Omit<LakeEventSource, 'webhookUrl' | 'lastReceivedAt'> & {credentialHash: string};
const sourceKind = 'eventSources';
const bodyLimit = 1024 * 1024;
const deliveryColumns = 'id, received_at, status, title, alert_count, truncated_alerts';

const hash = (value: string) => createHash('sha256').update(value).digest();
const issueToken = () => 'lake_event_' + randomBytes(32).toString('hex');
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStatus = (value: unknown): value is GrafanaDelivery['status'] => value === 'firing' || value === 'resolved';

async function readPayload(request: IncomingMessage): Promise<unknown> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  const encoding = request.headers['content-encoding'];
  if (mediaType !== 'application/json' || (encoding && encoding.toLowerCase() !== 'identity'))
    throw new HttpError(415, 'Grafana Webhook 需要未压缩的 application/json');
  if (Number(request.headers['content-length']) > bodyLimit)
    throw new HttpError(413, 'Grafana 通知超过 1 MiB');

  const chunks: Buffer[] = [];
  let bytes = 0;
  const deadline = setTimeout(() => request.destroy(), 10_000).unref();
  try {
    for await (const chunk of request.iterator({destroyOnReturn: false})) {
      bytes += chunk.length;
      if (bytes > bodyLimit) throw new HttpError(413, 'Grafana 通知超过 1 MiB');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Grafana 通知不是完整的 UTF-8 JSON');
  } finally {
    clearTimeout(deadline);
  }
}

function scrubJSON(value: unknown, scrub: (value: string) => string, depth = 0): unknown {
  if (depth > 16) throw new HttpError(400, 'Grafana 通知的 JSON 层级过深');
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new HttpError(400, 'Grafana 通知包含超出范围的数字');
  if (Array.isArray(value)) return value.map(item => scrubJSON(item, scrub, depth + 1));
  if (isObject(value)) return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [scrub(key), scrubJSON(item, scrub, depth + 1)]),
  );
  return value;
}

function deliveryView(row: Record<string, unknown>): GrafanaDelivery {
  return {
    id: String(row.id),
    receivedAt: String(row.received_at),
    status: row.status as GrafanaDelivery['status'],
    title: String(row.title),
    alertCount: Number(row.alert_count),
    ...(row.truncated_alerts == null ? {} : {truncatedAlerts: Number(row.truncated_alerts)}),
  };
}

/** The inbox owns deliveries only. It has no message, model or task interfaces. */
export class LakeEventReceiver {
  constructor(
    private readonly store: LakeStore,
    private readonly security: {check(): void},
    private readonly redact: (value: string) => string,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS event_deliveries (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, alert_count INTEGER NOT NULL, truncated_alerts INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_by_source ON event_deliveries(source_id, seq DESC);
    `);
  }

  private scrub(value: string) {
    return this.redact(value.replace(/lake_event_[0-9a-f]{64}/gi, '[REDACTED]'));
  }

  private source(sourceId: string) {
    const source = this.store.require<Source>(sourceKind, sourceId);
    this.store.project(source.projectId);
    return source;
  }

  private view(source: Source, origin: string): LakeEventSource {
    const latest = this.store.db.prepare(
      'SELECT received_at FROM event_deliveries WHERE source_id=? ORDER BY seq DESC LIMIT 1',
    ).get(source.id);
    return {
      id: source.id, kind: source.kind, name: source.name, projectId: source.projectId,
      enabled: source.enabled, revision: source.revision,
      webhookUrl: origin + '/api/ingress/v1/grafana/' + source.id,
      ...(latest ? {lastReceivedAt: String(latest.received_at)} : {}),
    };
  }

  list(projectIds: readonly string[], origin: string) {
    const allowed = new Set(projectIds);
    return this.store.list<Source>(sourceKind)
      .filter(source => allowed.has(source.projectId))
      .map(source => this.view(source, origin));
  }

  create(input: Record<string, unknown>, origin: string): LakeEventSourceResult {
    this.security.check();
    const {name, projectId} = input;
    if (Object.keys(input).some(key => !['name', 'projectId'].includes(key)) ||
        typeof name !== 'string' || !name.trim() || name.length > 120 ||
        /[\x00-\x1f\x7f]/.test(name) || this.scrub(name) !== name ||
        typeof projectId !== 'string' || !projectId)
      throw new HttpError(400, 'Grafana 来源名称或所属项目无效');
    this.store.project(projectId);
    const token = issueToken();
    const sourceId = id();
    const source = this.store.put<Source>(sourceKind, sourceId, {
      id: sourceId, kind: 'grafana', name: name.trim(), projectId,
      enabled: true, revision: 1, credentialHash: hash(token).toString('hex'),
    });
    return {source: this.view(source, origin), token};
  }

  update(sourceId: string, input: Record<string, unknown>, origin: string): LakeEventSourceResult {
    this.security.check();
    const current = this.source(sourceId);
    const {expectedRevision, enabled, rotateCredential} = input;
    const toggling = typeof enabled === 'boolean' && rotateCredential === undefined;
    const rotating = enabled === undefined && rotateCredential === true;
    if ((!toggling && !rotating) || !Number.isSafeInteger(expectedRevision) ||
        Object.keys(input).some(key => !['expectedRevision', 'enabled', 'rotateCredential'].includes(key)))
      throw new HttpError(400, 'Grafana 来源更新字段无效');
    if (current.revision !== expectedRevision) throw new HttpError(409, '来源配置已变化，请刷新后重试');
    const token = rotating ? issueToken() : undefined;
    const updated = this.store.put(sourceKind, sourceId, {
      ...current,
      enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
      credentialHash: token ? hash(token).toString('hex') : current.credentialHash,
      revision: current.revision + 1,
    });
    return {source: this.view(updated, origin), ...(token ? {token} : {})};
  }

  private authenticate(sourceId: string, request: IncomingMessage) {
    const authorization = request.headersDistinct.authorization;
    const match = authorization?.length === 1 && /^Bearer (lake_event_[0-9a-f]{64})$/i.exec(authorization[0]!);
    const source = match && this.store.get<Source>(sourceKind, sourceId);
    const expected = source ? Buffer.from(source.credentialHash, 'hex') : undefined;
    if (!match || !source || !expected || expected.length !== 32 ||
        !timingSafeEqual(expected, hash(match[1]!)))
      throw new HttpError(401, '需要此来源的 Grafana Webhook 凭据');
    if (!source.enabled) throw new HttpError(403, 'Grafana 来源已停用');
    this.store.project(source.projectId);
    this.security.check();
    return source;
  }

  async receive(sourceId: string, request: IncomingMessage, isStopping: () => boolean) {
    const origin = this.authenticate(sourceId, request);
    const payload = await readPayload(request);
    if (!isObject(payload) || payload.version !== '1' || !isStatus(payload.status) ||
        !Array.isArray(payload.alerts) || !payload.alerts.length ||
        !payload.alerts.every(alert => isObject(alert) && isStatus(alert.status)))
      throw new HttpError(400, '需要 Grafana 默认 Webhook JSON v1 及逐条告警状态');
    const truncated = payload.truncatedAlerts;
    if (truncated !== undefined && (typeof truncated !== 'number' || !Number.isSafeInteger(truncated) || truncated < 0))
      throw new HttpError(400, 'Grafana 通知的截断数量无效');
    const {status, alerts} = payload;
    const firstLabels = alerts[0].labels;
    const title = this.scrub(
      (typeof payload.title === 'string' && payload.title.trim()) ||
      (isObject(firstLabels) && typeof firstLabels.alertname === 'string' && firstLabels.alertname.trim()) ||
      'Grafana 告警通知',
    ).slice(0, 200);
    const data = JSON.stringify(scrubJSON(payload, value => this.scrub(value)));
    if (Buffer.byteLength(data) > bodyLimit) throw new HttpError(413, 'Grafana 通知超过 1 MiB');
    if (isStopping()) throw new HttpError(503, 'Lake 正在退出');
    const receipt = {id: id(), receivedAt: now()};
    return this.store.transaction(() => {
      const current = this.authenticate(sourceId, request);
      if (current.revision !== origin.revision) throw new HttpError(409, '来源配置已变化，请重新投递');
      this.store.db.prepare(
        `INSERT INTO event_deliveries
         (id, source_id, received_at, status, title, alert_count, truncated_alerts, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(receipt.id, sourceId, receipt.receivedAt, status, title, alerts.length, (truncated as number | undefined) ?? null, data);
      return receipt;
    });
  }

  deliveries(sourceId: string, limit: number, cursor?: string): GrafanaDeliveryPage {
    this.source(sourceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new HttpError(400, '每页须为 1 至 50 条投递');
    let rows;
    if (cursor === undefined) {
      rows = this.store.db.prepare(
        `SELECT ${deliveryColumns} FROM event_deliveries WHERE source_id=? ORDER BY seq DESC LIMIT ?`,
      ).all(sourceId, limit + 1);
    } else {
      const point = this.store.db.prepare(
        'SELECT seq FROM event_deliveries WHERE source_id=? AND id=?',
      ).get(sourceId, cursor);
      if (!point || typeof point.seq !== 'number') throw new HttpError(400, '无效的投递分页位置');
      rows = this.store.db.prepare(
        `SELECT ${deliveryColumns} FROM event_deliveries WHERE source_id=? AND seq<? ORDER BY seq DESC LIMIT ?`,
      ).all(sourceId, point.seq, limit + 1);
    }
    const deliveries = rows.slice(0, limit).map(deliveryView);
    return {deliveries, ...(rows.length > limit ? {nextCursor: deliveries.at(-1)!.id} : {})};
  }

  delivery(sourceId: string, deliveryId: string): GrafanaDeliveryDetail {
    this.source(sourceId);
    const row = this.store.db.prepare(
      `SELECT ${deliveryColumns}, payload FROM event_deliveries WHERE source_id=? AND id=?`,
    ).get(sourceId, deliveryId);
    if (!row) throw new HttpError(404, '此来源未收到该投递');
    return {...deliveryView(row), payload: JSON.parse(String(row.payload))};
  }
}
