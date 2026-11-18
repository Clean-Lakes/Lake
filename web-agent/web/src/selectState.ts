export type SelectOption = {value:string;label:string;disabled?:boolean;group?:string};

export function activeSelectIndex(options:SelectOption[],highlighted:string|null,selected:string,direction:1|-1=1):number {
  for (const value of [highlighted,selected]) {
    const index=options.findIndex(option=>option.value===value&&!option.disabled);
    if (index>=0) return index;
  }
  return nextEnabledOption(options,direction===1?-1:0,direction);
}

export function nextEnabledOption(options:SelectOption[],current:number,direction:1|-1):number {
  for (let count=1;count<=options.length;count++) {
    const index=(current+direction*count+options.length*2)%options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}
export function matchSelectOption(options:SelectOption[],query:string,current:number):number {
  for (let count=1;count<=options.length;count++) {
    const index=(current+count+options.length)%options.length;
    if (!options[index]?.disabled && options[index]!.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return index;
  }
  return -1;
}
export function selectPopupPosition(rect:{left:number;top:number;bottom:number;width:number},viewport:{width:number;height:number},count:number,sizing:{minWidth?:number;maxHeight?:number;align?:'start'|'end'}={}) {
  const gap=6,margin=8,limit=sizing.maxHeight??288;
  const below=Math.max(0,viewport.height-rect.bottom-gap-margin),above=Math.max(0,rect.top-gap-margin);
  const desired=Math.min(limit,count*36+10);
  const upward=below<desired && above>below;
  const maxHeight=Math.max(0,Math.min(limit,upward?above:below));
  const width=Math.min(Math.max(rect.width,sizing.minWidth??200),Math.max(0,viewport.width-margin*2));
  const preferred=sizing.align==='end'?rect.left+rect.width-width:rect.left;
  const left=Math.max(margin,Math.min(preferred,viewport.width-width-margin));
  return {left,width,maxHeight,...(upward?{bottom:viewport.height-rect.top+gap}:{top:rect.bottom+gap})};
}

/** Keep the supplier toggle reachable when neither side can fit the menu. */
export function selectSidePopupPosition(rect:{left:number;top:number;bottom:number;width:number},viewport:{width:number;height:number},count:number) {
  const gap=6,margin=8,limit=288;
  const width=Math.min(208,Math.max(0,viewport.width-2*margin));
  const left=rect.left-width-gap,right=rect.left+rect.width+gap;
  if (left<margin&&right+width>viewport.width-margin) {
    const anchor={left:rect.left,top:rect.top,bottom:rect.bottom,width};
    return selectPopupPosition(anchor,viewport,count,{minWidth:width,maxHeight:limit});
  }
  const desired=Math.min(limit,count*36+10);
  const top=Math.max(margin,Math.min(rect.top,viewport.height-desired-margin));
  return {left:left>=margin?left:right,top,width,maxHeight:Math.max(0,Math.min(limit,viewport.height-top-margin))};
}
