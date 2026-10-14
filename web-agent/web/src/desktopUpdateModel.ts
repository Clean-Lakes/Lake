export const repositoryURL="https://github.com/Clean-Lakes/Lake";
export const releasesURL=`${repositoryURL}/releases`;
export type UpdateState={status:string;currentVersion:string;version?:string;message:string;progress?:number;releaseNotes?:string;updateAvailable?:boolean};
export type UpdateBridge={platform?:string;development?:boolean;command:(action:"state"|"check"|"install")=>Promise<UpdateState>};
type Release={tag_name?:string;target_commitish?:string;draft?:boolean;prerelease?:boolean;body?:string};
function versionParts(value:string){const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);return match?match.slice(1).map(Number):undefined;}
export function releaseAnnouncement(releases:Release[],currentVersion:string):UpdateState {
 const current=versionParts(currentVersion);
 if(!current)throw new Error("当前版本无法识别");
 const formal=releases.filter(r=>!r.draft&&!r.prerelease&&r.target_commitish==="master"&&versionParts(r.tag_name??""));
 formal.sort((a,b)=>{const av=versionParts(a.tag_name!)!,bv=versionParts(b.tag_name!)!;return bv[0]!-av[0]!||bv[1]!-av[1]!||bv[2]!-av[2]!;});
 const latest=formal[0];
 if(!latest)return {status:"unavailable",currentVersion,message:"暂未找到正式发布版本",updateAvailable:false};
 const parts=versionParts(latest.tag_name!)!;
 const newer=parts[0]!>current[0]!||parts[0]===current[0]&&(parts[1]!>current[1]!||parts[1]===current[1]&&parts[2]!>current[2]!);
 const version=latest.tag_name!.replace(/^v/,"");
 return {status:newer?"available":"current",currentVersion,version,updateAvailable:newer,message:newer?`发现 Lake ${version}`:`最新正式发布版本为 ${version}`,releaseNotes:latest.body?.trim()??""};
}
export async function checkReleaseAnnouncement(currentVersion:string):Promise<UpdateState> {
 const response=await fetch("https://api.github.com/repos/Clean-Lakes/Lake/releases?per_page=100",{headers:{Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error("更新检查失败，请稍后重试");
 const body=await response.text();if(body.length>4*1024*1024)throw new Error("更新内容过大");
 const releases=JSON.parse(body);if(!Array.isArray(releases))throw new Error("更新内容无法读取");
 return releaseAnnouncement(releases,currentVersion);
}
