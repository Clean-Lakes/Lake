import type { AIImage } from "../../shared/contracts";

const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function validateImageSelection(existing: Pick<AIImage,"sizeBytes">[], files: Pick<File,"size"|"type">[]) {
 if(existing.length + files.length > 4 || [...existing.map(file=>file.sizeBytes),...files.map(file=>file.size)].reduce((total,size)=>total+size,0) > 4*1024*1024) throw Error("最多 4 张图片，总计不超过 4 MiB");
 for(const file of files) if(!allowed.has(file.type) || file.size>2*1024*1024) throw Error("图片支持 PNG、JPEG、GIF、WebP，每张不超过 2 MiB");
}
export async function readImageSelection(existing: AIImage[], files: File[]): Promise<AIImage[]> {
 validateImageSelection(existing,files);
 return Promise.all(files.map(async file=>{
  const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error("无法读取图片"));reader.readAsDataURL(file)});
  return {id:crypto.randomUUID(),mimeType:file.type,base64:data.split(",")[1]!,sizeBytes:file.size,width:0,height:0,name:file.name};
 }));
}

/** Read pasted bitmaps only; HTML/URLs and ordinary text keep native paste. */
export function clipboardImageFiles(data: Pick<DataTransfer, "items" | "files">): File[] {
 const images: File[] = [];
 for (const item of Array.from(data.items ?? [])) {
  if (item.kind !== "file") continue;
  const file = item.getAsFile();
  if (file && (file.type || item.type).startsWith("image/")) images.push(file.type ? file : new File([file],file.name || "剪贴板图片.png",{type:item.type,lastModified:file.lastModified}));
 }
 // Browsers expose the same image through items and files; do not attach twice.
 return images.length ? images : Array.from(data.files ?? []).filter(file => file.type.startsWith("image/"));
}
