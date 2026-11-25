import {Children,Fragment,isValidElement,useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode,type SelectHTMLAttributes} from "react";
import {createPortal} from "react-dom";
import {useMenuMotion} from "./useMenuMotion";
import {Glyph} from "./Icons";
import {activeSelectIndex,matchSelectOption,nextEnabledOption,selectPopupPosition,selectSidePopupPosition,type SelectOption} from "./selectState";

type Props=Omit<SelectHTMLAttributes<HTMLSelectElement>,"multiple"|"size"|"value"|"defaultValue"> & {value?:string|number;defaultValue?:string|number;label?:string;icon?:ReactNode;open?:boolean;onOpenChange?:(open:boolean)=>void;renderValue?:ReactNode;renderOption?:(option:SelectOption)=>ReactNode;popupHeader?:ReactNode|((state:{listId:string;activeId?:string})=>ReactNode);popupFooter?:ReactNode;emptyMessage?:string;popupClassName?:string;popupMinWidth?:number;popupAlign?:"start"|"end";popupMaxHeight?:number;nativePopup?:boolean;selectionLocked?:boolean;popupPlacement?:"vertical"|"side";popupMotion?:boolean};
function nodeText(node:ReactNode):string {
  return Children.toArray(node).map(child=>isValidElement<{children?:ReactNode}>(child)?nodeText(child.props.children):String(child)).join("");
}
function collectOptions(children:ReactNode,inheritedDisabled=false,group=""):SelectOption[] {
  return Children.toArray(children).flatMap(child=>{
    if (!isValidElement<{value?:string|number;children?:ReactNode;disabled?:boolean;label?:string}>(child)) return [];
    if (child.type===Fragment || child.type==="optgroup") return collectOptions(child.props.children,inheritedDisabled || !!child.props.disabled,child.type==="optgroup"?child.props.label||"":group);
    if (child.type!=="option") return [];
    const label=nodeText(child.props.children);
    return [{value:String(child.props.value??label),label,group,disabled:inheritedDisabled || !!child.props.disabled}];
  });
}

/** Shared single-value field. The hidden select preserves real change events and form values. */
export function AppSelect({children,value,defaultValue,onChange,disabled=false,id,className="",label,icon,open:controlledOpen,onOpenChange,renderValue,renderOption,popupHeader,popupFooter,emptyMessage="没有可选项",popupClassName="",popupMinWidth=200,popupAlign="start",popupMaxHeight=288,nativePopup=false,selectionLocked=false,popupPlacement="vertical",popupMotion=false,...nativeProps}:Props) {
  const generatedId=useId();
  const controlId=id || `lake-select-${generatedId}`;
  const listId=`${controlId}-list`;
  const options=collectOptions(children);
  const [localValue,setLocalValue]=useState(()=>String(defaultValue??options[0]?.value??""));
  const selectedValue=String(value??localValue);
  const selected=options.findIndex(option=>option.value===selectedValue);
  const [localOpen,setLocalOpen]=useState(false),[inferredLabel,setInferredLabel]=useState("");
  const [highlighted,setHighlighted]=useState<string|null>(null);
  const openingDirection=useRef<1|-1>(1);
  const active=activeSelectIndex(options,highlighted,selectedValue,openingDirection.current);
  const activeValue=options[active]?.value??null;
  const open=controlledOpen??localOpen;
  const setOpen=(next:boolean)=>{if(controlledOpen===undefined) setLocalOpen(next);onOpenChange?.(next);};
  const [position,setPosition]=useState<ReturnType<typeof selectPopupPosition>|null>(null);
  const popupVisible=open&&!nativePopup&&position!==null;
  const [sideDirection,setSideDirection]=useState<"left"|"right"|"up"|"down">();
  const root=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),native=useRef<HTMLSelectElement>(null),popup=useRef<HTMLDivElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const retainPopup=useMenuMotion(popup,popupVisible,popupMotion&&!nativePopup);
  const search=useRef({text:"",time:0});
  const accessibleLabel=nativeProps["aria-label"] || label || inferredLabel || undefined;
  useLayoutEffect(()=>{
    const parent=root.current?.closest("label");
    if (parent) setInferredLabel([...parent.childNodes].filter(node=>node!==root.current).map(node=>node.textContent||"").join("").trim());
  },[]);
  function place() {
    const rect=trigger.current?.getBoundingClientRect();
    if (rect) {
      const next=popupPlacement==="side"?selectSidePopupPosition(rect,{width:window.innerWidth,height:window.innerHeight},options.length+(popupFooter?2:0)):selectPopupPosition(rect,{width:window.innerWidth,height:window.innerHeight},options.length+(popupHeader?2:0)+(popupFooter?2:0),{minWidth:popupMinWidth,maxHeight:popupMaxHeight,align:popupAlign});
      if (popupPlacement==="side") {
        if (next.left+next.width<=rect.left) setSideDirection("left");
        else if (next.left>=rect.right) setSideDirection("right");
        else setSideDirection("bottom" in next?"up":"down");
      }
      setPosition(previous=>previous&&JSON.stringify(previous)===JSON.stringify(next)?previous:next);
    }
  }
  useLayoutEffect(()=>{if(!nativePopup&&(open||popupPlacement==="side")) place();});
  function show(direction:1|-1=1) {
    if (disabled || trigger.current?.matches(":disabled") || (!options.length&&!popupHeader&&!popupFooter)) return;
    trigger.current?.focus({preventScroll:true});
    openingDirection.current=direction;
    setHighlighted(null);place();setOpen(true);
  }
  function close(restoreFocus=false) {
    setOpen(false);search.current={text:"",time:0};
    if (restoreFocus) trigger.current?.focus({preventScroll:true});
  }
  function choose(index:number) {
    const option=options[index];
    if (selectionLocked || !option || option.disabled || !native.current || native.current.matches(":disabled")) return;
    close(true);
    if (option.value===selectedValue) return;
    native.current.value=option.value;
    native.current.dispatchEvent(new Event("change",{bubbles:true}));
  }
  useEffect(()=>{if (disabled&&open) setOpen(false);},[disabled,open]);
  useEffect(()=>{setHighlighted(open?activeValue:null);},[open,activeValue]);
  useEffect(()=>{
    if (!open||nativePopup) return;
    const outside=(event:PointerEvent)=>{if (!root.current?.contains(event.target as Node)&&!popup.current?.contains(event.target as Node)&&(event.target as Element).closest?.<HTMLElement>(".app-select-popup")?.dataset.parentSelect!==controlId) close();};
    const reposition=(event:Event)=>{if (!popup.current?.contains(event.target as Node)) place();};
    document.addEventListener("pointerdown",outside,true);
    window.addEventListener("resize",reposition);window.addEventListener("scroll",reposition,true);
    // Embedded viewports can change layout before a window resize event arrives.
    const resizeObserver=new ResizeObserver(()=>place());
    resizeObserver.observe(document.documentElement);
    if(trigger.current) resizeObserver.observe(trigger.current);
    return()=>{resizeObserver.disconnect();document.removeEventListener("pointerdown",outside,true);window.removeEventListener("resize",reposition);window.removeEventListener("scroll",reposition,true);};
  });
  useLayoutEffect(()=>{
    const viewport=list.current;
    const row=viewport?.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
    if (!popupVisible||!viewport||!row) return;
    const reveal=()=>{
      const bounds=viewport.getBoundingClientRect(),item=row.getBoundingClientRect();
      const scale=viewport.offsetHeight&&bounds.height>0?bounds.height/viewport.offsetHeight:1;
      if (item.top<bounds.top) viewport.scrollTop+=(item.top-bounds.top)/scale;
      else if (item.bottom>bounds.bottom) viewport.scrollTop+=(item.bottom-bounds.bottom)/scale;
    };
    reveal();
    // Loading a footer can shrink the list without resizing the popup or changing its active row.
    const observer=new ResizeObserver(reveal);
    observer.observe(viewport);
    return()=>observer.disconnect();
  },[popupVisible,active,activeValue]);
  function onKeyDown(event:KeyboardEvent<HTMLElement>) {
      if(event.nativeEvent.isComposing||event.keyCode===229) return;
      if(nativePopup) {
        if(["ArrowDown","ArrowUp","Enter"," "].includes(event.key)) {event.preventDefault();if(!open) show();}
        if(event.key==="Escape") {event.preventDefault();event.stopPropagation();close(true);}
        return;
      }
      if (event.key==="Escape"&&open) {event.preventDefault();event.stopPropagation();close(true);return;}
      const target=event.target as HTMLElement;
      if (event.key==="Tab") {
        const panel=popup.current;
        if (!open||!panel) return;
        const controls=Array.from(panel.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],summary,[tabindex]"))
          .filter(node=>node.tabIndex>=0&&!node.matches(":disabled")&&node.getClientRects().length>0);
        if (target===trigger.current) {
          if (!event.shiftKey&&controls[0]) {
            event.preventDefault();event.stopPropagation();controls[0].focus();
          } else close();
        } else if (event.shiftKey&&target===controls[0]) {
          event.preventDefault();event.stopPropagation();close(true);
        } else if (!event.shiftKey&&target===controls.at(-1)) {
          // Let the browser continue tabbing from the trigger's place in the form.
          close(true);
        }
        return;
      }
      const editing=target instanceof HTMLTextAreaElement||target instanceof HTMLInputElement&&["text","search"].includes(target.type);
      if (target!==trigger.current&&target.id!==listId&&!editing) return;
      if (["ArrowDown","ArrowUp","Home","End","Enter"," "].includes(event.key)) {
        if(editing&&[" ","Home","End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) {show(event.key==="ArrowUp"?-1:1);return;}
        if (event.key==="Enter" || event.key===" ") {choose(active);return;}
        const next=event.key==="Home"?nextEnabledOption(options,-1,1):event.key==="End"?nextEnabledOption(options,0,-1):nextEnabledOption(options,active,event.key==="ArrowUp"?-1:1);
        setHighlighted(options[next]?.value??null);return;
      }
      if (!editing&&event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey) {
        event.preventDefault();const now=Date.now();search.current={text:now-search.current.time<700?search.current.text+event.key:event.key,time:now};
        const index=matchSelectOption(options,search.current.text,active);
        if (!open) show();if (index>=0) setHighlighted(options[index]!.value);
      }

  }
  return <span className={`app-select ${className}`} data-popup-direction={sideDirection} ref={root}>
    <button ref={trigger} id={controlId} type="button" className="app-select-trigger" role="combobox" title={nativeProps.title} aria-label={accessibleLabel} aria-labelledby={nativeProps["aria-labelledby"]} aria-describedby={nativeProps["aria-describedby"]} aria-invalid={nativeProps["aria-invalid"]} aria-busy={nativeProps["aria-busy"]} aria-required={nativeProps.required} aria-readonly={selectionLocked||undefined} aria-haspopup={nativeProps["aria-haspopup"]??(nativePopup?"dialog":"listbox")} aria-expanded={open} aria-controls={open&&!nativePopup?listId:undefined} aria-activedescendant={open&&!nativePopup&&active>=0?`${listId}-${active}`:undefined} disabled={disabled} autoFocus={nativeProps.autoFocus} onClick={()=>open?close():show()} onKeyDown={onKeyDown}>{icon&&<span className="app-select-icon">{icon}</span>}<span className="app-select-value">{renderValue??(options[selected]?.label || "请选择")}</span><Glyph name="chevron" size={14} className={`app-select-chevron ${open?"is-open":""}`}/></button>
    <select {...nativeProps} ref={native} id={`${controlId}-native`} hidden aria-hidden="true" tabIndex={-1} style={{display:"none"}} disabled={disabled} value={selectedValue} onChange={event=>{if (value===undefined) setLocalValue(event.target.value);onChange?.(event);}}>{children}</select>
    {(popupVisible||retainPopup)&&position&&createPortal(<div ref={popup} className={`app-select-popup ${popupClassName}`} data-select-id={controlId} data-parent-select={root.current?.closest<HTMLElement>(".app-select-popup")?.dataset.selectId} style={{...position,transformOrigin:popupMotion?`${popupAlign==="end"?"right":"left"} ${"bottom" in position?"bottom":"top"}`:undefined}}
      inert={!popupVisible} aria-hidden={!popupVisible||undefined} data-menu-motion={popupMotion||undefined}
      onKeyDown={onKeyDown} onBlur={event=>{if(popupVisible&&event.relatedTarget&&!popup.current?.contains(event.relatedTarget as Node)&&!root.current?.contains(event.relatedTarget as Node)&&(event.relatedTarget as Element).closest?.<HTMLElement>(".app-select-popup")?.dataset.parentSelect!==controlId) close();}}>
      {popupHeader&&<div className="app-select-header">{typeof popupHeader==="function"?popupHeader({listId,activeId:active>=0?`${listId}-${active}`:undefined}):popupHeader}</div>}
      <div ref={list} id={listId} role="listbox" tabIndex={-1} aria-readonly={selectionLocked||undefined} aria-label={accessibleLabel} className="app-select-list">
        {!options.length&&<div className="app-select-empty" role="status">{emptyMessage}</div>}
        {options.map((option,index)=><Fragment key={`${option.value}-${index}`}>
          {option.group&&option.group!==options[index-1]?.group&&<div className="app-select-group" role="presentation">{option.group}</div>}
          <div id={`${listId}-${index}`} role="option" aria-label={option.group?`${option.label} · ${option.group}`:undefined} aria-selected={option.value===selectedValue} aria-disabled={option.disabled || undefined} data-option-index={index} className={`app-select-option ${index===active?"is-active":""} ${option.value===selectedValue?"is-selected":""}`} onPointerMove={()=>{if (!option.disabled) setHighlighted(option.value);}} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span className="app-select-option-content">{renderOption?.(option)??option.label}</span><span className="app-select-check">{option.value===selectedValue&&<Glyph name="check" size={15}/>}</span></div>
        </Fragment>)}
      </div>
      {popupFooter&&<div className="app-select-footer">{popupFooter}</div>}
    </div>,root.current?.closest('[role="dialog"]') || document.body)}
  </span>;
}
