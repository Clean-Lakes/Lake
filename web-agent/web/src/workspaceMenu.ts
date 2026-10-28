export type WorkspaceMenuView='home'|'projects'|'manage'|'create'|'delete';

export function workspaceMenuParent(view:WorkspaceMenuView):WorkspaceMenuView{
 return view==='delete'?'manage':view==='create'?'projects':'home';
}

/** The footer is the only anchor, including while pages and sidebar width change. */
export function workspaceMenuPosition(anchor:{left:number;top:number;width:number},viewport:{width:number;height:number}){
 const width=Math.max(1,Math.min(anchor.width,viewport.width-16));
 const left=Math.max(8,Math.min(anchor.left,viewport.width-width-8));
 const bottom=Math.max(8,Math.min(viewport.height-8,viewport.height-anchor.top+8));
 return {left,bottom,width,height:Math.max(1,Math.min(432,viewport.height-bottom-8))};
}
