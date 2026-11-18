import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createDecipheriv} from 'node:crypto';
import {isIP} from 'node:net';
import {readHexHubLocalAssets} from './hexhub-storage';
import {HttpError} from './store';

export type ImportRecord = Record<string, any>;
export type HexHubImportOptions = {endpoint?: string; userHome?: string};
export function importFolder(value: unknown) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, '资源目录格式无效');
  const parts = value.replaceAll('\\', '/').split('/').map(part=>part.trim()).filter(Boolean);
  if (parts.length > 32 || parts.some(part => part === '.' || part === '..' || [...part].length > 120 || /[\0\r\n]/.test(part))) throw new HttpError(400, '资源目录无效或超过 32 层');
  return parts.join('/');
}
export function importDriver(value: unknown) {
  const driver = String(value ?? '').trim().toLowerCase();
  return ({mariadb:'mysql', starrocks:'mysql', doris:'mysql', postgresql:'postgres', pg:'postgres', sqlite3:'sqlite'} as Record<string,string>)[driver] ?? driver;
}
function dataRecord(value: unknown): ImportRecord | undefined {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return result && typeof result === 'object' && !Array.isArray(result) ? result as ImportRecord : undefined; } catch { return; }
}
function hostPort(value: unknown, fallback: number) {
  const raw = String(value ?? '').trim();
  if (isIP(raw)) return {host:raw, port:fallback};
  try { const url = new URL('tcp://' + raw); if (url.username || url.password || url.search || url.hash || url.pathname && url.pathname !== '/') throw new Error(); return {host:url.hostname.replace(/^\[|\]$/g, ''), port:url.port ? Number(url.port) : fallback}; }
  catch { return {host:raw, port:fallback}; }
}
export function hexHubMetadata(asset: ImportRecord): ImportRecord {
  const type = String(asset.type??'').toLowerCase(),kind = type === 'ssh' ? 'ssh' : type === 'db' ? 'database' : type === 'redis' ? 'redis' : type;
  const driver = kind === 'database' ? importDriver(asset.db_type) : '';
  const record: ImportRecord = {name:asset.name, folder:importFolder(asset.path), kind, ...hostPort(asset.host, kind === 'ssh' ? 22 : kind === 'redis' ? 6379 : driver === 'postgres' ? 5432 : 3306)};
  if (kind === 'database') Object.assign(record, {driver, tls:false, sslmode:'disable'});
  if (kind === 'redis') Object.assign(record, {tls:false, db:0});
  if (!['ssh','database','redis'].includes(kind)) record.importError = '该 HexHub 资产类型暂不支持导入';
  if (asset.jump_asset_ref || asset.ssh_asset_ref) record.importError = '当前导入不支持跳板、代理或数据库 SSH 隧道';
  return record;
}
function localMetadata(item: ImportRecord): ImportRecord | undefined {
  const value = dataRecord(item.data), type = Number(item.type); if (!value || ![2,4,15].includes(type)) return;
  const kind = type === 2 ? 'ssh' : type === 4 ? 'database' : 'redis', driver = type === 4 ? ({0:'mysql', 1:'postgres', 17:'mysql'} as Record<number,string>)[value.dbType] ?? '' : '';
  return {name:item.name, folder:importFolder(item.dirPath), kind, ...(driver ? {driver} : {}), host:value.host, port:value.port ?? (kind === 'ssh' ? 22 : kind === 'redis' ? 6379 : driver === 'postgres' ? 5432 : 3306)};
}
export function hexHubIdentity(record: ImportRecord) {
  return JSON.stringify([record.name, importFolder(record.folder), record.kind, importDriver(record.driver), String(record.host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, ''), Number(record.port)]);
}
function decodeSecret(value: unknown) {
  if (value == null || value === '') return '';
  try {
    if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) throw new Error();
    const bytes = Buffer.from(value, 'base64'); if (!bytes.length || bytes.length % 16 || bytes.toString('base64') !== value) throw new Error();
    // Public HexHub export compatibility constants, not user credentials.
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from('CsN#&Uc!aOUQbh&B'), Buffer.from('w6KQ^MPlEx*mfHcb'));
    return new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat([decipher.update(bytes), decipher.final()]));
  } catch { throw new HttpError(400, 'HexHub 登录信息无法解码，请在 HexHub 中检查此连接'); }
}
export function hexHubLogin(item: ImportRecord, references: Map<string, ImportRecord>): ImportRecord {
  const record = localMetadata(item); if (!record) throw new HttpError(400, 'HexHub 连接配置格式无效');
  const value = dataRecord(item.data)!;
  try {
    record.username = value.user;
    if (record.kind === 'ssh') {
      record.username ??= 'root';
      if (Number(value.proxy?.method ?? 0) !== 0) throw new Error('proxy');
      if (Number(value.authType ?? 0) === 0) Object.assign(record, {authMethod:'password', password:decodeSecret(value.password)});
      else if (Number(value.authType) === 1) {
        let saved: ImportRecord = value;
        if (value.privateKeyId) {
          const reference = references.get(String(value.privateKeyId));
          if (!reference || Number(reference.type) !== 1 || !dataRecord(reference.data)) throw new Error('reference');
          saved = dataRecord(reference.data)!;
        }
        const decoded = decodeSecret(saved.privateKey), pair = dataRecord(decoded);
        const key = pair ? pair.privateKey : decoded;
        if (typeof key !== 'string' || !key) throw new Error('key');
        Object.assign(record, {authMethod:'key', privateKey:key, passphrase:saved.password !== undefined ? decodeSecret(saved.password) : pair?.password ?? ''});
      } else if (Number(value.authType) === 5) {
        const reference = references.get(String(value.passwordPairId)), pair = reference && Number(reference.type) === 19 ? dataRecord(reference.data) : undefined;
        if (!pair || typeof pair.username !== 'string' || typeof pair.password !== 'string') throw new Error('reference');
        Object.assign(record, {username:pair.username, password:pair.password, authMethod:'password'});
      } else throw new Error('auth');
    } else if (record.kind === 'database') {
      if (value.enableSsh !== undefined && value.enableSsh !== false && value.enableSsh !== 0) throw new Error('proxy');
      if (Number(value.sslConfig?.mode ?? 0) !== 0) throw new Error('tls');
      Object.assign(record, {database:value.defaultDb ?? value.database ?? '', password:value.password ?? '', tls:false, sslmode:'disable'});
    } else {
      if (Number(value.mode ?? 0) !== 0) throw new Error('redis');
      Object.assign(record, {password:value.password ?? '', tls:Number(value.sslConfig?.mode ?? 0) !== 0, db:value.db ?? 0});
    }
  } catch (error) {
    record.importError = error instanceof HttpError ? error.message : error instanceof Error && error.message === 'tls' ? '请在 Lake 中配置此连接的 TLS 证书' : 'HexHub 登录方式、引用或代理配置不受支持，请在 HexHub 中检查此连接';
    for (const key of ['password','passphrase','privateKey']) delete record[key];
  }
  return record;
}
export function joinHexHubLogins(assets: ImportRecord[], local: ImportRecord[]) {
  const references = new Map<string, ImportRecord>();
  for (const row of local) { if(row.id==null)continue;const key = String(row.id); if (references.has(key)) throw new HttpError(409, 'HexHub 本地连接身份重复'); references.set(key, row); }
  const candidates = new Map<string, ImportRecord[]>();
  for (const row of local) {
    const metadata = localMetadata(row); if (!metadata) continue;
    const key = hexHubIdentity(metadata); candidates.set(key, [...(candidates.get(key) ?? []), row]);
  }
  let matched = 0;
  const records = assets.map(asset => {
    const record = hexHubMetadata(asset), found = candidates.get(hexHubIdentity(record));
    if (record.importError || found?.length !== 1) return record;
    matched++; return hexHubLogin(found[0], references);
  });
  return {records, notice:matched ? '已读取唯一匹配的本机 HexHub 登录信息；密码和私钥不会在预览中显示。已有完整连接将跳过。' : '未找到唯一匹配的本地登录信息；本次仅识别连接清单，可在资源编辑中补充。'};
}
export async function fetchHexHubAssets(signal: AbortSignal, endpoint = process.env.LAKE_HEXHUB_MCP_URL ?? 'http://127.0.0.1:17321/mcp') {
  let url: URL;
  try { url = new URL(endpoint); if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error(); }
  catch { throw new HttpError(400, 'HexHub MCP 须为不含凭据或查询参数的本机 HTTP(S) 地址'); }
  const abort = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const scopedFetch: typeof fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input)); if (target.origin !== url.origin) throw new Error('scope');
    const response = await fetch(input, {...init, signal:AbortSignal.any([abort, ...(init?.signal ? [init.signal] : [])]), redirect:'manual'});
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('redirect'); }
    if (!response.body) return response; let size = 0;
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk, controller) { size += chunk.byteLength; if (size > 8 * 1024 * 1024) controller.error(new Error('size')); else controller.enqueue(chunk); }})), {status:response.status, statusText:response.statusText, headers:response.headers});
  };
  const transport = new StreamableHTTPClientTransport(url, {fetch:scopedFetch, onInsufficientScope:'throw', maxStepUpRetries:0, reconnectionOptions:{maxRetries:0, initialReconnectionDelay:1000, maxReconnectionDelay:1000, reconnectionDelayGrowFactor:1}});
  const client = new Client({name:'Lake resource import', version:'1'}, {versionNegotiation:{mode:'legacy'}});
  try {
    await client.connect(transport, {signal:abort, timeout:20000});
    const result = await client.callTool({name:'list_assets', arguments:{pattern:''}}, {signal:abort, timeout:20000});
    if (result.isError || !Array.isArray(result.content)) throw new Error('result');
    const raw = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('size');
    const rows = JSON.parse(raw); if (!Array.isArray(rows) || rows.length > 1000 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('format');
    return rows as ImportRecord[];
  } catch {
    if (signal.aborted) throw new HttpError(408, 'HexHub 读取已取消');
    throw new HttpError(400, '无法读取本机 HexHub MCP 清单，请确认 HexHub 已启动、MCP 已开启并允许读取资产');
  } finally { await client.close().catch(() => {}); }
}
export async function hexHubImportSource(signal: AbortSignal, options: HexHubImportOptions = {}) {
  const assets = await fetchHexHubAssets(signal, options.endpoint); let local: ImportRecord[];
  try { local = readHexHubLocalAssets(options.userHome, signal); }
  catch { signal.throwIfAborted(); return {records:assets.map(hexHubMetadata), notice:'未能读取唯一且稳定的 HexHub 本地登录存储；本次仅识别 MCP 连接清单，可在资源编辑中补充。'}; }
  return joinHexHubLogins(assets, local);
}
export function hexHubExportRecords(document: ImportRecord) {
  if (document.password) throw new HttpError(400, 'HexHub 导出文件已整体加密，请使用可读取的连接配置');
  const rows = document.list ?? document.data;
  if (!Array.isArray(rows) || rows.length > 20000) throw new HttpError(400, 'HexHub 导出格式无效');
  const references = new Map<string, ImportRecord>();
  for (const row of rows) if (row && [1,2,4,15,19].includes(Number(row.type)) && !Number(row.delFlag??0) && row.id!=null) { if (references.has(String(row.id))) throw new HttpError(400, 'HexHub 导出身份重复'); references.set(String(row.id), row); }
  return rows.filter(row => row && [2,4,15].includes(Number(row.type)) && !Number(row.delFlag??0)).map(row => hexHubLogin(row, references));
}
