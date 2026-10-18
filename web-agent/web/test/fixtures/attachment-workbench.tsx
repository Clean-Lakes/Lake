// File bytes stay in this page; the fixture never reaches a backend or model.
import './readme-workbench';
const original=window.fetch.bind(window);
let sequence=0;
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname.endsWith('/attachments')&&init?.method==='POST') {
  const file=init.body as File;
  const name=decodeURIComponent(new Headers(init.headers).get('X-Lake-Filename')??'file');
  return new Response(JSON.stringify({sourceId:`file-${String(++sequence).padStart(32,'0')}`,name,sizeBytes:file.size,kind:'file',mimeType:file.type||'application/octet-stream'}),{status:201,headers:{'Content-Type':'application/json'}});
 }
 return original(input,init);
};
// A visible fixture control exercises the real React drop handler without
// requiring a desktop drag across two independently managed app windows.
const dropProbe=document.createElement('button');
dropProbe.textContent='模拟拖入二进制文件';
dropProbe.style.cssText='position:fixed;top:8px;left:45%;z-index:1000;padding:6px 12px';
dropProbe.onclick=()=>{
 const transfer=new DataTransfer();
 transfer.items.add(new File([new Uint8Array([0,255,7,128])],'drop-fixture.bin',{type:'application/octet-stream'}));
 document.querySelector('.workspace')?.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
};
document.body.append(dropProbe);
