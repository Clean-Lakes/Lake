import type {AIImage} from '../../shared/contracts';
import {attachmentLimit, attachmentThumbnailLimit} from '../../shared/chat-attachments';
export {attachmentLimit, attachmentCountLimit} from '../../shared/chat-attachments';
const previewTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export function hasFileTransfer(data:Pick<DataTransfer,'types'|'items'|'files'>) {
 return Array.from(data.types??[]).includes('Files') || !!data.files?.length || Array.from(data.items??[]).some(item=>item.kind==='file');
}
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
  if(imageSupported&&previewTypes.has(file.type)&&file.size<=attachmentThumbnailLimit&&count<4&&bytes+file.size<=4*1024*1024) {images.push(file);count++;bytes+=file.size;}
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

const fileKinds = [
 {kind:'archive',icon:'archive',label:'压缩包',extensions:/^(zip|7z|rar|tar(?:\.(?:gz|bz2|xz|zst))?|tgz|tbz2?|txz|gz|bz2|xz|zst)$/,
  mime:/^application\/(zip|gzip|x-(?:zip-compressed|7z-compressed|rar-compressed|tar|gzip|bzip2|xz)|vnd.rar)$/},
 {kind:'video',icon:'film',label:'视频',extensions:/^(mp4|mov|mkv|webm|avi|m4v|mpeg|mpg|wmv|flv|3gp|mts|m2ts)$/,
  mime:/^video\//},
 {kind:'image',icon:'image',label:'图片',extensions:/^(png|jpe?g|gif|webp|avif|heic|heif|svg|tiff?|bmp|ico)$/,
  mime:/^image\//},
 {kind:'audio',icon:'headphones',label:'音频',extensions:/^(mp3|m4a|wav|aac|flac|ogg|opus|wma|aiff?)$/,
  mime:/^audio\//},
 {kind:'table',icon:'table',label:'表格',extensions:/^(csv|tsv|xlsx?|ods|numbers)$/,
  mime:/^text\/(csv|tab-separated-values)$|spreadsheet|ms-excel/},
 {kind:'package',icon:'box',label:'安装包',extensions:/^(dmg|pkg|msi|exe|appimage|apk|deb|rpm)$/},
 {kind:'code',icon:'code',label:'代码',extensions:/^(json|ya?ml|toml|xml|js|ts|tsx|jsx|py|go|rs|sh|sql|html|css|ini|conf|log)$/},
 {kind:'document',icon:'document',label:'文档',extensions:/^(pdf|docx?|rtf|txt|md|odt|pptx?|pages|key|epub)$/,
  mime:/^text\/|^application\/(pdf|msword)|wordprocessingml|presentationml/},
] as const;

export function attachmentPresentation(name:string,mimeType='') {
 const extension=name.toLowerCase().match(/\.(tar\.(?:gz|bz2|xz|zst)|[a-z0-9]{1,12})$/)?.[1];
 const type=mimeType.toLowerCase().split(';')[0]!.trim();
 const group=fileKinds.find(group=>extension&&group.extensions.test(extension)) ??
  fileKinds.find(group=>'mime' in group&&group.mime.test(type));
 return {kind:group?.kind??'file',icon:group?.icon??'file',label:extension?.toUpperCase()??group?.label??'文件'};
}

export function attachmentURL(sessionId:string,sourceId:string) {
 return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(sourceId)}`;
}
