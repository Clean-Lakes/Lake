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

test("pasted screenshot is attached once when exposed in both clipboard items and files",async()=>{
 const {clipboardImageFiles}=await import("../src/imageAttachments");
 const image=new File(["synthetic"],"screenshot.png",{type:"image/png"});
 const clipboard={items:[{kind:"string",type:"text/html",getAsFile:()=>null},{kind:"file",type:"image/png",getAsFile:()=>image}],files:[image]} as unknown as DataTransfer;
 assert.deepEqual(clipboardImageFiles(clipboard),[image]);
});
test("text and HTML image URLs retain ordinary paste without network reads",async()=>{
 const {clipboardImageFiles}=await import("../src/imageAttachments");
 assert.deepEqual(clipboardImageFiles({items:[{kind:"string",type:"text/html",getAsFile:()=>null}],files:[]} as unknown as DataTransfer),[]);
});
test("clipboard files fallback and an empty File MIME preserve image type",async()=>{
 const {clipboardImageFiles}=await import("../src/imageAttachments");
 const typed=new File(["synthetic"],"photo.webp",{type:"image/webp"});
 assert.deepEqual(clipboardImageFiles({items:[],files:[typed]} as unknown as DataTransfer),[typed]);
 const untyped=new File(["synthetic"],"screenshot.png");
 const result=clipboardImageFiles({items:[{kind:"file",type:"image/png",getAsFile:()=>untyped}],files:[]} as unknown as DataTransfer);
 assert.equal(result[0]?.type,"image/png");assert.equal(result[0]?.size,untyped.size);
});
