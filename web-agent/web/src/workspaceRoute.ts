export type WorkspaceRoute={sessionId:string|null;resourceId:string|null;view?:'plans'};

export function readWorkspaceRoute(search:string):WorkspaceRoute {
 const params=new URLSearchParams(search);
 const sessionId=params.get('session'),resourceId=params.get('resource');
 return {sessionId,resourceId,...(sessionId&&!resourceId&&params.get('view')==='plans'?{view:'plans' as const}:{})};
}

export function workspaceURL(href:string,route:WorkspaceRoute):URL {
 const url=new URL(href);
 for(const [key,value] of [['session',route.sessionId],['resource',route.resourceId],['view',route.sessionId&&!route.resourceId?route.view:undefined]]){
  if(value)url.searchParams.set(key!,value);else url.searchParams.delete(key!);
 }
 return url;
}
