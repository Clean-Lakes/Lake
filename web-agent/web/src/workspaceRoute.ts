export type WorkspacePageView='workspace'|'settings'|'updates';
export type WorkspaceRoute={sessionId:string|null;resourceId:string|null;view?:'plans'|WorkspacePageView};

export function isWorkspacePageView(view:string|null|undefined):view is WorkspacePageView {
 return view==='workspace'||view==='settings'||view==='updates';
}

export function readWorkspaceRoute(search:string):WorkspaceRoute {
 const params=new URLSearchParams(search);
 const sessionId=params.get('session'),resourceId=params.get('resource');
 const view=params.get('view');
 return {sessionId,resourceId,...(isWorkspacePageView(view)||view==='plans'&&sessionId&&!resourceId?{view}:{})};
}

export function workspaceURL(href:string,route:WorkspaceRoute):URL {
 const url=new URL(href);
 const view=isWorkspacePageView(route.view)||route.sessionId&&!route.resourceId?route.view:undefined;
 for(const [key,value] of [['session',route.sessionId],['resource',route.resourceId],['view',view]]){
  if(value)url.searchParams.set(key!,value);else url.searchParams.delete(key!);
 }
 return url;
}
