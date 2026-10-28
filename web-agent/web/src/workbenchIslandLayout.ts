/** Match the composer width in three-pane mode; keep other layouts compact. */
export function workbenchIslandLayout(conversation:number,inspector:number,terminal:number,available=Infinity){
 const columns=[conversation,inspector,terminal].map(value=>Math.max(0,value));
 const minimum=[140,84,100].map((value,index)=>Math.min(value,columns[index]!));
 let excess=Math.max(0,columns.reduce((a,b)=>a+b,2)-available);
 // Trim the long title first while preserving task navigation and terminal actions.
 for(const index of [0,2,1]){
  const shrink=Math.min(excess,columns[index]!-minimum[index]!);
  columns[index]!-=shrink;excess-=shrink;
 }
 if(excess>0){const total=columns.reduce((a,b)=>a+b,0);for(let i=0;i<columns.length;i++)columns[i]!*=Math.max(0,(total-excess)/total);}
 // Keep the terminal bubble compact; grow only an active content region.
 if(inspector>0&&terminal>0&&Number.isFinite(available)){
  columns[inspector>0?1:0]!+=Math.max(0,available-columns.reduce((a,b)=>a+b,2));
 }
 return {width:columns.reduce((a,b)=>a+b,2),columns};
}
