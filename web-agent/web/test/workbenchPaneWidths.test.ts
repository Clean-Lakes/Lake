import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the shipped browser/native script through its resize and splitter events.
const source=readFileSync(new URL('../src/workbenchLayout.js',import.meta.url),'utf8');
function fixture(saved={sidebar:280,terminal:400,inspector:382}){
 const properties=new Map<string,string>(),callbacks:Function[]=[],events=new Map<string,Function>();
 const handles=new Map<string,any>();
 const makeNode=()=>({className:'',style:{setProperty:(key:string,value:string)=>properties.set(key,value)},classList:{add(){},remove(){}},attributes:new Map<string,string>(),setAttribute(key:string,value:string){this.attributes.set(key,value);},getAttribute(key:string){return this.attributes.get(key);},addEventListener(type:string,callback:Function){(this as any)[type]=callback;},querySelector(){return null;},appendChild(node:any){handles.set(node.className.split('-').at(-1),node);}});
 const inspector=makeNode(),terminal=makeNode(),shell={...makeNode(),clientWidth:1512,inspectorOpen:true,terminalOpen:true,classList:{contains:(name:string)=>name==='terminal-is-open'&&shell.terminalOpen},querySelector(selector:string):any{
  if(selector==='.workspace')return {clientWidth:this.clientWidth-parseFloat(properties.get('--sidebar-width')||'280')};
  if(selector==='.terminal-side-panel')return this.terminalOpen?terminal:null;
  if(selector==='.session-inspector.is-open')return this.inspectorOpen?inspector:null;
  if(selector.startsWith('.workbench-splitter-'))return handles.get(selector.split('-').at(-1));
  return null;
 }};
 const window={lakeWorkbenchWidths:saved,addEventListener:(type:string,callback:Function)=>events.set(type,callback)};
 const context={window,innerWidth:1512,innerHeight:900,localStorage:{getItem(){return null;},setItem(){}},document:{body:{},head:{appendChild(){}},documentElement:{classList:{add(){},remove(){}}},createElement:makeNode,querySelector:()=>shell,addEventListener(){}},ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}},requestAnimationFrame:(callback:Function)=>{callbacks.push(callback);return callbacks.length;}};
 runInNewContext(source,context);
 const flush=()=>{while(callbacks.length)callbacks.shift()!();};flush();
 return {properties,resize(width:number){shell.clientWidth=width;context.innerWidth=width;events.get('resize')!();flush();},reset(pane:string){handles.get(pane).dblclick();flush();},toggle(inspectorOpen:boolean,terminalOpen:boolean){shell.inspectorOpen=inspectorOpen;shell.terminalOpen=terminalOpen;events.get('resize')!();flush();},widths(){return ['--sidebar-width','--terminal-panel-width','--inspector-preferred-width'].map(key=>parseFloat(properties.get(key)!));}};
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
