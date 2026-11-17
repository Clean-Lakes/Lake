import {HttpError} from './store';
import {hexHubExportRecords, importDriver, importFolder, type ImportRecord} from './hexhub-import';

const aliases: Record<string,string> = {
  名称:'name',名字:'name',类型:'kind',地址:'host',主机:'host',ip:'host',hostname:'host',端口:'port',
  用户名:'username',用户:'username',user:'username',密码:'password',pass:'password',分组:'folder',目录:'folder',group:'folder',path:'folder',
  数据库:'database',dbname:'database',驱动:'driver',url:'endpoint',端点:'endpoint',privatekey:'privateKey',authmethod:'authMethod',
  apikey:'apiKey',credentialref:'credentialRef',identityfile:'identityFile',clearcredential:'clearCredential',tlssystemname:'tlsServerName',
  requesttimeout:'requestTimeout',tlsmode:'tlsMode',
};
export function normalizeImportRecord(input: unknown): ImportRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '资源条目须为对象');
  const source = input as ImportRecord, record: ImportRecord = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (['ssh','settings'].includes(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '连接配置须为对象');
      Object.assign(record, normalizeFields(value));
    } else Object.assign(record, normalizeFields({[key]:value}));
  }
  for (const key of ['credentialRef','identityFile','clearCredential','parentId','id','projectId']) if (record[key] !== undefined)
    throw new HttpError(400, '导入仅接受连接配置和内联凭据，不接受文件引用或资源身份');
  let kind = String(record.kind ?? record.type ?? 'ssh').toLowerCase().trim();
  if (['db','mysql','postgres','postgresql','pg','starrocks','mariadb','doris','sqlite'].includes(kind)) {
    record.driver ??= kind === 'db' ? '' : kind; kind = 'database';
  }
  record.kind = kind;
  if (kind === 'database') record.driver = importDriver(record.driver);
  record.folder = importFolder(record.folder);
  record.name ??= record.host || record.endpoint;
  if (typeof record.name !== 'string' || !record.name.trim() || [...record.name.trim()].length > 160 || /[\0\r\n]/.test(record.name)) throw new HttpError(400, '资源名称须为 1 至 160 个字符');
  record.name = record.name.trim();
  for (const key of ['port','db','requestTimeout']) if (typeof record[key] === 'string') {
    if (!/^\d+$/.test(record[key])) throw new HttpError(400, '端口、数据库编号或超时须为整数');
    record[key] = Number(record[key]);
  }
  if (typeof record.tls === 'string') {
    if (!['true','false','1','0'].includes(record.tls.toLowerCase())) throw new HttpError(400, 'TLS 须为 true 或 false');
    record.tls = ['true','1'].includes(record.tls.toLowerCase());
  }
  return record;
}
function normalizeFields(source: ImportRecord) {
  const out: ImportRecord = Object.create(null);
  for (const [key,value] of Object.entries(source)) out[aliases[key.toLowerCase()] ?? key] = value;
  return out;
}
function csv(text: string, separator: string) {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {value += '"';index++;}
      else if (char === '"') {quoted = false;closed = true;} else value += char;
    } else if (char === separator || char === '\n') {
      row.push(value);value = '';closed = false;
      if (char === '\n') {if (row.some(Boolean)) rows.push(row);row = [];}
    } else if (char === '\r' && text[index + 1] === '\n') continue;
    else if (char === '"' && !value && !closed) quoted = true;
    else {if (closed) throw new HttpError(400, 'CSV 引号格式无效');value += char;}
    if (rows.length > 1000 || row.length > 64) throw new HttpError(413, '资源清单超过上限');
  }
  if (quoted) throw new HttpError(400, 'CSV 引号未闭合');
  row.push(value);if (row.some(Boolean)) rows.push(row);
  const header = rows.shift()?.map(value => aliases[value.trim().toLowerCase()] ?? value.trim());
  if (!header?.includes('host') && !header?.includes('endpoint')) throw new HttpError(400, '表格须包含 host/地址或 endpoint/端点列');
  if (new Set(header).size !== header.length) throw new HttpError(400, '表格包含重复列');
  return rows.map(row => {
    if (row.length !== header.length) return {importError:'表格列数与表头不一致'};
    return Object.fromEntries(header.flatMap((key,index) => row[index] === '' ? [] : [[key,row[index]]]));
  });
}
function sshConfig(text: string) {
  const rows: ImportRecord[] = [];let current: ImportRecord | undefined;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();if (!clean || clean.startsWith('#')) continue;
    const match = /^(\S+)\s+(.+)$/.exec(clean);if (!match) throw new HttpError(400, 'SSH 配置行格式无效');
    const key = match[1].toLowerCase(), value = match[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {current = {name:value,kind:'ssh'};rows.push(current);if (/[*?!\s]/.test(value)) current.importError = 'SSH Host 须为单个明确名称，不能包含模式';}
    else if (!current) throw new HttpError(400, 'SSH 配置须从 Host 开始');
    else if (['hostname','port','user'].includes(key)) current[{hostname:'host',port:'port',user:'username'}[key]!] = value;
    else if (!['identitiesonly'].includes(key)) current.importError = '此 SSH 配置包含文件、代理或其他未支持选项，请粘贴明确的连接字段';
  }
  return rows;
}
export function parseImportText(value: unknown): ImportRecord[] {
  if (typeof value !== 'string' || !value.trim() || /\0/.test(value)) throw new HttpError(400, '请提供可读取的连接文本');
  if (Buffer.byteLength(value) > 1024 * 1024) throw new HttpError(413, '资源文本不能超过 1 MiB');
  const source = value.replace(/^\uFEFF/, '').trim();let rows: unknown;
  if (/^[\[{]/.test(source)) {
    let document: any;try {document = JSON.parse(source);} catch {throw new HttpError(400, '连接 JSON 格式无效');}
    if (document && !Array.isArray(document) && document.version !== undefined && (Array.isArray(document.list) || Array.isArray(document.data))) rows = hexHubExportRecords(document);
    else rows = Array.isArray(document) ? document : Array.isArray(document?.resources) ? document.resources : [document];
  } else if (/^Host\s+/im.test(source)) rows = sshConfig(source);
  else {
    const first = source.split(/\r?\n/,1)[0], separator = ['\t',',',';'].find(char => first.includes(char));
    if (!separator) throw new HttpError(400, '请使用 JSON、含表头的 CSV/TSV 或明确的 SSH Host 配置');
    rows = csv(source, separator);
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new HttpError(400, '一次须提供 1 至 1000 条资源');
  return rows as ImportRecord[];
}
