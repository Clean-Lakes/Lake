import test from "node:test";
import assert from "node:assert/strict";
import { validateImageSelection } from "../src/imageAttachments";

test("terminal and main composers reject mixed attachments before reading files",()=>{
 assert.throws(()=>validateImageSelection([], [{type:"image/svg+xml",size:1}]),/PNG/);
 assert.throws(()=>validateImageSelection([], [{type:"image/png",size:2*1024*1024+1}]),/2 MiB/);
 assert.throws(()=>validateImageSelection([{sizeBytes:2*1024*1024}], [{type:"image/png",size:2*1024*1024},{type:"image/png",size:1}]),/总计/);
 assert.throws(()=>validateImageSelection(Array.from({length:4},()=>({sizeBytes:1})), [{type:"image/png",size:1}]),/最多 4/);
 validateImageSelection([{sizeBytes:2*1024*1024}], [{type:"image/webp",size:2*1024*1024}]);
});
