import {sep} from 'node:path';

export type RuntimeProfile={home:string;data:string;development?:boolean;production?:boolean};

/** Paths are canonicalized by the host before this check. A distribution flag
 * admits only its own protected Home; it never grants resource permissions. */
export function validateRuntimeProfile(options:RuntimeProfile,homes:{development:string;production:string}){
 if(options.development&&options.production)throw new Error('不能同时指定 Dev 与正式版运行身份');
 for(const kind of ['development','production'] as const){
  const root=homes[kind],inside=(path:string)=>path===root||path.startsWith(root+sep);
  const own=options[kind]===true&&options.home===root&&options.data.startsWith(root+sep);
  if([options.home,options.data].some(inside)&&!own)
   throw new Error('请使用独立 Home 或明确匹配的运行身份；Dev 与正式版数据不能混用');
 }
}
