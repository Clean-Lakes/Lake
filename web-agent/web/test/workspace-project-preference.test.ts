import test from 'node:test';
import assert from 'node:assert/strict';
import {savedWorkspaceProject,saveWorkspaceProject} from '../src/workspaceProjectPreference';

test('project preference survives a new desktop origin and unavailable web storage', () => {
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const posts:unknown[]=[];
  const host={lakeWorkspaceProjectId:'original',webkit:{messageHandlers:{lakeChrome:{postMessage:(body:unknown)=>posts.push(body)}}}};
  let unavailable=false;
  const stored=new Map([['lake.workspace-project','test-project']]);
  try {
    Object.defineProperty(globalThis,'window',{configurable:true,value:host});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
      getItem:(key:string)=>{if(unavailable)throw new Error('storage blocked');return stored.get(key)??null;},
      setItem:(key:string,value:string)=>{if(unavailable)throw new Error('storage blocked');stored.set(key,value);},
    }});
    assert.equal(savedWorkspaceProject(),'original');
    unavailable=true;
    saveWorkspaceProject('chosen');
    assert.deepEqual(posts,[{workspaceProjectId:'chosen'}]);
    stored.clear(); // A new kernel port has a different origin and empty storage.
    assert.equal(savedWorkspaceProject(),'chosen');
    Reflect.deleteProperty(host,'lakeWorkspaceProjectId');
    assert.equal(savedWorkspaceProject(),null);
    unavailable=false;
    saveWorkspaceProject('web-project');
    Reflect.deleteProperty(host,'lakeWorkspaceProjectId');
    assert.equal(savedWorkspaceProject(),'web-project');
    const count=posts.length;
    for(const value of ['', 'bad\nproject', 'x'.repeat(257)])saveWorkspaceProject(value);
    assert.equal(posts.length,count);
    assert.equal(savedWorkspaceProject(),'web-project');
  } finally {
    if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');
    if(oldStorage)Object.defineProperty(globalThis,'localStorage',oldStorage);else Reflect.deleteProperty(globalThis,'localStorage');
  }
});
