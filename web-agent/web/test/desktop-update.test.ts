import test from "node:test";
import assert from "node:assert/strict";
import {releaseAnnouncement,repositoryURL,releasesURL} from "../src/desktopUpdateModel";
const release=(tag_name:string,body="真实更新内容")=>({tag_name,body,target_commitish:"master",draft:false,prerelease:false});
test("update announcements compare numeric versions and ignore drafts, previews and other branches",()=>{
 const state=releaseAnnouncement([release("v0.3.9"),release("v0.3.10"),{...release("v9.0.0"),draft:true},{...release("v8.0.0"),prerelease:true},{...release("v7.0.0"),target_commitish:"dev"},release("v00.5.0")],"0.3.6");
 assert.equal(state.version,"0.3.10");assert.equal(state.status,"available");assert.equal(state.releaseNotes,"真实更新内容");
});
test("current or locally newer versions keep real announcement text without requesting a downgrade",()=>{
 for(const version of ["0.3.6","0.4.0"]){const state=releaseAnnouncement([release("v0.3.6","  发布内容  ")],version);assert.equal(state.updateAvailable,false);assert.equal(state.version,"0.3.6");assert.equal(state.releaseNotes,"发布内容");}
 assert.equal(releaseAnnouncement([],"0.3.6").status,"unavailable");
 assert.throws(()=>releaseAnnouncement([],"unknown"));
 assert.equal(repositoryURL,"https://github.com/Clean-Lakes/Lake");assert.equal(releasesURL,repositoryURL+"/releases");
});
