import test from "node:test";
import assert from "node:assert/strict";

test("native appearance survives a new origin, unavailable storage, system changes and another tab", async () => {
  const previous = Object.fromEntries(["window","document","localStorage","matchMedia"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const dataset:Record<string,string>={};
  let dark=true;
  let storageUnavailable=true;
  const stored=new Map<string,string>();
  const listeners:Record<string,(event:any)=>void>={};
  const native={lakeAppearance:"system",addEventListener:(name:string,callback:(event:any)=>void)=>{listeners[name]=callback;}};
  try {
    Object.defineProperty(globalThis,"window",{configurable:true,value:native});
    Object.defineProperty(globalThis,"document",{configurable:true,value:{documentElement:{dataset}}});
    Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>stored.get(key),setItem:(key:string,value:string)=>{if(storageUnavailable)throw new Error("storage unavailable");stored.set(key,value);}}});
    Object.defineProperty(globalThis,"matchMedia",{configurable:true,value:()=>({matches:dark,addEventListener:(_name:string,callback:(event:any)=>void)=>{listeners.system=callback;}})});
    const appearance=await import("../src/appearance.ts");
    appearance.initializeAppearance();
    assert.equal(dataset.theme,"dark");
    assert.equal(appearance.themePreference(),"system");
    dark=false;listeners.system({});assert.equal(dataset.theme,"light");
    appearance.setThemePreference("dark");
    assert.equal(native.lakeAppearance,"dark");
    assert.equal(dataset.theme,"dark");
    listeners.system({});assert.equal(dataset.theme,"dark");
    storageUnavailable=false;appearance.setThemePreference("light");
    assert.equal(stored.get("lake.appearance"),"light");
    listeners.storage({key:"lake.appearance",newValue:"dark"});
    assert.equal(dataset.theme,"dark");
    assert.equal(appearance.themePreference(),"dark");
  } finally {
    for(const[key,descriptor]of Object.entries(previous)) if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);
  }
});
