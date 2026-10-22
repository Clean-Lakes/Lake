import {Children,Fragment,isValidElement,useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode,type SelectHTMLAttributes} from "react";
import {createPortal} from "react-dom";
import {Glyph} from "./Icons";
import {matchSelectOption,nextEnabledOption,selectPopupPosition,selectSidePopupPosition,type SelectOption} from "./selectState";

type Props=Omit<SelectHTMLAttributes<HTMLSelectElement>,"multiple"|"size"|"value"|"defaultValue"> & {value?:string|number;defaultValue?:string|number;label?:string;icon?:ReactNode;open?:boolean;onOpenChange?:(open:boolean)=>void;renderValue?:ReactNode;renderOption?:(option:SelectOption)=>ReactNode;popupHeader?:ReactNode|((state:{listId:string;activeId?:string})=>ReactNode);popupFooter?:ReactNode;emptyMessage?:string;popupClassName?:string;popupMinWidth?:number;popupMaxHeight?:number;nativePopup?:boolean;selectionLocked?:boolean;popupPlacement?:"vertical"|"side"};
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
export function AppSelect({children,value,defaultValue,onChange,disabled=false,id,className="",label,icon,open:controlledOpen,onOpenChange,renderValue,renderOption,popupHeader,popupFooter,emptyMessage="没有可选项",popupClassName="",popupMinWidth=200,popupMaxHeight=288,nativePopup=false,selectionLocked=false,popupPlacement="vertical",...nativeProps}:Props) {
  const generatedId=useId();
  const controlId=id || `lake-select-${generatedId}`;
  const listId=`${controlId}-list`;
  const options=collectOptions(children);
  const [localValue,setLocalValue]=useState(()=>String(defaultValue??options[0]?.value??""));
  const selectedValue=String(value??localValue);
  const selected=options.findIndex(option=>option.value===selectedValue);
  const [localOpen,setLocalOpen]=useState(false),[active,setActive]=useState(-1),[inferredLabel,setInferredLabel]=useState("");
  const open=controlledOpen??localOpen;
  const setOpen=(next:boolean)=>{if(controlledOpen===undefined) setLocalOpen(next);onOpenChange?.(next);};
  const optionSignature=options.map(option=>`${option.value}:${!!option.disabled}`).join("\n");
  const [position,setPosition]=useState<ReturnType<typeof selectPopupPosition>|null>(null);
  const root=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),native=useRef<HTMLSelectElement>(null),popup=useRef<HTMLDivElement>(null);
  const search=useRef({text:"",time:0});
  const accessibleLabel=nativeProps["aria-label"] || label || inferredLabel || undefined;
  useLayoutEffect(()=>{
    const parent=root.current?.closest("label");
    if (parent) setInferredLabel([...parent.childNodes].filter(node=>node!==root.current).map(node=>node.textContent||"").join("").trim());
  },[]);
  function place() {
    const rect=trigger.current?.getBoundingClientRect();
    if (rect) {
      const next=popupPlacement==="side"?selectSidePopupPosition(rect,{width:window.innerWidth,height:window.innerHeight},options.length+(popupFooter?2:0)):selectPopupPosition(rect,{width:window.innerWidth,height:window.innerHeight},options.length+(popupHeader?2:0)+(popupFooter?2:0),{minWidth:popupMinWidth,maxHeight:popupMaxHeight});
      setPosition(previous=>previous&&JSON.stringify(previous)===JSON.stringify(next)?previous:next);
    }
  }
  useLayoutEffect(()=>{if(open&&!nativePopup) place();});
  function show(direction:1|-1=1) {
    if (disabled || trigger.current?.matches(":disabled") || (!options.length&&!popupHeader&&!popupFooter)) return;
    trigger.current?.focus({preventScroll:true});
    place();setActive(selected>=0&&!options[selected]?.disabled?selected:nextEnabledOption(options,direction===1?-1:0,direction));setOpen(true);
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
  useEffect(()=>{if(open) {place();setActive(current=>options[current]&&!options[current]?.disabled?current:selected>=0&&!options[selected]?.disabled?selected:nextEnabledOption(options,-1,1));}},[open,optionSignature]);
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
  useEffect(()=>{if (open) popup.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({block:"nearest"});},[open,active]);
  function onKeyDown(event:KeyboardEvent<HTMLElement>) {
      if(event.nativeEvent.isComposing||event.keyCode===229) return;
      if(nativePopup) {
        if(["ArrowDown","ArrowUp","Enter"," "].includes(event.key)) {event.preventDefault();if(!open) show();}
        if(event.key==="Escape") {event.preventDefault();event.stopPropagation();close(true);}
        return;
      }
      if (event.key==="Escape"&&open) {event.preventDefault();event.stopPropagation();close(true);return;}
      if (event.key==="Tab") {if(!popup.current?.contains(event.target as Node)&&(event.target as Element).closest?.<HTMLElement>(".app-select-popup")?.dataset.parentSelect!==controlId) close();return;}
      const target=event.target as HTMLElement;
      if(target.closest("button")&&target!==trigger.current) return;
      // Embedded footer controls own their keyboard navigation (e.g. reasoning slider).
      if (target instanceof HTMLInputElement && target.type === "range") return;
      const editing=target.tagName==="INPUT"||target.tagName==="TEXTAREA";
      if (["ArrowDown","ArrowUp","Home","End","Enter"," "].includes(event.key)) {
        if(editing&&[" ","Home","End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) {show(event.key==="ArrowUp"?-1:1);return;}
        if (event.key==="Enter" || event.key===" ") {choose(active);return;}
        const next=event.key==="Home"?nextEnabledOption(options,-1,1):event.key==="End"?nextEnabledOption(options,0,-1):nextEnabledOption(options,active,event.key==="ArrowUp"?-1:1);
        setActive(next);return;
      }
      if (!editing&&event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey) {
        event.preventDefault();const now=Date.now();search.current={text:now-search.current.time<700?search.current.text+event.key:event.key,time:now};
        const index=matchSelectOption(options,search.current.text,active);
        if (!open) show();if (index>=0) setActive(index);
      }

  }
  return <span className={`app-select ${className}`} ref={root}>
    <button ref={trigger} id={controlId} type="button" className="app-select-trigger" role="combobox" title={nativeProps.title} aria-label={accessibleLabel} aria-labelledby={nativeProps["aria-labelledby"]} aria-describedby={nativeProps["aria-describedby"]} aria-invalid={nativeProps["aria-invalid"]} aria-busy={nativeProps["aria-busy"]} aria-required={nativeProps.required} aria-readonly={selectionLocked||undefined} aria-haspopup={nativeProps["aria-haspopup"]??(nativePopup?"dialog":"listbox")} aria-expanded={open} aria-controls={open&&!nativePopup?listId:undefined} aria-activedescendant={open&&!nativePopup&&active>=0?`${listId}-${active}`:undefined} disabled={disabled} autoFocus={nativeProps.autoFocus} onClick={()=>open?close():show()} onKeyDown={onKeyDown}>{icon&&<span className="app-select-icon">{icon}</span>}<span className="app-select-value">{renderValue??(options[selected]?.label || "请选择")}</span><Glyph name="chevron" size={14} className={`app-select-chevron ${open?"is-open":""}`}/></button>
    <select {...nativeProps} ref={native} id={`${controlId}-native`} hidden aria-hidden="true" tabIndex={-1} style={{display:"none"}} disabled={disabled} value={selectedValue} onChange={event=>{if (value===undefined) setLocalValue(event.target.value);onChange?.(event);}}>{children}</select>
    {open&&!nativePopup&&position&&createPortal(<div ref={popup} className={`app-select-popup ${popupClassName}`} data-select-id={controlId} data-parent-select={root.current?.closest<HTMLElement>(".app-select-popup")?.dataset.selectId} style={position} onKeyDown={onKeyDown} onBlur={event=>{if(event.relatedTarget&&!popup.current?.contains(event.relatedTarget as Node)&&!root.current?.contains(event.relatedTarget as Node)&&(event.relatedTarget as Element).closest?.<HTMLElement>(".app-select-popup")?.dataset.parentSelect!==controlId) close();}}>
      {popupHeader&&<div className="app-select-header">{typeof popupHeader==="function"?popupHeader({listId,activeId:active>=0?`${listId}-${active}`:undefined}):popupHeader}</div>}
      <div id={listId} role="listbox" aria-readonly={selectionLocked||undefined} aria-label={accessibleLabel} className="app-select-list">
        {!options.length&&<div className="app-select-empty" role="status">{emptyMessage}</div>}
        {options.map((option,index)=><Fragment key={`${option.value}-${index}`}>
          {option.group&&option.group!==options[index-1]?.group&&<div className="app-select-group" role="presentation">{option.group}</div>}
          <div id={`${listId}-${index}`} role="option" aria-label={option.group?`${option.label} · ${option.group}`:undefined} aria-selected={option.value===selectedValue} aria-disabled={option.disabled || undefined} data-option-index={index} className={`app-select-option ${index===active?"is-active":""} ${option.value===selectedValue?"is-selected":""}`} onPointerMove={()=>{if (!option.disabled) setActive(index);}} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span className="app-select-option-content">{renderOption?.(option)??option.label}</span><span className="app-select-check">{option.value===selectedValue&&<Glyph name="check" size={15}/>}</span></div>
        </Fragment>)}
      </div>
      {popupFooter&&<div className="app-select-footer">{popupFooter}</div>}
    </div>,root.current?.closest('[role="dialog"]') || document.body)}
  </span>;
}
