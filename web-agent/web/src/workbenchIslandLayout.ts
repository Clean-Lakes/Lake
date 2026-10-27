/** Size the floating island to its contents; extra pane width stays outside it. */
export function workbenchIslandLayout(conversation:number,inspector:number,available=Infinity){
 const columns=[conversation,inspector].map(value=>Math.max(0,value));
 const minimum=[260,180].map((value,index)=>Math.min(value,columns[index]!));
 let excess=Math.max(0,columns.reduce((a,b)=>a+b,2)-available);
 // Trim the long title first while preserving task navigation.
 for(const index of [0,1]){
  const shrink=Math.min(excess,columns[index]!-minimum[index]!);
  columns[index]!-=shrink;excess-=shrink;
 }
 if(excess>0){const total=columns.reduce((a,b)=>a+b,0);for(let i=0;i<columns.length;i++)columns[i]!*=Math.max(0,(total-excess)/total);}
 return {width:columns.reduce((a,b)=>a+b,2),columns};
}
