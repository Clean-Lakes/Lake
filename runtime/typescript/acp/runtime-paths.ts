import {access,readdir,realpath,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,delimiter,isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';
import {isSea} from 'node:sea';
import {HttpError} from '../store';

export async function validateCodexNode(path:string){
 if(!isAbsolute(path)||/[\0\r\n]/.test(path))throw new HttpError(400,'Node 需要准确绝对路径');
 const nodePath=await realpath(path);
 const {stdout}=await promisify(execFile)(nodePath,['--version'],{timeout:5000,maxBuffer:4096,env:{PATH:process.env.PATH}});
 const version=/^v(\d+)\.(\d+)\.(\d+)$/.exec(stdout.trim());
 if(!version||!(Number(version[1])===22&&Number(version[2])>=22||Number(version[1])===24&&Number(version[2])>=14))
  throw new HttpError(400,'Codex 需要 Node 22.22+ 或 Node 24.14+ 的运行时');
 return nodePath;
}

/** Host-only discovery. Never scans project workspaces or executes shell startup files. */
export async function discoverCodexRuntime(preferredNode?:string,preferredNpm?:string,options:{home?:string;path?:string;nodeExecutable?:string;standardDirs?:string[]}={}){
 const home=options.home??homedir(),dirs=[...(options.path??process.env.PATH??'').split(delimiter).filter(isAbsolute),
  ...(options.standardDirs??['/opt/homebrew/bin','/opt/homebrew/opt/node@24/bin','/usr/local/bin','/usr/local/opt/node@24/bin',join(home,'.volta/bin')])];
 for(const root of [join(home,'.nvm/versions/node'),join(home,'.local/share/fnm/node-versions'),join(home,'.fnm/node-versions')]){
  try{for(const version of (await readdir(root)).filter(version=>/^v?(22|24)\./.test(version)).sort().reverse())dirs.push(join(root,version,'bin'),join(root,version,'installation/bin'));}catch{/* optional manager */}
 }
 const candidates=[preferredNode,options.nodeExecutable??(!isSea()?process.execPath:undefined),...dirs.map(dir=>join(dir,process.platform==='win32'?'node.exe':'node'))].filter((value):value is string=>!!value);
 for(const candidate of [...new Set(candidates)]){
  let nodePath:string;try{nodePath=await validateCodexNode(candidate);}catch{continue;}
  const npmCandidates=[preferredNpm,join(dirname(candidate),'npm'),join(dirname(nodePath),'npm'),join(dirname(nodePath),'../lib/node_modules/npm/bin/npm-cli.js')].filter((value):value is string=>!!value);
  for(const path of npmCandidates){
   try{if(!isAbsolute(path)||/[\0\r\n]/.test(path))continue;const npmPath=await realpath(path);await access(npmPath);if((await stat(npmPath)).isFile())return {nodePath,npmPath};}catch{/* continue with this runtime's npm */}
  }
 }
 throw new HttpError(409,'未找到可用的 Node/npm；请安装 Node 22.22+ 或 24.14+，或在高级设置指定路径。');
}
