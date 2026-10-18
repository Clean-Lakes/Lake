export type QueueDragRow = {id:string;top:number;bottom:number};
export type QueueDrop = {position:number;id:string;edge:"before"|"after"};

/** Insert at the nearest row midpoint, accounting for removal of the source. */
export function queueDropAt(rows:QueueDragRow[],source:string,y:number):QueueDrop|null {
 const from=rows.findIndex(row=>row.id===source);
 if(from<0 || rows.length<2 || !Number.isFinite(y))return null;
 const before=rows.findIndex(row=>y<(row.top+row.bottom)/2);
 const slot=before<0?rows.length:before;
 const position=slot>from?slot-1:slot;
 if(position===from)return null;
 const row=rows[slot===rows.length?slot-1:slot]!;
 return {position,id:row.id,edge:slot===rows.length?"after":"before"};
}

/** Scroll speed increases toward either edge; the middle does not scroll. */
export function queueDragScroll(y:number,top:number,bottom:number):number {
 const edge=Math.min(28,(bottom-top)/3);
 if(edge<=0)return 0;
 if(y<top+edge)return -Math.min(9,Math.max(1,(top+edge-y)/3));
 if(y>bottom-edge)return Math.min(9,Math.max(1,(y-bottom+edge)/3));
 return 0;
}
