import type {AIImage} from '../../shared/contracts';
export const attachmentLimit=512*1024*1024;
export const attachmentCountLimit=8;
const previewTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function clipboardFiles(data:Pick<DataTransfer,'items'|'files'>):File[] {
 const files:File[]=[];
 for(const item of Array.from(data.items??[])) {
  if(item.kind!=='file')continue;
  const file=item.getAsFile();if(file)files.push(file);
 }
 return files.length?files:Array.from(data.files??[]);
}
export function partitionAttachments(selected:File[],existing:AIImage[],imageSupported:boolean) {
 const images:File[]=[],files:File[]=[];
 let count=existing.length,bytes=existing.reduce((n,image)=>n+image.sizeBytes,0);
 for(const file of selected) {
  if(file.size>attachmentLimit)throw Error(`${file.name} 超过 512 MiB。`);
  if(imageSupported&&previewTypes.has(file.type)&&file.size<=2*1024*1024&&count<4&&bytes+file.size<=4*1024*1024) {images.push(file);count++;bytes+=file.size;}
  else files.push(file);
 }
 return {images,files};
}
export function fileSize(size?:number) {
 if(size===undefined)return '';
 if(size<1024)return `${size} B`;
 if(size<1024*1024)return `${(size/1024).toFixed(1)} KiB`;
 return `${(size/1024/1024).toFixed(1)} MiB`;
}
