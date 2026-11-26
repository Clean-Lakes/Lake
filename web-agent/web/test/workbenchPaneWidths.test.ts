import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped browser/native script through its resize and splitter events.
const source=readFileSync(new URL('../src/workbenchLayout.js',import.meta.url),'utf8');
const railWidth=52;
function fixture(saved={sidebar:280,terminal:400,inspector:382},docked=false,sidebarDuration='420ms',railReadingLeft?:number){
 const properties=new Map<string,string>(),callbacks=new Map<number,(time:number)=>void>(),events=new Map<string,Function>();
 const widthSaves:Array<typeof saved>=[];
 let nextFrame=0;
 const animations:Array<{name:string;frames:Array<{transform?:string}>;duration:number;startTime:number|null;currentTime:number|null;paused:boolean;cancelled:boolean}>=[];
 const rect=(left:number)=>({left,right:left+28,top:0,bottom:28});
 const animatedNode=(left:()=>number,name='')=>({
  style:{setProperty(){}},
  querySelector:()=>null,
  getBoundingClientRect:()=>rect(left()),
  animate(frames:Array<{transform?:string}>,timing:{duration:number}){
   const animation={name,frames,duration:timing.duration,startTime:null,currentTime:null,paused:false,cancelled:false,
    pause(){this.paused=true;},cancel(){this.cancelled=true;}};
   animations.push(animation);
   return animation;
  },
 });
 const sidebarWidth=()=>parseFloat(properties.get('--sidebar-width')||'280');
 const surface=animatedNode(sidebarWidth);
 const toggle=animatedNode(()=>sidebarWidth()>railWidth?86:150);
 const composer=railReadingLeft===undefined?null:animatedNode(()=>railReadingLeft,'composer');
 const island=composer&&animatedNode(()=>{
  const settled=(railReadingLeft??0)+(sidebarWidth()-railWidth)/2;
  return parseFloat(properties.get('--workbench-island-navigation-left')??String(settled));
 },'island');
 const handles=new Map<string,any>();
 const findHandle=(selector:string)=>{
  const match=selector.match(/^(?::scope > )?\.workbench-splitter-(sidebar|terminal|inspector)$/);
  return match?handles.get(match[1]!):null;
 };
 const makeNode=(styles=new Map<string,string>())=>({
  className:'',isConnected:true,
  style:{setProperty:(key:string,value:string)=>styles.set(key,value),getPropertyValue:(key:string)=>styles.get(key)??'',getPropertyPriority:()=>'',removeProperty:(key:string)=>styles.delete(key)},
  classList:{add(){},remove(){}},
  pointer:undefined as number|undefined,
  setPointerCapture(pointer:number){this.pointer=pointer;},
  hasPointerCapture(pointer:number){return this.pointer===pointer;},
  releasePointerCapture(){this.pointer=undefined;},
  attributes:new Map<string,string>(),setAttribute(key:string,value:string){this.attributes.set(key,value);},getAttribute(key:string){return this.attributes.get(key);},removeAttribute(key:string){this.attributes.delete(key);},
  addEventListener(type:string,callback:Function){(this as any)[type]=callback;},querySelector:findHandle,
  appendChild(node:any){handles.set(node.className.split('-').at(-1),node);},
 });
 const conversation={...makeNode(),querySelector:(selector:string)=>selector===':scope > .timeline-list'?{getBoundingClientRect:()=>({width:750})}:null};
 const inspector=makeNode(),terminal=makeNode(),shell={...makeNode(properties),clientWidth:1512,inspectorOpen:!docked,terminalOpen:!docked,sidebarCollapsed:false,
 getBoundingClientRect:()=>rect(0), animate:surface.animate,
 querySelectorAll:(selector:string)=>docked&&selector==='.workbench-navigation button'?[toggle]:[],
 classList:{contains:(name:string)=>name==='terminal-is-open'&&shell.terminalOpen||name==='has-collapsed-sidebar'&&shell.sidebarCollapsed||name==='has-docked-conversation'&&docked},querySelector(selector:string):any{
  if(selector==='.workspace')return {clientWidth:this.clientWidth-sidebarWidth(),querySelector:(name:string)=>name==='.composer-input'?composer:null,querySelectorAll:()=>composer?[composer]:[]};
  if(selector==='.conversation')return conversation;
  if(selector==='.island-conversation')return island;
  if(selector==='.workbench-conversation-surface')return docked?surface:null;
  if(selector==='.terminal-side-panel')return this.terminalOpen?terminal:null;
  if(selector==='.session-layout > .session-inspector'||selector==='.session-layout > .session-inspector.is-open')return this.inspectorOpen?inspector:null;
  return findHandle(selector);
 }};
 const window={lakeWorkbenchWidths:saved,addEventListener:(type:string,callback:Function)=>events.set(type,callback),dispatchEvent:(event:Event)=>events.get(event.type)?.(event)};
 const getComputedStyle=(_node:unknown,pseudo?:string)=>({
  getPropertyValue:(name:string)=>name==='--workbench-sidebar-duration'?sidebarDuration:`${railWidth}px`,
  transitionDuration:pseudo==='::before'?'0.42s':'0s',
  transitionTimingFunction:'ease',
 });
 const context={window,Event,innerWidth:1512,innerHeight:900,localStorage:{getItem(){return null;},setItem(_key:string,value:string){widthSaves.push(JSON.parse(value));}},document:{body:{},head:{appendChild(){}},documentElement:{classList:{add(){},remove(){}}},timeline:{currentTime:10},createElement:()=>makeNode(),querySelector:()=>shell,addEventListener(){}},getComputedStyle,ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}},requestAnimationFrame:(callback:(time:number)=>void)=>{callbacks.set(++nextFrame,callback);return nextFrame;},cancelAnimationFrame:(frame:number)=>callbacks.delete(frame)};
 runInNewContext(source,context);
 const flush=(time=0)=>{for(const [id,callback] of callbacks){callbacks.delete(id);callback(time);}};flush();
 return {properties,animations,flush,widthSaves,conversation,sidebar:handles.get('sidebar') as ReturnType<typeof makeNode>,
  drag(type:string,clientX:number,pointerId=1){handles.get('sidebar')[type]({type,clientX,pointerId,button:0,preventDefault(){}});},
  resize(width:number){shell.clientWidth=width;context.innerWidth=width;events.get('resize')!();flush();},reset(pane:string){handles.get(pane).dblclick();flush();},toggle(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('resize')!();flush();},commit(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('lake-workbench-layout')!();},collapseSidebar(collapsed:boolean){events.get('lake-workbench-sidebar-toggle')!();shell.sidebarCollapsed=collapsed;events.get('lake-workbench-layout')!();},widths(){return ['--sidebar-width','--terminal-panel-width','--inspector-preferred-width'].map(key=>parseFloat(properties.get(key)!));}};
}

test('sidebar pointer moves resize the panes on the frame and preserve the reading width until release',()=>{
 const page=fixture();
 const readingWidth=()=>page.conversation.style.getPropertyValue('--sidebar-resize-reading-width');
 page.drag('pointerdown',280);
 assert.equal(readingWidth(),'750px');
 page.drag('pointermove',315);
 page.drag('pointermove',340);
 page.drag('pointermove',380,2);
 assert.equal(page.widths()[0],280);
 page.flush();
 assert.equal(page.widths()[0],340);
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'340');
 assert.equal(readingWidth(),'750px');
 assert.ok(1512-page.widths().reduce((sum,width)=>sum+width,0)>=416);
 assert.deepEqual(page.widthSaves,[]);

 page.drag('pointermove',350);
 page.drag('pointerup',370);
 page.drag('lostpointercapture',370);
 page.flush();
 assert.equal(readingWidth(),'');
 assert.equal(page.conversation.attributes.has('data-sidebar-resizing'),false);
 assert.equal(page.widths()[0],370);
 assert.equal(page.sidebar.getAttribute('aria-valuenow'),'370');
 assert.deepEqual(page.widthSaves,[{sidebar:370,terminal:400,inspector:382}]);
});

test('live sidebar resizing respects pane limits and restores the saved layout on cancellation',()=>{
 for(const reason of ['pointercancel','lostpointercapture','narrow viewport']){
  const page=fixture();
  page.resize(1130);
  const initial=page.widths()[0]!;
  page.drag('pointerdown',initial);
  page.drag('pointermove',0);
  page.flush();
  assert.equal(page.widths()[0],200);
  assert.ok(1130-page.widths().reduce((sum,width)=>sum+width,0)>=416);
  if(reason==='narrow viewport'){
   page.resize(700);
   page.resize(1130);
  }else page.drag(reason,0);
  assert.equal(page.conversation.style.getPropertyValue('--sidebar-resize-reading-width'),'');
  assert.equal(page.conversation.attributes.has('data-sidebar-resizing'),false);
  assert.equal(page.sidebar.hasPointerCapture(1),false);
  assert.equal(page.widths()[0],initial);
  assert.deepEqual(page.widthSaves,[]);
 }
});

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

test('the inspector fits beside the conversation at desktop widths below the terminal threshold',()=>{
 const page=fixture({sidebar:348,terminal:400,inspector:382});
 for(const width of [960,1063,1100]){
  page.commit(false,false);
  page.resize(width);
  assert.equal(page.widths()[0],348);
  page.commit(true,false);
  const [sidebar,,inspector]=page.widths();
  assert.ok(inspector!>=280);
  assert.ok(width-sidebar!-inspector!>=416);
 }
});

test('collapsing to the icon rail returns width to the workbench and preserves the preferred sidebar width',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382});
 page.resize(1232);
 const expanded=page.widths();
 page.collapseSidebar(true);
 assert.deepEqual(page.widths(),[railWidth,400,364]);
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

test('the docked island and composer share their left edge throughout both slide directions',()=>{
 const page=fixture({sidebar:304,terminal:400,inspector:382},true,'420ms',298);
 const transforms=(name:string)=>Array.from(page.animations.findLast(animation=>animation.name===name)!.frames,frame=>frame.transform);
 page.collapseSidebar(true);
 assert.equal(page.properties.get('--workbench-island-navigation-left'),'298px');
 assert.deepEqual(transforms('island'),transforms('composer'));
 page.flush();
 page.collapseSidebar(false);
 assert.equal(page.properties.get('--workbench-island-navigation-left'),'424px');
 assert.deepEqual(transforms('island'),['translate3d(-126px,0px,0)','translate3d(0px,0,0)']);
 assert.deepEqual(transforms('composer'),['translate3d(0px,0px,0)','translate3d(126px,0,0)']);
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

test('both sidebar directions keep the CSS duration when the desktop stylesheet is minified',()=>{
 for(const token of ['420ms','.42s']){
  const page=fixture(undefined,true,token);
  for(const collapsed of [true,false]){
   const first=page.animations.length;
   page.collapseSidebar(collapsed);
   page.flush();
   assert.deepEqual(page.animations.slice(first).map(animation=>animation.duration),[420,420],token);
  }
 }
});
