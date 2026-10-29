import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync,existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {matchSelectOption,nextEnabledOption,selectPopupPosition,selectSidePopupPosition} from "../src/selectState";
import {providerBrand} from "../src/providerBrand";
import {providerPresets} from "../src/providerPresets";

const options=[{value:"a",label:"Alpha"},{value:"b",label:"Beta",disabled:true},{value:"g",label:"Gamma"}];
test("select keyboard navigation skips disabled options and wraps at both ends",()=>{
 assert.equal(nextEnabledOption(options,0,1),2);
 assert.equal(nextEnabledOption(options,2,1),0);
 assert.equal(nextEnabledOption(options,0,-1),2);
 assert.equal(nextEnabledOption(options,-1,1),0);
 assert.equal(nextEnabledOption([],0,1),-1);
 assert.equal(nextEnabledOption([{value:"x",label:"Disabled",disabled:true}],0,1),-1);
});
test("select type-ahead is case insensitive and excludes disabled matches",()=>{
 assert.equal(matchSelectOption(options,"GA",0),2);
 assert.equal(matchSelectOption(options,"be",0),-1);
 assert.equal(matchSelectOption(options,"al",2),0);
});
test("select popup flips above low anchors and stays within narrow windows",()=>{
 const bottom=selectPopupPosition({left:400,top:600,bottom:636,width:220},{width:640,height:660},6);
 assert.equal("bottom" in bottom,true);assert.equal(bottom.left,400);assert.ok(bottom.maxHeight<=288);
 const narrow=selectPopupPosition({left:290,top:20,bottom:56,width:240},{width:320,height:600},6);
 assert.ok(narrow.left>=8);assert.ok(narrow.left+narrow.width<=312);assert.equal(narrow.top,62);
 const tiny=selectPopupPosition({left:0,top:0,bottom:36,width:240},{width:80,height:40},6);
 assert.ok(tiny.width<=64);assert.ok(tiny.maxHeight>=0);
});
test('model popup can match both trigger edges instead of enforcing a wider minimum',()=>{
 const anchor={left:620,top:700,bottom:728,width:181.5};
 const matched=selectPopupPosition(anchor,{width:1000,height:800},8,{minWidth:0,maxHeight:420});
 assert.equal(matched.width,anchor.width);
 assert.equal(matched.left,anchor.left);
 assert.equal(matched.left+matched.width,anchor.left+anchor.width);
 const clamped=selectPopupPosition({...anchor,left:4,width:1000},{width:320,height:800},8,{minWidth:0,maxHeight:420});
 assert.equal(clamped.left,8);assert.equal(clamped.width,304);
});
test('readable model popup expands left from a short trigger and respects screen margins',()=>{
 const anchor={left:620,top:700,bottom:728,width:105};
 const expanded=selectPopupPosition(anchor,{width:1000,height:800},6,{minWidth:240,align:'end'});
 assert.equal(expanded.width,240);assert.equal(expanded.left+expanded.width,725);
 const edge=selectPopupPosition({...anchor,left:8},{width:320,height:800},6,{minWidth:240,align:'end'});
 assert.equal(edge.left,8);assert.equal(edge.width,240);
});
test("all public form selects use the shared component",()=>{
 const root=fileURLToPath(new URL("../src/",import.meta.url));
 for (const file of readdirSync(root).filter(file=>file.endsWith('.tsx')&&file!=="AppSelect.tsx")) {
  assert.doesNotMatch(readFileSync(root+file,"utf8"),/<select(?:\s|>)/,`${file} bypasses AppSelect`);
 }
});
test("brand resolution uses known endpoints and keeps custom loopback services generic",()=>{
 assert.equal(providerBrand("renamed","https://api.deepseek.com/v1"),"deepseek");
 assert.equal(providerBrand("小米 MiMo","https://proxy.example.test/v1"),"mimo");
 assert.equal(providerBrand("Custom","http://127.0.0.1:12345/v1"),"custom");
 assert.equal(providerBrand("Local","http://127.0.0.1:11434"),"ollama");
 assert.equal(providerBrand("Custom","https://api.openai.com.attacker.test/v1"),"custom");
 for(const preset of providerPresets) assert.ok(existsSync(fileURLToPath(new URL(`../public/providers/${preset.id}.svg`,import.meta.url))),`missing ${preset.id} logo`);
});

test("supplier submenu stays beside its parent or fits a narrow viewport",()=>{
 const left=selectSidePopupPosition({left:600,top:500,width:260},{width:1200,height:800},6);
 assert.equal(left.left+left.width+6,600);assert.equal(left.top,500);
 const right=selectSidePopupPosition({left:20,top:20,width:260},{width:900,height:600},4);
 assert.equal(right.left,286);
 const narrow=selectSidePopupPosition({left:100,top:380,width:260},{width:390,height:400},12);
 assert.ok(narrow.left>=8&&narrow.left+narrow.width<=382);assert.ok(narrow.top>=8&&narrow.top+narrow.maxHeight<=392);
});
