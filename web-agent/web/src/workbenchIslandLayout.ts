/** Fill the two-pane workspace when inspection and terminal are both open. */
export function workbenchIslandLayout(conversation:number,inspector:number,terminal:number,available=Infinity){
 const columns=[conversation,inspector,terminal].map(value=>Math.max(0,value));
 const minimum=[260,180,150].map((value,index)=>Math.min(value,columns[index]!));
 let excess=Math.max(0,columns.reduce((a,b)=>a+b,2)-available);
 // Trim the long title first while preserving task navigation and terminal actions.
 for(const index of [0,2,1]){
  const shrink=Math.min(excess,columns[index]!-minimum[index]!);
  columns[index]!-=shrink;excess-=shrink;
 }
 if(excess>0){const total=columns.reduce((a,b)=>a+b,0);for(let i=0;i<columns.length;i++)columns[i]!*=Math.max(0,(total-excess)/total);}
 // Keep the terminal bubble compact at the right edge; the task region owns spare room.
 if(inspector>0&&terminal>0&&Number.isFinite(available)){
  columns[1]!+=Math.max(0,available-columns.reduce((a,b)=>a+b,2));
 }
 return {width:columns.reduce((a,b)=>a+b,2),columns};
}
