import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {Project} from "../../shared/contracts";
import {ProjectSwitcher} from "../src/ProjectSwitcher";
test("project selection starts as an accessible app menu with the actual selected project",()=>{
 const projects=[{id:"a",name:"生产项目"},{id:"b",name:"测试项目"}] as Project[];
 const html=renderToStaticMarkup(createElement(ProjectSwitcher,{projects,value:"b",onChange(){}}));
 assert.ok(html.includes('aria-label="选择项目：测试项目"'));
 assert.ok(html.includes('aria-haspopup="menu"')&&html.includes('aria-expanded="false"'));
 assert.ok(!html.includes('<select')&&!html.includes('生产项目'));
});
