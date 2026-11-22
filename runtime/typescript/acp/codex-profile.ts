import {createHash} from 'node:crypto';
import upstream from './codex-models.json';
import type {CodexModelOption} from './types';

// OpenAI Codex models-manager/models.json (Apache-2.0), rust-v0.170.0.
// GPT-6.1 Sol retains the Lake entry from rust-v0.160.1.
const bundledModels = new Map(upstream.models.map(model => [model.slug, model]));
const toolRestrictions = {
  apply_patch_tool_type: null, shell_type: 'disabled', tool_mode: 'direct',
  experimental_supported_tools: [], supports_search_tool: false,
  node_repl_disabled: true, multi_agent_version: 'v1',
};
export const codexCatalogRevision = createHash('sha256').update(JSON.stringify([upstream,toolRestrictions])).digest('hex');

export function isCodexModelId(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=256&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
}
export function isCodexReasoningEffort(value:unknown):value is string {
  return typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
export function codexModelCatalog(model:string, option?:CodexModelOption) {
  // App Server must resolve this exact slug from a static, Lake-owned catalog.
  // Letting Codex resolve an unknown slug on its own can restore native tools.
  const bundled = bundledModels.get(model);
  const metadata = bundled ?? {
    display_name: model, priority: 0, supported_in_api: true,
    supported_reasoning_levels: [],
    model_messages: {instructions_template:'You are an assistant executing a task in Lake. Follow the task instructions and use the supplied tools as needed.'},
    support_verbosity: false, supports_reasoning_summary_parameter: false,
    truncation_policy: {mode:'bytes',limit:10_000}, context_window:272_000,
  };
  const reasoning = option?.reasoningEfforts.length ? {
    supported_reasoning_levels: option.reasoningEfforts.map(effort => ({effort,description:''})),
    default_reasoning_level: option.defaultReasoningEffort ?? bundled?.default_reasoning_level,
  } : {};
  return {models:[{...metadata,...reasoning,slug:model,visibility:'list',...toolRestrictions}]};
}

export function codexConfig(home: string, catalogPath?: string) {
  const disabled=['shell_tool','unified_exec','apply_patch_freeform','view_image','web_search_request','web_search_cached','multi_agent','multi_agent_v2','collab','plugins','hooks','codex_hooks','plugin_hooks','js_repl','code_mode','computer_use','browser_use','apps','connectors','memories','memory_tool','goals','remote_control','search_tool','deferred_executor','request_permissions_tool','token_budget','current_time_reminder','sleep_tool','send_message_to_user_async','image_generation'];
  return {...(catalogPath?{model_catalog_json:catalogPath}:{}),features:{...Object.fromEntries(disabled.map(name=>[name,false])),tool_call_mcp_elicitation:true},
    tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},agents:{enabled:false},
    notify:[],history:{persistence:'none'},sqlite_home:home+'/state',log_dir:home+'/logs',
    web_search:'disabled',project_doc_max_bytes:0,include_environment_context:false,approval_policy:'never',sandbox_mode:'read-only'};
}
export function tomlValue(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(tomlValue).join(', ')+']';
  if(value&&typeof value==='object')return '{ '+Object.entries(value).map(([key,item])=>JSON.stringify(key)+' = '+tomlValue(item)).join(', ')+' }';
  return JSON.stringify(value);
}
export function codexStartupArgs(home:string,mcpIds:string[]=[],hooks:Record<string,unknown>={},catalogPath?:string){
  const config:Record<string,unknown>={...codexConfig(home,catalogPath)};
  // An empty table merges with the source configuration. Disable every resolved
  // MCP and hook explicitly before a thread can start.
  // Codex's -c parser splits dotted paths literally, so quote IDs inside an
  // inline TOML table (IDs may themselves contain dots or quotes).
  config.mcp_servers=Object.fromEntries(mcpIds.map(name=>[name,{enabled:false}]));
  config.hooks=Object.fromEntries(Object.keys(hooks).map(name=>[name,[]]));
  return Object.entries(config).flatMap(([key,value])=>['-c',key+'='+tomlValue(value)]);
}
export function tomlConfig(config:Record<string,unknown>){
  let text='';const sections:Array<[string,Record<string,unknown>]> = [];
  for(const [key,value] of Object.entries(config)){
    if(value&&typeof value==='object'&&!Array.isArray(value))sections.push([key,value as Record<string,unknown>]);
    else text+=key+' = '+JSON.stringify(value)+'\n';
  }
  for(const [name,section] of sections){text+='\n['+name+']\n';for(const [key,value] of Object.entries(section))text+=key+' = '+tomlValue(value)+'\n';}
  return text;
}
