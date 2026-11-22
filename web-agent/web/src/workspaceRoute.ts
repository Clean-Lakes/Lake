export type WorkspacePageView='workspace'|'settings'|'updates';
export type WorkspaceRoute={sessionId:string|null;resourceId:string|null;view?:'plans'|WorkspacePageView;returnView?:'plans'};

export function isWorkspacePageView(view:string|null|undefined):view is WorkspacePageView {
 return view==='workspace'||view==='settings'||view==='updates';
}

export function readWorkspaceRoute(search:string):WorkspaceRoute {
 const params=new URLSearchParams(search);
 const sessionId=params.get('session'),resourceId=params.get('resource');
 const view=params.get('view');
 return {sessionId,resourceId,...(isWorkspacePageView(view)||view==='plans'&&sessionId&&!resourceId?{view}:{}),
  ...(isWorkspacePageView(view)&&sessionId&&!resourceId&&params.get('returnView')==='plans'?{returnView:'plans'}:{})};
}

export function workspaceURL(href:string,route:WorkspaceRoute):URL {
 const url=new URL(href);
 const view=isWorkspacePageView(route.view)||route.sessionId&&!route.resourceId?route.view:undefined;
 const returnView=isWorkspacePageView(view)&&route.sessionId&&!route.resourceId?route.returnView:undefined;
 for(const [key,value] of [['session',route.sessionId],['resource',route.resourceId],['view',view],['returnView',returnView]]){
  if(value)url.searchParams.set(key!,value);else url.searchParams.delete(key!);
 }
 return url;
}
