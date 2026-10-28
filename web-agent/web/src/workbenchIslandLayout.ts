/** Keep the session identity and a readable status before trimming auxiliaries. */
export function workbenchIslandLayout(conversation:number,inspector:number,terminal:number,available=Infinity){
 const columns=[conversation,inspector,terminal].map(value=>Math.max(0,value));
 const minimum=[180,84,available<366?68:100].map((value,index)=>Math.min(value,columns[index]!));
 let excess=Math.max(0,columns.reduce((a,b)=>a+b,2)-available);
 const trim=(index:number,floor:number)=>{const shrink=Math.min(excess,Math.max(0,columns[index]!-floor));columns[index]!-=shrink;excess-=shrink;};
 // First remove generous title space, then compress resource/task controls,
 // and only then shorten the conversation below its comfortable width.
 trim(0,Math.max(minimum[0]!,Math.min(300,columns[0]!)));
 for(const index of [2,1,0])trim(index,minimum[index]!);
 if(excess>0){const total=columns.reduce((a,b)=>a+b,0);for(let i=0;i<columns.length;i++)columns[i]!*=Math.max(0,(total-excess)/total);}
 if(inspector>0&&terminal>0&&Number.isFinite(available)){
  columns[1]!+=Math.max(0,available-columns.reduce((a,b)=>a+b,2));
 }
 return {width:columns.reduce((a,b)=>a+b,2),columns};
}
