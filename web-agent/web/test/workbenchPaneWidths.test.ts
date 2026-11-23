import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped browser/native script through its resize and splitter events.
const source=readFileSync(new URL('../src/workbenchLayout.js',import.meta.url),'utf8');
function fixture(saved={sidebar:280,terminal:400,inspector:382},docked=false){
 const properties=new Map<string,string>(),callbacks=new Map<number,(time:number)=>void>(),events=new Map<string,Function>();
 let nextFrame=0;
 const animations:Array<{startTime:number|null;currentTime:number|null;paused:boolean;cancelled:boolean}>=[];
 const rect=(left:number)=>({left,right:left+28,top:0,bottom:28});
 const animatedNode=(left:()=>number)=>({
  getBoundingClientRect:()=>rect(left()),
  animate(){
   const animation={startTime:null,currentTime:null,paused:false,cancelled:false,
    pause(){this.paused=true;},cancel(){this.cancelled=true;}};
   animations.push(animation);
   return animation;
  },
 });
 const sidebarWidth=()=>parseFloat(properties.get('--sidebar-width')||'280');
 const surface=animatedNode(sidebarWidth);
 const toggle=animatedNode(()=>sidebarWidth()>44?86:150);
 const handles=new Map<string,any>();
 const makeNode=()=>({className:'',style:{setProperty:(key:string,value:string)=>properties.set(key,value)},classList:{add(){},remove(){}},attributes:new Map<string,string>(),setAttribute(key:string,value:string){this.attributes.set(key,value);},getAttribute(key:string){return this.attributes.get(key);},addEventListener(type:string,callback:Function){(this as any)[type]=callback;},querySelector(){return null;},appendChild(node:any){handles.set(node.className.split('-').at(-1),node);}});
 const inspector=makeNode(),terminal=makeNode(),shell={...makeNode(),clientWidth:1512,inspectorOpen:!docked,terminalOpen:!docked,sidebarCollapsed:false,
 getBoundingClientRect:()=>rect(0), animate:surface.animate, removeAttribute(key:string){this.attributes.delete(key);},
 querySelectorAll:(selector:string)=>docked&&selector==='.workbench-navigation button'?[toggle]:[],
 classList:{contains:(name:string)=>name==='terminal-is-open'&&shell.terminalOpen||name==='has-collapsed-sidebar'&&shell.sidebarCollapsed||name==='has-docked-conversation'&&docked},querySelector(selector:string):any{
  if(selector==='.workspace')return {clientWidth:this.clientWidth-sidebarWidth(),querySelector:()=>null,querySelectorAll:()=>[]};
  if(selector==='.workbench-conversation-surface')return docked?surface:null;
  if(selector==='.terminal-side-panel')return this.terminalOpen?terminal:null;
  if(selector==='.session-layout > .session-inspector.is-open')return this.inspectorOpen?inspector:null;
  if(selector.startsWith('.workbench-splitter-'))return handles.get(selector.split('-').at(-1));
  return null;
 }};
 const window={lakeWorkbenchWidths:saved,addEventListener:(type:string,callback:Function)=>events.set(type,callback)};
 const context={window,innerWidth:1512,innerHeight:900,localStorage:{getItem(){return null;},setItem(){}},document:{body:{},head:{appendChild(){}},documentElement:{classList:{add(){},remove(){}}},timeline:{currentTime:10},createElement:makeNode,querySelector:()=>shell,addEventListener(){}},getComputedStyle:()=>({getPropertyValue:()=> '44px'}),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}},requestAnimationFrame:(callback:(time:number)=>void)=>{callbacks.set(++nextFrame,callback);return nextFrame;},cancelAnimationFrame:(frame:number)=>callbacks.delete(frame)};
 runInNewContext(source,context);
 const flush=(time=0)=>{for(const [id,callback] of callbacks){callbacks.delete(id);callback(time);}};flush();
 return {properties,animations,flush,resize(width:number){shell.clientWidth=width;context.innerWidth=width;events.get('resize')!();flush();},reset(pane:string){handles.get(pane).dblclick();flush();},toggle(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('resize')!();flush();},commit(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('lake-workbench-layout')!();},collapseSidebar(collapsed:boolean){events.get('lake-workbench-sidebar-toggle')!();shell.sidebarCollapsed=collapsed;events.get('lake-workbench-layout')!();},widths(){return ['--sidebar-width','--terminal-panel-width','--inspector-preferred-width'].map(key=>parseFloat(properties.get(key)!));}};
}

test('window zoom reserves conversation space once across both auxiliary panes',()=>{
 for(const saved of [{sidebar:280,terminal:400,inspector:382},{sidebar:420,terminal:900,inspector:900}]){
  const page=fixture(saved);
  for(const width of [1101,1130,1200,1512,1920]){
   page.resize(width);
   const [sidebar,terminal,inspector]=page.widths();
   assert.ok(width-sidebar!-terminal!-inspector!>=416,`${width}: ${page.widths()}`);
   assert.ok(terminal!>=240&&inspector!>=240);
  }
 }
});
test('double-click reset stays within the narrow budget and enlarging restores preferred widths',()=>{
 const page=fixture();page.resize(1130);
 for(const pane of ['sidebar','inspector','terminal']){page.reset(pane);assert.ok(1130-page.widths().reduce((sum,width)=>sum+width,0)>=416);}
 page.resize(1920);assert.deepEqual(page.widths(),[280,400,382]);
});
test('closing a side pane returns its reserved width to the conversation',()=>{
 const page=fixture();page.resize(1130);page.toggle(false,true);
 assert.deepEqual(page.widths().slice(0,2),[280,400]);
 page.toggle(true,false);assert.equal(page.widths()[2],382);
});
test('pane toggles apply the full shared budget synchronously before the first paint',()=>{
 const page=fixture();page.resize(1232);page.toggle(true,false);
 page.commit(true,true); // Deliberately do not flush animation frames.
 assert.deepEqual(page.widths(),[280,296,240]);
 page.commit(true,false);
 assert.equal(page.widths()[0],280);assert.equal(page.widths()[2],382);
 page.commit(false,true);
 assert.deepEqual(page.widths(),[280,400,280]);
});

test('collapsing to the icon rail returns width to the workbench and preserves the preferred sidebar width',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382});
 page.resize(1232);
 const expanded=page.widths();
 page.collapseSidebar(true);
 assert.deepEqual(page.widths(),[44,400,372]);
 assert.equal(page.properties.get('--sidebar-expanded-width'),`${expanded[0]}px`);
 page.collapseSidebar(false);
 assert.deepEqual(page.widths(),expanded);
});

test('the docked reading width follows the window and is independent of sidebar collapse',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382});
 page.toggle(false,false);
 page.resize(903);
 assert.equal(page.properties.get('--expanded-conversation-width'),'599px');
 page.collapseSidebar(true);
 assert.equal(page.properties.get('--expanded-conversation-width'),'599px');
 page.resize(1000);
 assert.equal(page.properties.get('--expanded-conversation-width'),'696px');
 page.collapseSidebar(false);
 assert.equal(page.properties.get('--expanded-conversation-width'),'696px');
});

test('the sidebar and toggle start together on the first frame even after a long input task',()=>{
 const page=fixture(undefined,true);
 page.collapseSidebar(true);
 assert.equal(page.animations.length,2);
 for(const animation of page.animations){
  assert.equal(animation.startTime,null);
  assert.equal(animation.currentTime,0);
  assert.equal(animation.paused,true);
 }
 page.flush(550);
 assert.deepEqual(page.animations.map(animation=>animation.startTime),[550,550]);
});

test('reversing before the first frame does not start the cancelled slide',()=>{
 const page=fixture(undefined,true);
 page.collapseSidebar(true);
 const cancelled=page.animations.slice();
 page.collapseSidebar(false);
 page.flush(550);
 assert.ok(cancelled.every(animation=>animation.cancelled&&animation.startTime===null));
});
