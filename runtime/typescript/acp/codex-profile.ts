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
export function codexConfig(home: string, model?: string) {
  if(model && !codexModels.includes(model))throw new Error('Codex model is not in the managed catalog');
  const disabled=['shell_tool','unified_exec','apply_patch_freeform','view_image','web_search_request','web_search_cached','multi_agent','multi_agent_v2','collab','plugins','hooks','codex_hooks','plugin_hooks','js_repl','code_mode','computer_use','browser_use','apps','connectors','memories','memory_tool','goals','remote_control','search_tool','deferred_executor','request_permissions_tool','token_budget','current_time_reminder','sleep_tool','send_message_to_user_async','image_generation'];
  return {model:model??'gpt-6.1-sol',model_catalog_json:home+'/models.json',features:Object.fromEntries(disabled.map(name=>[name,false])),
    tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},agents:{enabled:false},
    web_search:'disabled',project_doc_max_bytes:0,include_environment_context:false,approval_policy:'never',sandbox_mode:'read-only'};
}
export function tomlConfig(config:Record<string,unknown>){
  let text='';const sections:Array<[string,Record<string,unknown>]> = [];
  for(const [key,value] of Object.entries(config)){
    if(value&&typeof value==='object'&&!Array.isArray(value))sections.push([key,value as Record<string,unknown>]);
    else text+=key+' = '+JSON.stringify(value)+'\n';
  }
  const valueText=(value:unknown):string=>value&&typeof value==='object'&&!Array.isArray(value)?'{ '+Object.entries(value).map(([key,item])=>key+' = '+valueText(item)).join(', ')+' }':JSON.stringify(value);
  for(const [name,section] of sections){text+='\n['+name+']\n';for(const [key,value] of Object.entries(section))text+=key+' = '+valueText(value)+'\n';}
  return text;
}
