import {useEffect,useRef} from 'react';

/** The shell selector is portalled; treat its popup as part of this popover. */
export function useTerminalPopover(open:boolean,close:()=>void){
 const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const dismiss=useRef(close);dismiss.current=close;
 useEffect(()=>{
  if(!open)return;
  const owns=(target:EventTarget|null)=>{
   if(!(target instanceof Node))return false;
   if(trigger.current?.contains(target)||menu.current?.contains(target))return true;
   const select=(target instanceof Element?target:target.parentElement)?.closest<HTMLElement>('.app-select-popup')?.dataset.selectId;
   return !!select&&!!menu.current?.querySelector(`[role="combobox"][id="${CSS.escape(select)}"]`);
  };
  const outside=(event:Event)=>{if(!owns(event.target))dismiss.current();};
  const escape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.isComposing)return;
   // Escape first closes an open nested AppSelect, then this menu on the next press.
   if(owns(event.target)&&menu.current?.querySelector('[role="combobox"][aria-expanded="true"]'))return;
   event.preventDefault();event.stopPropagation();dismiss.current();trigger.current?.focus({preventScroll:true});
  };
  document.addEventListener('pointerdown',outside,true);
  document.addEventListener('focusin',outside);
  document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape,true);};
 },[open]);
 return {trigger,menu};
}
