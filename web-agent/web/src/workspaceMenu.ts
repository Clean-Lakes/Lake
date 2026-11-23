export type WorkspaceMenuView='home'|'projects'|'manage'|'create'|'delete';

export function workspaceMenuParent(view:WorkspaceMenuView):WorkspaceMenuView{
 return view==='delete'?'manage':view==='create'||view==='manage'?'projects':'home';
}

/** Use the same rail anchor for every menu page. Keep space for content in short windows. */
export function workspaceMenuPosition(anchor:{top:number;railRight:number;sidebarRight:number},viewport:{width:number;height:number}){
 const left=Math.max(8,Math.min(anchor.railRight+8,viewport.width-9));
 const width=Math.max(1,Math.min(Math.max(220,anchor.sidebarRight-left-8),viewport.width-left-8));
 const minimumHeight=Math.min(220,viewport.height-16);
 const top=Math.max(8,Math.min(anchor.top,viewport.height-minimumHeight-8));
 return {left,top,width,maxHeight:Math.max(1,Math.min(432,viewport.height-top-8))};
}
