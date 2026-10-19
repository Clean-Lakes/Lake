import type {FileChange} from './file-changes-model';

export function fileName(path:string) {return path.replaceAll('\\','/').split('/').filter(Boolean).at(-1)||path;}

// Resolve only unique files already recorded in this turn. A path alone must
// never select another host/container or cause an arbitrary filesystem read.
export function linkedFile(files:FileChange[],href:string,current?:FileChange):FileChange|undefined {
 if(!href||/^[a-z][a-z\d+.-]*:/i.test(href)&&!(/^[a-z]:[\\/]/i.test(href))||href.startsWith('//')||href.startsWith('#'))return;
 let path:string;try{path=decodeURIComponent(href).replaceAll('\\','/')}catch{return;}
 if(/[?#\u0000]/.test(path))return;
 const parts=path.split('/');
 if(parts.includes('..'))return;
 path=path.replace(/^\.\//,'');
 if(current&&!path.startsWith('/')&&!/^[a-z]:\//i.test(path))path=current.path.replaceAll('\\','/').split('/').slice(0,-1).concat(path).join('/');
 const matches=files.filter(file=>!file.deleted&&(!current||file.runtime===current.runtime&&file.assetRef===current.assetRef&&file.containerId===current.containerId)&&
   (file.path.replaceAll('\\','/')===path||!current&&!path.startsWith('/')&&file.path.replaceAll('\\','/').endsWith('/'+path)));
 return matches.length===1?matches[0]:undefined;
}
