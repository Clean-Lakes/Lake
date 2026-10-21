export type SelectOption = {value:string;label:string;disabled?:boolean;group?:string};

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
export function selectPopupPosition(rect:{left:number;top:number;bottom:number;width:number},viewport:{width:number;height:number},count:number,sizing:{minWidth?:number;maxHeight?:number}={}) {
  const gap=6,margin=8,limit=sizing.maxHeight??288;
  const below=Math.max(0,viewport.height-rect.bottom-gap-margin),above=Math.max(0,rect.top-gap-margin);
  const desired=Math.min(limit,count*36+10);
  const upward=below<desired && above>below;
  const maxHeight=Math.max(0,Math.min(limit,upward?above:below));
  const width=Math.min(Math.max(rect.width,sizing.minWidth??200),Math.max(0,viewport.width-margin*2));
  const left=Math.max(margin,Math.min(rect.left,viewport.width-width-margin));
  return {left,width,maxHeight,...(upward?{bottom:viewport.height-rect.top+gap}:{top:rect.bottom+gap})};
}

/** Cascading menus prefer the left of their parent, then fit inside narrow viewports. */
export function selectSidePopupPosition(rect:{left:number;top:number;width:number},viewport:{width:number;height:number},count:number) {
  const width=Math.min(208,Math.max(0,viewport.width-16)),maxHeight=Math.min(288,Math.max(0,viewport.height-16));
  const desired=Math.min(maxHeight,count*36+10);
  const preferred=rect.left-width-6>=8?rect.left-width-6:rect.left+rect.width+6;
  return {left:Math.max(8,Math.min(preferred,viewport.width-width-8)),top:Math.max(8,Math.min(rect.top,viewport.height-desired-8)),width,maxHeight};
}
