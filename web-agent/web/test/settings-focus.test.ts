import test from 'node:test';
import assert from 'node:assert/strict';
import {navigateSettingsTabs,settingsTabStops,trapSettingsTab} from '../src/settingsFocus';

// A small DOM seam deliberately retains rects for collapsed disclosure content,
// reproducing the installed Chromium behavior without adding a DOM dependency.
function fixture(){
  const document={activeElement:null as ElementStub|null,defaultView:{getComputedStyle:(element:ElementStub)=>({visibility:element.visibility})}};
  class ElementStub{
    parentElement:ElementStub|null=null;
    children:ElementStub[]=[];
    ownerDocument=document;
    open=false;disabled=false;hidden=false;inert=false;visibility='visible';rects=1;
    constructor(public tagName:string,public tabIndex=-1){}
    append(...children:ElementStub[]){for(const child of children){child.parentElement=this;this.children.push(child);}return this;}
    contains(element:unknown):boolean{return element===this||this.children.some(child=>child.contains(element));}
    hasAttribute(name:string){return name==='open'&&this.open;}
    matches(selector:string){assert.equal(selector,':disabled');return this.disabled;}
    closest(selector:string):ElementStub|null{assert.equal(selector,'[hidden],[inert]');for(let item:ElementStub|null=this;item;item=item.parentElement)if(item.hidden||item.inert)return item;return null;}
    getClientRects(){return Array.from({length:this.rects},()=>({width:100,height:30}));}
    querySelectorAll():ElementStub[]{return this.children.flatMap(child=>[child,...child.querySelectorAll()]);}
    focus(){document.activeElement=this;}
  }
  const node=(tag:string,tabIndex=['BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','A'].includes(tag)?0:-1)=>new ElementStub(tag,tabIndex);
  const dialog=node('DIV');
  const stops=()=>settingsTabStops(dialog as unknown as HTMLElement);
  const press=(shiftKey=false,alreadyPrevented=false)=>{
    let prevented=false;
    trapSettingsTab({key:'Tab',shiftKey,defaultPrevented:alreadyPrevented,preventDefault:()=>{prevented=true;}},dialog as unknown as HTMLElement);
    return prevented;
  };
  return {node,dialog,document,stops,press};
}

test('closed connection management keeps summary as the last tab stop despite hidden buttons retaining rects',()=>{
  const f=fixture(),close=f.node('BUTTON'),details=f.node('DETAILS'),summary=f.node('SUMMARY');
  const rename=f.node('BUTTON'),configuration=f.node('BUTTON'),remove=f.node('BUTTON');
  f.dialog.append(close,details.append(summary,rename,configuration,remove));
  assert.equal(remove.getClientRects().length,1,'reproduce the nonempty rect that previously admitted hidden deletion');
  assert.deepEqual(f.stops(),[close,summary]);
  close.focus();assert.equal(f.press(true),true);assert.equal(f.document.activeElement,summary);
  summary.focus();assert.equal(f.press(),true);assert.equal(f.document.activeElement,close);
  details.open=true;assert.deepEqual(f.stops(),[close,summary,rename,configuration,remove]);
  remove.focus();assert.equal(f.press(),true);assert.equal(f.document.activeElement,close);
});

test('every closed ancestor hides nested disclosures except its first summary subtree',()=>{
  const f=fixture(),outer=f.node('DETAILS'),outerSummary=f.node('SUMMARY'),summaryAction=f.node('BUTTON');
  const laterSummary=f.node('SUMMARY'),inner=f.node('DETAILS'),innerSummary=f.node('SUMMARY'),innerAction=f.node('BUTTON');
  inner.open=true;
  f.dialog.append(outer.append(outerSummary.append(summaryAction),laterSummary,inner.append(innerSummary,innerAction)));
  assert.deepEqual(f.stops(),[outerSummary,summaryAction],'an open inner details must not escape a closed outer one');
  outer.open=true;inner.open=false;
  laterSummary.tabIndex=-1;
  assert.deepEqual(f.stops(),[outerSummary,summaryAction,innerSummary]);
  inner.open=true;assert.deepEqual(f.stops(),[outerSummary,summaryAction,innerSummary,innerAction]);
});

test('settings tab order excludes negative, disabled, hidden, inert and invisible controls and respects positive tabindex',()=>{
  const f=fixture(),close=f.node('BUTTON'),negative=f.node('BUTTON',-1),disabled=f.node('INPUT');disabled.disabled=true;
  const hidden=f.node('DIV'),inert=f.node('DIV');hidden.hidden=true;inert.inert=true;
  const invisible=f.node('BUTTON');invisible.visibility='hidden';const absent=f.node('BUTTON');absent.rects=0;
  const first=f.node('INPUT',1),second=f.node('A',2),textarea=f.node('TEXTAREA');
  f.dialog.append(close,negative,disabled,hidden.append(f.node('BUTTON')),inert.append(f.node('BUTTON')),invisible,absent,second,textarea,first);
  assert.deepEqual(f.stops(),[first,second,close,textarea]);
  first.focus();assert.equal(f.press(true),true);assert.equal(f.document.activeElement,textarea);
  close.focus();assert.equal(f.press(),false,'ordinary interior Tab stays native');
});

test('settings retain keyboard focus with no available controls and respect handled menu events',()=>{
  const f=fixture(),control=f.node('BUTTON');control.disabled=true;f.dialog.append(control);
  assert.equal(f.press(),true);assert.equal(f.document.activeElement,f.dialog);
  control.disabled=false;control.focus();assert.equal(f.press(false,true),false);assert.equal(f.document.activeElement,control);
  f.document.activeElement=f.node('BUTTON');assert.equal(f.press(),true);assert.equal(f.document.activeElement,control,'outside focus returns inside the open modal');
});

test('settings arrows and edge keys activate the focused enabled category',()=>{
  const f=fixture();
  let selected='';
  const tabs=['models','hidden','tools','appearance'].map(name=>Object.assign(f.node('BUTTON'),{click:()=>{selected=name;}}));
  tabs[1]!.disabled=true;
  const list={querySelectorAll:(selector:string)=>{
    assert.equal(selector,'button[role="tab"]:not(:disabled)');
    return tabs.filter(tab=>!tab.disabled);
  }} as unknown as HTMLElement;
  tabs[0]!.focus();
  const press=(key:string,metaKey=false)=>{
    let prevented=false;
    navigateSettingsTabs({key,target:f.document.activeElement as unknown as EventTarget,altKey:false,ctrlKey:false,metaKey,defaultPrevented:false,preventDefault:()=>{prevented=true;}},list);
    return prevented;
  };
  assert.equal(press('ArrowRight'),true);assert.equal(selected,'tools');assert.equal(f.document.activeElement,tabs[2]);
  assert.equal(press('End'),true);assert.equal(selected,'appearance');
  assert.equal(press('ArrowRight'),true);assert.equal(selected,'models');
  assert.equal(press('ArrowLeft'),true);assert.equal(selected,'appearance');
  assert.equal(press('Home'),true);assert.equal(selected,'models');
  assert.equal(press('ArrowRight',true),false);assert.equal(press('Tab'),false);
});
