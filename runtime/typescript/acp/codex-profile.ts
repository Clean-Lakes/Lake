import upstream from './codex-models.json';

// OpenAI Codex rust-v0.160.1, codex-rs/models-manager/models.json (Apache-2.0).
// Preserve the upstream model instructions and limits. The static catalog is
// authoritative: native execution and delegation cannot be re-enabled by a
// remote model-catalog refresh. Lake's task-scoped MCP tools own those actions.
export const codexCatalog = {models: upstream.models.map(model => ({...model,
  apply_patch_tool_type: null, shell_type: 'disabled', tool_mode: 'direct',
  experimental_supported_tools: [], supports_search_tool: false,
  node_repl_disabled: true, multi_agent_version: 'v1',
}))};
export const codexModels: string[] = codexCatalog.models.map(model => model.slug);
export function codexConfig(home: string) {
  const disabled=['shell_tool','unified_exec','apply_patch_freeform','view_image','web_search_request','web_search_cached','multi_agent','multi_agent_v2','collab','plugins','hooks','codex_hooks','plugin_hooks','js_repl','code_mode','computer_use','browser_use','apps','connectors','memories','memory_tool','goals','remote_control','search_tool','deferred_executor','request_permissions_tool','token_budget','current_time_reminder','sleep_tool','send_message_to_user_async','image_generation'];
  return {model_catalog_json:home+'/models.json',features:Object.fromEntries(disabled.map(name=>[name,false])),
    tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},agents:{enabled:false},
    notify:[],history:{persistence:'none'},sqlite_home:home+'/state',log_dir:home+'/logs',
    web_search:'disabled',project_doc_max_bytes:0,include_environment_context:false,approval_policy:'never',sandbox_mode:'read-only'};
}
export function tomlValue(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(tomlValue).join(', ')+']';
  if(value&&typeof value==='object')return '{ '+Object.entries(value).map(([key,item])=>JSON.stringify(key)+' = '+tomlValue(item)).join(', ')+' }';
  return JSON.stringify(value);
}
export function codexStartupArgs(home:string,mcpIds:string[]=[],hooks:Record<string,unknown>={}){
  const config:Record<string,unknown>={...codexConfig(home)};
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
