import type {GrafanaReadInput, GrafanaReadResult} from '../../web-agent/shared/contracts';
import {HttpError} from './store';
import {text} from './tasks';

type RequestGuard = () => void;
type JsonObject = Record<string, unknown>;
const maxResponseBytes = 2 * 1024 * 1024;
const maxQueryRange = 24 * 60 * 60 * 1000;
export function redactGrafanaJson(value:unknown, redact:(value:string)=>string, depth=0):unknown {
  if (depth > 32) throw new HttpError(502,'Grafana 响应嵌套过深');
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item=>redactGrafanaJson(item,redact,depth+1));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[redact(key),redactGrafanaJson(item,redact,depth+1)]));
  return value;
}
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'Grafana 返回的数据格式无效');
  return value as JsonObject;
};
const rows = (value: unknown) => {
  if (!Array.isArray(value)) throw new HttpError(502, 'Grafana 返回的列表格式无效');
  return value.map(object);
};
const string = (value: unknown) => typeof value === 'string' ? value : '';
const uid = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new HttpError(400, '请选择有效的 Grafana 对象');
  return value;
};
const path = {
  dashboards: '/api/search',
  datasources: '/api/datasources',
  rules: '/api/prometheus/grafana/api/v1/rules',
  alerts: '/api/alertmanager/grafana/api/v2/alerts',
  contactPoints: '/api/v1/provisioning/contact-points',
  contactPointTest: '/api/alertmanager/grafana/config/api/v1/receivers/test',
};

async function json(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'Grafana 返回了空响应');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxResponseBytes) throw new HttpError(413, 'Grafana 响应超过 2 MiB，请缩小查询范围');
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class GrafanaClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly signal: AbortSignal,
    private readonly guard: RequestGuard,
  ) {}

  private async request(route: string, parameters?: Record<string, string>, write?: {
    method: 'POST' | 'PUT'; body: JsonObject; requestTimeout?: string;
  }) {
    this.guard();
    this.signal.throwIfAborted();
    const target = new URL(this.endpoint + route);
    if (parameters) target.search = new URLSearchParams(parameters).toString();
    const probe = route === path.contactPointTest;
    try {
      const response = await fetch(target, {
        redirect: 'manual', signal: this.signal,
        headers: {Accept: 'application/json', Authorization: 'Bearer ' + this.token,
          ...(write ? {'Content-Type': 'application/json'} : {}),
          ...(write?.requestTimeout ? {'Request-Timeout': write.requestTimeout} : {})},
        ...(write ? {method: write.method, body: JSON.stringify(write.body)} : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new HttpError(401, 'Grafana 服务账号令牌无效或已过期');
        if (probe) {
          if (response.status === 403) throw new HttpError(403, '当前 Grafana 令牌缺少发送接入点测试通知的权限');
          if ([404, 405].includes(response.status)) throw new HttpError(409, '此 Grafana 不支持自动测试接入点，请使用 Lake 部署接收地址');
          throw new HttpError(409, 'Grafana 未能回调 Lake 的内网接收端口');
        }
        if (response.status === 403) {
          if (route.startsWith(path.contactPoints))
            throw new HttpError(403, `当前 Grafana 令牌缺少接入点${write ? '写入' : '读取'}权限，请在「编辑连接」使用有权限的令牌`);
          throw new HttpError(403, '该 Grafana 服务账号没有此项读取权限');
        }
        if (response.status === 404) throw new HttpError(404, 'Grafana 中未找到接口或资源，请核对地址、版本和权限');
        if (response.status >= 300 && response.status < 400)
          throw new HttpError(502, 'Grafana 地址发生重定向，请填写最终实例地址');
        if (write && response.status < 500)
          throw new HttpError(response.status, `Grafana 拒绝保存 Webhook 接入点（HTTP ${response.status}）`);
        throw new HttpError(502, write ? 'Grafana 写入结果待核实，请重新注入检查同一接入点' : `Grafana 查询失败（HTTP ${response.status}）`);
      }
      if (write) {
        await response.body?.cancel();
        this.guard();
        return;
      }
      const result: unknown = await json(response);
      this.guard();
      return result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (probe) throw new HttpError(408, 'Grafana 回调测试已取消或超时');
      if (write) throw new HttpError(502, 'Grafana 写入结果待核实，请重新注入检查同一接入点');
      if (this.signal.aborted) throw new HttpError(408, 'Grafana 请求已取消或超时');
      throw new HttpError(502, '无法读取 Grafana，请检查地址、网络和响应格式');
    }
  }

  async testContactPoint(url: string, token: string) {
    const name = 'Lake Webhook 连接测试';
    await this.request(path.contactPointTest, undefined, {
      method: 'POST',
      requestTimeout: '5',
      body: {
        receivers: [{
          name,
          grafana_managed_receiver_configs: [{
            name, type: 'webhook',
            settings: {url, httpMethod: 'POST', authorization_scheme: 'Bearer'},
            secureSettings: {authorization_credentials: token},
          }],
        }],
        alert: {labels: {alertname: 'LakeWebhookConnectivity'}},
      },
    });
  }

  async planContactPoint(uid: string, defaultName: string, ingressPath: string) {
    const points = rows(await this.request(path.contactPoints));
    const existing = points.find(point => point.uid === uid);
    const name = existing ? string(existing.name) : defaultName;
    if (existing) {
      const target = string(object(existing.settings).url);
      let matches = false;
      try { matches = new URL(target).pathname.endsWith(ingressPath); } catch { /* not a Lake destination */ }
      if (existing.type !== 'webhook' || !matches)
        throw new HttpError(409, 'Grafana 中的同标识接入点不属于此 Lake 来源');
    }
    if (!name || points.some(point => point.uid !== uid && point.name === name))
      throw new HttpError(409, 'Grafana 中的接入点名称无效或与其他接入点冲突');
    return {name, existing: !!existing};
  }

  async provisionContactPoint(uid: string, name: string, url: string, credential: string, existing: boolean) {
    await this.request(path.contactPoints + (existing ? '/' + uid : ''), undefined, {
      method: existing ? 'PUT' : 'POST',
      body: {uid, name, type: 'webhook', disableResolveMessage: false,
        settings: {url, httpMethod: 'POST', authorization_scheme: 'Bearer', authorization_credentials: credential}},
    });
    const points = rows(await this.request(path.contactPoints));
    const saved = points.find(point => point.uid === uid);
    if (!saved || saved.name !== name || saved.type !== 'webhook' || object(saved.settings).url !== url)
      throw new HttpError(502, 'Grafana 写入结果待核实，请重新注入检查同一接入点');
  }

  async test() {
    const org = object(await this.request('/api/org'));
    const testRead = async (name: string, check: () => Promise<unknown>) => {
      try { await check(); return name + '可读'; }
      catch (error) {
        if (this.signal.aborted) throw error;
        return name + (error instanceof HttpError && [401,403].includes(error.status) ? '权限不足' : '暂不可读');
      }
    };
    const statuses = await Promise.all([
      testRead('仪表盘', async () => rows(await this.request(path.dashboards, {type:'dash-db', limit:'1'}))),
      testRead('数据源', async () => rows(await this.request(path.datasources))),
      testRead('告警规则', () => this.request(path.rules)),
      testRead('活动告警', async () => rows(await this.request(path.alerts))),
    ]);
    return '服务账号认证通过' + (string(org.name) ? ' · ' + string(org.name).slice(0,100) : '') + '。' + statuses.join('，') + '。指标和日志权限在实际查询时核验。';
  }

  async read(input: GrafanaReadInput): Promise<GrafanaReadResult> {
    const {operation} = input;
    switch (operation) {
      case 'folders':
      case 'dashboards': {
        const page = input.page ?? 1;
        if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, 'Grafana 目录页码无效');
        const type = operation === 'folders' ? 'dash-folder' : 'dash-db';
        const query = input.search === undefined || input.search === '' ? '' : text(input.search, 'Grafana 搜索词', 256);
        const entries = rows(await this.request(path.dashboards, {type, page:String(page), limit:'50', query}));
        const items = entries.map(entry => ({uid:string(entry.uid), title:string(entry.title), folderTitle:string(entry.folderTitle)}));
        return {operation, items, nextPage:items.length === 50 ? page + 1 : undefined};
      }
      case 'dashboard':
        return {operation, data:object(await this.request('/api/dashboards/uid/' + uid(input.uid)))};
      case 'datasources':
        return {operation, items:rows(await this.request(path.datasources)).map(entry => ({
          uid:string(entry.uid), name:string(entry.name), type:string(entry.type),
        }))};
      case 'rules':
        return {operation, data:object(await this.request(path.rules))};
      case 'alerts':
        return {operation, data:rows(await this.request(path.alerts))};
      case 'metrics':
      case 'logs':
        return {operation, data:await this.query(input)};
      default:
        throw new HttpError(400, '不支持此 Grafana 查询');
    }
  }

  private async query(input: Extract<GrafanaReadInput, {operation:'metrics'|'logs'}>) {
    const sourceId = uid(input.datasourceUid);
    const query = text(input.expression, 'Grafana 查询表达式', 8192);
    const {start, end} = input;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > maxQueryRange)
      throw new HttpError(400, '请选择有效的时间范围，单次最多查询 24 小时');
    const datasource = object(await this.request('/api/datasources/uid/' + sourceId));
    const logs = input.operation === 'logs';
    const supported = logs ? ['loki'] : ['prometheus', 'victoriametrics-metrics-datasource'];
    if (datasource.uid !== sourceId || !supported.includes(string(datasource.type)))
      throw new HttpError(400, logs ? '请选择 Loki 数据源' : '请选择 Prometheus 或兼容数据源');
    const base = '/api/datasources/proxy/uid/' + sourceId;
    const params: Record<string,string> = logs ? {
      query, start:String(BigInt(start) * 1000000n), end:String(BigInt(end) * 1000000n), limit:'200', direction:'backward',
    } : {query, start:String(start / 1000), end:String(end / 1000), step:String(Math.max(1,Math.ceil((end - start) / 600000)))};
    const result = object(await this.request(base + (logs ? '/loki/api/v1/query_range' : '/api/v1/query_range'), params));
    if (result.status !== 'success') throw new HttpError(502, '数据源未返回成功的查询结果');
    return result;
  }
}
