import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Project} from "../../shared/contracts";
import {ProjectSwitcher} from "../src/ProjectSwitcher";
test("the sidebar and collapsed rail identify the active project in their picker",()=>{
 const projects=[{id:"a",name:"生产项目"},{id:"b",name:"测试项目"}] satisfies Pick<Project,"id"|"name">[];
 for(const iconOnly of [false,true]){
  const html=renderToStaticMarkup(createElement(ProjectSwitcher,{projects,value:"b",iconOnly,onChange(){}}));
  assert.match(html,/<button [^>]*role="combobox"[^>]*aria-label="切换项目：测试项目"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"/);
  assert.match(html,/class="app-select-value">测试项目<\/span>/);
  assert.match(html,/<select [^>]*hidden="" aria-hidden="true"/);
  assert.doesNotMatch(html,/role="listbox"/);
  assert.equal(html.includes("is-icon-only"),iconOnly);
 }
});
