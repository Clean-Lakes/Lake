import type {MCPServerConfig} from '../../shared/contracts';
export type MCPInput={name:string;transport:MCPServerConfig['transport'];enabled:boolean;url:string;command:string;args:string[];timeoutMs:number;protocolVersion:string;headers?:Record<string,string>;env?:Record<string,string>};
export const mcpProtocols=['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const fields=new Set(['type','transport','enabled','url','command','args','timeoutMs','protocolVersion','headers','env']);
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function mcpSecretMap(text:string,label:string):Record<string,string>|undefined{
 if(!text.trim())return undefined;
 let value:unknown;try{value=JSON.parse(text);}catch{throw new Error(`${label}须为有效的 JSON 字符串对象`);}
 if(!record(value)||Object.values(value).some(item=>typeof item!=='string'))throw new Error(`${label}须为 JSON 对象，所有值均为字符串`);
 return value as Record<string,string>;
}
export function parseMCPArgs(text:string):string[]{
 if(text.trim().startsWith('[')){
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('参数 JSON 数组格式无效');}
  if(!Array.isArray(value)||value.some(arg=>typeof arg!=='string'))throw new Error('参数须为 JSON 字符串数组');return value;
 }
 const result:string[]=[];let token='',quote='',started=false;
 for(let i=0;i<text.length;i++){
  const char=text[i]!;
  if(char==='\\'&&quote!=="'"&&i+1<text.length&&(text[i+1]===quote||text[i+1]==='\\'||(!quote&&/[\s"']/.test(text[i+1]!)))){token+=text[++i];started=true;continue;}
  if(quote){if(char===quote)quote='';else token+=char;started=true;continue;}
  if(char==='"'||char==="'"){quote=char;started=true;continue;}
  if(/\s/.test(char)){if(started){result.push(token);token='';started=false;}continue;}
  token+=char;started=true;
 }
 if(quote)throw new Error('参数中的引号未闭合');
 if(started)result.push(token);
 return result;
}
export function formatMCPArgs(args:string[]){if(args.some(arg=>/[\u0000-\u001f\u007f]/.test(arg)))return JSON.stringify(args);return args.map(arg=>arg&&/^[^\s"'\\[]+$/.test(arg)?arg:JSON.stringify(arg)).join(' ');}
export function validateMCPInput(value:MCPInput){
 if(!value.name.trim())throw new Error('请填写服务名称');
 if(!Number.isInteger(value.timeoutMs)||value.timeoutMs<1000||value.timeoutMs>300000)throw new Error('超时时间须为 1000～300000 毫秒');
 if(value.protocolVersion&&!mcpProtocols.includes(value.protocolVersion))throw new Error('请选择支持的 MCP 协议版本');
 if(value.transport==='stdio'){
  if(!value.command.trim()||/[\0\r\n]/.test(value.command))throw new Error('请填写可执行命令，不要使用多行命令');
 }else{
  let url:URL;try{url=new URL(value.url);}catch{throw new Error('请填写完整的 HTTP(S) 服务地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('地址须为 HTTP(S)，认证信息请放在请求头中');
 }
}
export function parseMCPJSON(text:string):MCPInput[]{
 if(new TextEncoder().encode(text).length>100000)throw new Error('JSON 配置不能超过 100 KB');
 let value:unknown;try{value=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('JSON 格式无效，请检查引号、逗号和括号');}
 if(!record(value)||!Object.keys(value).length)throw new Error('请输入服务器名称与配置组成的 JSON 对象');
 if(Object.hasOwn(value,'mcpServers')){
  if(Object.keys(value).length!==1||!record(value.mcpServers))throw new Error('mcpServers 须为服务器配置对象');
  value=value.mcpServers;
 }
 if(!record(value)||!Object.keys(value).length||Object.keys(value).length>50)throw new Error('一次可导入 1～50 个 MCP 服务');
 const names=new Set<string>();
 return Object.entries(value).map(([name,config])=>{
  if(!record(config)||!Object.keys(config).length||Object.entries(config).some(([key,item])=>!fields.has(key)||item===null))throw new Error('服务器包含不支持的字段或空值');
  const normalized=name.trim().toLowerCase();if(!normalized||names.has(normalized))throw new Error('服务名称不能为空或重复');names.add(normalized);
  for(const key of ['type','transport','url','command','protocolVersion'])if(config[key]!==undefined&&typeof config[key]!=='string')throw new Error('连接类型、地址、命令和协议版本须为字符串');
  const normalize=(type:unknown)=>String(type??'').trim().toLowerCase().replace(/^streamable-http$/,'http');
  const type=normalize(config.type),transport=normalize(config.transport);
  if(type&&transport&&type!==transport)throw new Error('type 与 transport 连接类型不一致');
  const kind=type||transport||(config.command!==undefined?'stdio':config.url!==undefined?'http':'');
  if(!['stdio','http','sse'].includes(kind))throw new Error('连接类型须为 stdio、http 或 sse');
  if(config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('enabled 须为布尔值');
  if(config.timeoutMs!==undefined&&(!Number.isInteger(config.timeoutMs)||typeof config.timeoutMs!=='number'))throw new Error('timeoutMs 须为整数毫秒');
  if(config.args!==undefined&&(!Array.isArray(config.args)||config.args.some(arg=>typeof arg!=='string')))throw new Error('args 须为 JSON 字符串数组');
  for(const key of ['env','headers'])if(config[key]!==undefined&&(!record(config[key])||Object.values(config[key]).some(item=>typeof item!=='string')))throw new Error('环境变量和请求头须为字符串对象');
  return {name:name.trim(),transport:kind as MCPInput['transport'],enabled:config.enabled!==false,url:String(config.url??''),command:String(config.command??''),args:(config.args??[]) as string[],timeoutMs:(config.timeoutMs??30000) as number,protocolVersion:config.protocolVersion==='auto'?'':String(config.protocolVersion??''),...(config.env!==undefined?{env:config.env as Record<string,string>}:{}),...(config.headers!==undefined?{headers:config.headers as Record<string,string>}: {})};
 });
}
export function mcpJSON(rows:MCPInput[]):string{
 const named=Object.fromEntries(rows.map(row=>[row.name||'my-mcp-server',{
  type:row.transport,...(row.transport==='stdio'?{command:row.command,args:row.args}:{url:row.url}),
  ...(row.timeoutMs!==30000?{timeoutMs:row.timeoutMs}:{}),...(row.protocolVersion?{protocolVersion:row.protocolVersion}:{}),...(!row.enabled?{enabled:false}:{}),
  ...(row.env!==undefined?{env:row.env}:{}),...(row.headers!==undefined?{headers:row.headers}:{})
 }]));
 return JSON.stringify(Object.hasOwn(named,'mcpServers')?{mcpServers:named}:named,null,2);
}
