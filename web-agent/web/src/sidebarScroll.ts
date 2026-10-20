export function sidebarScrollGeometry(viewport:number,content:number,scrollTop:number){
 const range=Math.max(0,content-viewport);
 // Match the visible fraction of the actual content. A fixed short cap makes
 // near-fitting lists jump across a long track for a tiny content movement.
 const track=Math.max(0,viewport-76);
 const thumb=range>0?Math.min(track,Math.max(28,track*viewport/content)):0;
 const travel=track-thumb;
 const top=range>0?Math.max(0,Math.min(range,scrollTop))/range*travel:0;
 return {range,thumb,travel,top};
}

export function sidebarScrollFromThumb(top:number,travel:number,range:number){
 return travel>0?Math.max(0,Math.min(travel,top))/travel*range:0;
}
