import type {LakeAvatarName} from './lakeAvatarCatalog';

export type AvatarTone='base'|'soft'|'deep'|'plate'|'eye'|'beak';
export type AvatarPartName='head'|'wing'|'fore'|'hind'|'tail'|'shell'|'detail';
export type AvatarShape={d:string;tone:AvatarTone;line?:boolean;width?:number;opacity?:number};
export type AvatarPart={name:AvatarPartName;pivot:readonly [number,number];shapes:AvatarShape[];eyes?:readonly (readonly [number,number])[]};
export type AvatarArtwork={palette:PaintName;parts:AvatarPart[];fit?:string};
const paints={
 sage:['#6c8c76','#a8bfa0','#54725e','#87a187','#304a3a','#bca47b','#94af9b','#c3d2b6','#708d79','#acc0a4'],
 river:['#6c8b91','#adc1b6','#506f78','#88a6a3','#2c4548','#c3aa82','#9fbabc','#c8d7c6','#78999e','#b5cbbb'],
 clay:['#a18064','#c8b799','#80634e','#b89c7c','#4c3b2f','#bf9f70','#c3a98a','#e0ceb1','#a58a6e','#d1bb99'],
 reed:['#8a9470','#bec5a0','#6e7958','#a5af87','#3e4931','#c7ad76','#b4bda0','#d9dfbd','#8c9975','#c4cdaa'],
 slate:['#7c8986','#bcc6b7','#5e6f69','#9eaaa0','#34443e','#bea57b','#a9b8ad','#d1dbca','#879e91','#bdc9b7'],
 rose:['#ac8d83','#d4b9a3','#8b7068','#c6a899','#533e37','#c4a26f','#d3b6a6','#e8d5bc','#ad9183','#dfc4af'],
 gold:['#af9b64','#d1c39a','#8b784c','#c1b07d','#50462c','#baa073','#d2c18d','#e6d9b4','#ae9c68','#decfa2'],
} as const;
export type PaintName=keyof typeof paints;
export function avatarPaintStyle(name:PaintName){
 const p=paints[name],names=['base','soft','deep','plate','eye','beak'] as const;
 return Object.fromEntries(names.map((tone,i)=>[`--avatar-${tone}`,`light-dark(${p[i]},${i<4?p[i+6]:p[i]})`]));
}
const s=(d:string,tone:AvatarTone='base',line=false,width=.9,opacity=1):AvatarShape=>({d,tone,line,width,opacity});
const p=(name:AvatarPartName,x:number,y:number,shapes:AvatarShape[],eyes?:readonly (readonly [number,number])[]):AvatarPart=>({name,pivot:[x,y],shapes,eyes});
const art=(palette:PaintName,...parts:AvatarPart[]):AvatarArtwork=>({palette,parts});
const oval=(x:number,y:number,rx:number,ry:number)=>`M${x-rx} ${y}a${rx} ${ry} 0 1 0 ${rx*2} 0a${rx} ${ry} 0 1 0 ${-rx*2} 0Z`;

// Body, head and appendages are separate painted shapes. The catalogue retains
// exact species identities; templates share anatomy, not a substituted icon.
function wader(body:number,headY:number,beak:number,neck:string,wing:string,legs:string,palette:PaintName='sage',crest=''){
 return art(palette,p('hind',25,43,[s(legs,'deep',true,1.6)]),p('tail',10,body,[s(`M16 ${body-2}Q6 ${body-4} 3 ${body+4}q8 3 14-1Z`,'deep')]),
  p('shell',27,body,[s(oval(26,body,17,10)),s(`M10 ${body+2}q16 10 31-1l-1 5q-18 8-30-4Z`,'deep')]),
  p('head',40,body-3,[s(neck,'soft'),s(`M49 ${headY-1}q${beak} -1 ${beak+1} 3L48 ${headY+4}Z`,'beak'),s(oval(45,headY,6,5),'soft'),...(crest?[s(crest,'deep')]:[])],[[47,headY-1]]),
  p('wing',21,body-3,[s(wing,'plate'),s(`M17 ${body}q7 5 15 0`,'deep',true,.8,.65)]));
}
const fitted=(a:AvatarArtwork,fit:string):AvatarArtwork=>({...a,fit});
const airborne=(a:AvatarArtwork):AvatarArtwork=>({...a,parts:a.parts.filter(part=>part.name!=='hind')});
function swimmer(h:number,neck:string,tail:string,wing:string,palette:PaintName='sage',crest=''){
 return art(palette,p('tail',13,39,[s(tail,'deep')]),p('shell',29,39,[s(oval(28,39,20,h)),s(`M9 41q19 12 38-2l-1 6q-24 13-37-4Z`,'deep')]),
 p('head',42,35,[s(neck,'soft'),s('M50 23q12 0 11 4l-12 2Z','beak'),s(oval(46,23,7,6),'soft'),...(crest?[s(crest,'deep')]:[])],[[48.5,21.5]]),
 p('wing',18,34,[s(wing,'plate'),s('M18 39q10 6 20-1','deep',true,.85,.7)]));
}
function songbird(shape:string,head:string,tail:string,wing:string,beak:string,eyes:readonly (readonly [number,number])[],palette:PaintName='sage',detail=''){
 return art(palette,p('hind',28,48,[s('M25 47v9m10-10 2 10m-15 0h7m5 0h7','deep',true,1.5)]),p('tail',19,40,[s(tail,'deep')]),p('shell',29,36,[s(shape)]),
 p('head',39,29,[s(head,'soft'),s(beak,'beak'),...(detail?[s(detail,'deep')]:[])],eyes),p('wing',25,31,[s(wing,'plate'),s('M25 39q4 3 9 0','deep',true,.8,.65)]));
}
function mammal(body:string,head:string,ears:string,tail:string,face:readonly (readonly [number,number])[],palette:PaintName='clay',mark=''){
 return art(palette,p('tail',17,39,[s(tail,'deep')]),p('hind',20,40,[s('M15 38q-3 10 1 12 6 2 9-5l2-7Z','soft')]),
 p('shell',28,35,[s(body),s('M21 40q7 7 15 1','deep',true,1.5,.5)]),p('head',39,31,[s(ears,'deep'),s(head,'soft'),...(mark?[s(mark,'deep')]:[]),s('M48 31q3 2 5 0','deep',true,.75,.6)],face),
 p('fore',38,39,[s('M36 36q5 0 7 8 2 5-2 6-5 0-8-10Z','soft')]));
}
function fish(body:string,tail:string,fins:string,marks:string,eye:readonly [number,number],palette:PaintName='river'){
 return art(palette,p('tail',46,32,[s(tail,'soft'),s('M49 32q5-3 9-5m-9 5q5 3 9 5','deep',true,.8,.55)]),p('hind',31,34,[s(fins,'plate')]),
 p('shell',29,32,[s(body),s(marks,'deep',true,.9,.7)]),p('head',17,32,[s(oval(eye[0]-1,eye[1]+4,3,1.8),'soft')],[eye]),
 p('wing',30,33,[s('M30 31q10-2 8 7-5-1-8-7Z','soft')]));
}
function frog(width:number,top:number,belly:string,legs:string,palette:PaintName='sage',marks=''){
 return art(palette,p('hind',32,40,[s(legs,'deep')]),p('shell',32,35,[s(`M${32-width} 34q0-14 ${width} -14t${width} 14q5 15-${width} 16t-${width}-16Z`)]),
 p('head',32,27,[s(oval(21,top,7,7),'soft'),s(oval(43,top,7,7),'soft'),s('M23 31q9 5 18 0','deep',true,1)],[[21,top-1],[43,top-1]]),
 p('fore',32,38,[s(belly,'plate'),s('M21 37q-1 8-7 11m29-11q1 8 7 11','soft',true,3),...(marks?[s(marks,'deep',true,1)]:[])]));
}
function bug(body:string,wings:string,legs:string,eyes:readonly (readonly [number,number])[],palette:PaintName='sage',marks='',antennae='M27 16 24 7m13 9 3-9'){
 return art(palette,p('hind',32,37,[s(legs,'deep',true,1.4)]),p('wing',32,27,[s(wings,'soft',false,.9,.9)]),p('shell',32,34,[s(body),...(marks?[s(marks,'deep',true,1.1)]:[])]),
 p('head',32,21,[s(antennae,'deep',true,1.2),s(oval(32,20,5,5),'plate')],eyes));
}
function plant(stem:string,foliage:string,marks:string,palette:PaintName='sage',blossom=''){
 return art(palette,p('hind',32,56,[s(stem,'deep',true,1.7)]),p('wing',32,50,[s(foliage),...(blossom?[s(blossom,'soft')]:[]),...(marks?[s(marks,'plate',true,.9,.8)]:[])]));
}

export const lakeAvatarArtwork:Record<LakeAvatarName,AvatarArtwork>={
 heron:wader(38,12,9,'M35 37c3-6-7-12-2-21 3-7 11-9 15-5l-4 6c-7-5-10 1-5 8 5 8 3 13-1 17Z','M15 36q7-9 19-1-6 10-19 1Z','M24 45v13m10-14-2 14m-11 0h8m0 0h7'),
 crane:wader(36,9,8,'M34 37c7-8 0-13 2-22 1-7 9-10 13-5l-4 6c-6-2-5 4-3 11 2 6 1 10-3 13Z','M13 36q11-11 22 0-9 10-22 0Z','M24 44 22 59m10-16 5 16m-18 0h8m7 0h8','slate','M41 6q4-2 8 2l-1 2-8-1Z'),
 egret:wader(39,10,10,'M34 40c8-9-8-18-1-27 5-8 14-8 16-2l-5 5c-9-6-11 3-5 12 6 7 5 11 0 15Z','M14 37q7-10 22 1-6 10-22-1Z','M22 47 20 59m13-13 2 13m-19 0h8m7 0h8','reed'),
 stork:wader(35,12,11,'M33 36q8-6 6-20-1-9 9-8l3 7q-7-3-7 6l1 14-6 5Z','M12 35q12-11 24 1-14 8-24-1Z','M23 43v16m12-17 2 17m-18 0h8m6 0h8','slate'),
 ibis:wader(37,13,6,'M34 37q5-8 1-15-6-13 9-14l5 7q-11-6-8 6 6 14-2 19Z','M13 37q8-11 23 0-8 10-23 0Z','M23 46 21 59m11-14 4 14m-18 0h8m6 0h8','rose','M48 12q13-2 13 16l-3-5q-1-7-9-6Z'),
 spoonbill:wader(37,13,6,'M34 38q7-10 2-20-3-11 11-10l3 7q-9-5-8 5l3 16-6 5Z','M14 37q10-10 22 1-10 10-22-1Z','M22 45v14m13-15 1 15m-18 0h8m5 0h9','reed','M49 14h10q8-1 3 6-3 3-7-1l-6-1Z'),
 flamingo:wader(31,11,4,'M33 32c11-10-11-16-1-25 6-6 16-3 17 4l-5 5c-1-8-12-5-7 2 12 10 4 16 0 18Z','M12 31q9-9 23 1-10 10-23-1Z','M24 40 26 59m8-20-4 10 12 3m-19 7h8','rose','M48 11q10 0 7 8l-3 3-2-8Z'),
 swan:swimmer(10,'M35 40c11-7-10-18-3-29 6-10 20-5 19 3l-7 2c1-7-10-6-10 1 0 6 13 11 10 23Z','M15 37Q4 29 4 35q0 9 12 10Z','M13 37q7-11 15-10 7 10 11 11-11 12-26-1Z','reed'),
 goose:swimmer(11,'M37 39 38 16c0-10 15-12 16 0l-7 5-1 17Z','M14 36 5 33q0 11 12 11Z','M12 38q11-12 25 0-10 11-25 0Z','clay'),
 cormorant:wader(38,12,6,'M33 40q8-10 4-23-4-10 10-10l4 8q-10-4-7 7 4 13-3 20Z','M15 36q12-9 19 1-10 13-19-1Z','M24 46 21 57m14-12 5 12m-21 0h9m8 0h8','slate','M48 13q10-2 11 3l-4 4 1-4-6 1Z'),
 pelican:wader(39,16,5,'M33 41q7-10 3-20-3-12 11-10l5 9q-11-4-8 8l1 12Z','M12 38q12-13 27 0-12 13-27 0Z','M22 47v11m13-12 4 12m-20 0h9m7 0h9','clay','M48 17h15q1 14-9 10l-7-7Z'),
 avocet:wader(38,12,6,'M34 39q7-9 3-20-2-12 11-10l3 7q-10-5-8 6l1 17Z','M12 37q11-9 24 1-10 11-24-1Z','M22 45 18 59m17-14 6 14m-26 0h8m14 0h8','clay','M49 14q9 0 13-8-1 11-13 12Z'),
 sandpiper:wader(39,21,9,'M33 40q7-7 5-16-1-10 12-8l2 8q-9-5-9 5l-1 11Z','M13 38q10-9 23 1-11 9-23-1Z','M22 47 20 58m14-12 3 12m-20 0h8m8 0h8','clay'),

 otter:mammal('M15 30c1-12 22-15 28-1 7 17-1 23-15 22-13 0-18-9-13-21Z','M33 23c-2-12 16-14 20-3l8 7-10 5-13-1Z','M34 18q-8-10 1-10l4 8m8-1q2-9 7-4l-2 8Z','M20 38C8 34 3 39 4 44c1 4 12 3 18-1Z',[[49,22]],'clay'),
 beaver:mammal('M15 29c3-13 25-13 29 1 6 14-4 22-17 20S9 43 15 29Z','M34 23c-3-12 17-15 20-1l7 6-11 5Z','M34 19q-4-10 3-10l3 8m8 0q2-10 7-4l-2 8Z','M19 36C5 28-1 39 7 48q7 8 18-7Z',[[49,22]],'clay','M46 30h6v5h-6Z'),
 nutria:mammal('M13 31c5-12 26-13 31 0 5 15-9 21-21 18S8 42 13 31Z','M34 25q-1-15 14-12l12 14-12 6Z','M38 18q-4-10 3-9l3 8Z','M20 43Q4 57 3 43q2-11 12-7-8 0-8 7 3 5 13-3Z',[[48,24]],'clay','M50 29h6v3h-6Z'),
 muskrat:mammal('M12 33c5-14 28-16 33-1 3 13-8 19-21 17S7 42 12 33Z','M32 25q-1-16 15-12l14 15-16 5Z','M34 20q-3-12 5-10l4 8Z','M20 42C9 52 0 43 4 34q3-5 7-2-7 5 0 10l8-3Z',[[47,24]],'clay'),
 seal:mammal('M11 45c1-15 12-20 23-17 15 3 19 11 24 19-20 10-37 7-47-2Z','M32 29c-9-14 3-27 16-22 12 5 7 21-3 26Z','M35 15q-1-4 3-4l2 5Z','M16 42 3 47q4 10 18 0Z',[[40,17],[49,18]],'slate','M43 24q5 3 8-1Z'),
 'sea-lion':mammal('M13 47c12-13 11-31 22-32 9 4 7 18 21 31-12 10-28 12-43 1Z','M31 24c-8-13 6-23 15-16l12 13-15 7Z','M34 13q-1-7 5-4l2 5Z','M18 42 4 48q7 8 17-1Z',[[45,16]],'clay'),
 capybara:mammal('M9 29q4-14 22-12 23 1 20 23-4 12-25 10Q6 49 9 29Z','M35 21q3-11 16-7 10 3 10 13-1 12-22 8Z','M37 19q-5-13 3-10l5 8m6-1q0-10 7-6l-1 9Z','M12 39q-8 1-4 7l8-3Z',[[53,23]],'clay','M49 29h9v3h-9Z'),
 hippo:mammal('M7 29q5-15 26-12 21 1 19 24-4 12-26 10Q3 49 7 29Z','M34 21q10-12 19-1 12 2 8 15-8 9-25 1Z','M36 21q-4-13 4-9l4 8m7-1q2-10 7-5l-1 10Z','M10 35Q0 31 4 43l9 1Z',[[48,23],[56,24]],'slate','M46 32q5 4 12 0Z'),
 'water-shrew':mammal('M12 34q3-14 19-13 21 0 18 17-3 15-21 13Q6 50 12 34Z','M34 27q1-16 13-12l15 15-18 5Z','M35 22q-5-11 3-11l4 10Z','M18 42Q1 54 4 37q3-7 9-3-11 8 4 7Z',[[47,25]],'slate'),
 raccoon:mammal('M13 31q2-15 19-13 19 1 16 22-3 13-20 11Q9 48 13 31Z','M29 22q1-16 19-12 15 4 9 18l-13 7-14-8Z','M29 17 26 6q6-4 12 7m9 1 10-8q7 6-1 13Z','M19 38Q0 28 3 43q3 13 20 2Z',[[36,22],[50,22]],'slate','M30 21q6-6 13 1 7-7 14-1l-5 6-9-1-9 1Z'),
 mink:mammal('M13 34q10-8 20-14 14-5 17 8 3 15-20 22Q9 54 13 34Z','M35 23q2-15 15-12l11 14-14 8Z','M35 18q-3-10 4-10l5 9m5 1 7-9 1 13Z','M19 41Q5 39 4 25q-8 3 0 18l15 4Z',[[50,21]],'clay'),
 fox:mammal('M17 33q2-14 19-12 16 3 10 20-4 11-20 10Q12 49 17 33Z','M32 23 34 10l10 6 11-7 2 18-11 9-13-6Z','M33 22 32 3q10 0 13 15m1-1L58 3q6 10-2 22Z','M20 38C5 25 0 39 6 48q11 12 20-4Z',[[39,23],[51,23]],'rose','M34 27q7 1 11 7 4-6 11-8l-10 11Z'),
 rabbit:fitted(mammal('M12 35q2-17 21-16 18 0 17 21-5 14-22 11Q8 50 12 35Z','M33 28q-3-15 11-17 13-1 14 13l-7 9-14-1Z','M35 20 31 5c-1-11 7-5 9 1l4 12m1-1 7-14c5-7 9-1 5 7l-8 13Z','M13 36q-11-4-11 4 0 8 13 5Z',[[50,24]],'reed'),'translate(1 3) scale(.94)'),

 turtle:art('sage',p('tail',10,34,[s('M11 31 3 33q-3 2 0 3l9 1Z','soft')]),p('hind',18,38,[s('M15 36c-5 1-9 5-8 8 1 3 7 2 11-2l3-4Z','soft'),s('m29 38 2 8c1 4 6 4 7 1l-3-9Z','soft')]),p('head',42,31,[s('M40 27c5-1 5-6 11-7 6-1 11 2 11 6 0 5-6 8-12 7l-8 3Z','soft'),s('m57.3 29.5 2.3-.5','deep',true,.7)],[[55.2,25.2]]),p('fore',36,38,[s('M37 36c3 0 7 4 9 7 1 3-2 5-5 3l-8-6Z','soft')]),p('shell',28,33,[s('M8 37C8 24 17 16 29 16c12 0 20 9 18 21-4 8-29 13-39 0Z'),s('M8 36c10 7 29 8 39-2l-.4 4c-7 10-29 10-38.6 0Z','deep'),s('m23 22 10-1 7 9-6 9-11-1-6-9Z','plate'),s('m23 22 10-1 7 9-6 9-11-1-6-9Zm0 0-3-4m13 3 3-3m4 12 7 1m-13 8 2 4m-13-5-4 5m-2-14-6-2','deep',true,.8,.8),s('M14 26c3-5 7-7 13-7','soft',true,1.3,.55)])),
 softshell:art('sage',p('hind',27,34,[s('m16 28-8-9q-4 0-3 4l9 12m1 3L7 48q3 5 7 0l9-9m17-1 11 11q5-2 1-6l-9-9','soft')]),p('head',44,32,[s('M40 29q7-10 12-4l11 4-1 3-11 2-9 4Z','soft')],[[53,28]]),p('fore',36,35,[s('m35 27 13-10q4 1 1 5L40 33Z','soft')]),p('shell',28,33,[s(oval(28,33,21,13)),s(oval(27,32,15,9),'plate'),s('M14 34q13 7 28-1','deep',true,.8,.65)])),
 frog:frog(17,21,'M23 33q9-3 18 0l-2 11H25Z','M17 32Q3 28 3 43q-1 10 15 7l7-8m22-10q14-4 14 11 1 10-15 7l-7-8'),
 'tree-frog':frog(14,17,'M25 31q7-3 14 0l2 13H23Z','M19 34Q5 28 6 39l6 7-8 6m41-18q14-6 13 5l-6 7 8 6','reed','M18 38 8 44m38-6 10 6'),
 toad:frog(20,24,'M20 35q12-6 24 0l-3 10H23Z','M17 33Q1 34 4 48l16 1m27-16q16 1 13 15l-16 1','clay','M18 29h1m27 0h1m-27 9h1m7 5h1m16-5h1'),
 crocodile:art('sage',p('tail',18,37,[s('M21 30Q7 28 2 43q10-7 22-2Z','deep')]),p('hind',25,39,[s('m23 36-8 10q-1 5 6 3l9-9','soft')]),p('shell',32,34,[s('M13 35q4-13 24-10 14 2 18 12-17 10-42-2Z'),s('m17 28 5-6 6 5 5-6 5 6 6-3 4 5','deep')]),p('head',44,33,[s('M40 29q4-12 12-5l10 7q3 5-4 7H43Z','soft'),s('M45 33h14','deep',true,.85)],[[51,27]]),p('fore',41,38,[s('m39 35 10 11q5 6 8 1L46 36Z','soft')])),
 salamander:art('rose',p('tail',22,36,[s('M25 32C5 22-4 40 10 48q8 4 16-5-13 6-17-1-6-8 15-5Z','deep')]),p('hind',25,38,[s('M23 36 13 44l-5-1m23-5-8 13 6 1','soft',true,3)]),p('shell',34,35,[s('M18 35q4-13 22-9 13 4 8 14-18 9-30-5Z'),s('m25 30 5 1m4 0 4 1','plate',true,1.5)]),p('fore',43,37,[s('m42 34 9 9 7-2m-18-3 4 11 6-1','soft',true,3)]),p('head',46,30,[s('M41 30q1-13 14-9 8 3 7 9-6 7-18 6Z','soft')],[[55,26]])),
 newt:art('clay',p('tail',22,37,[s('M25 33C10 24 1 33 3 43q5 15 22 0-14 7-17-1-2-8 16-5Z','deep')]),p('hind',24,38,[s('m24 36-12 7-6-3m24-2-7 12 6 2','soft',true,2.3)]),p('shell',34,35,[s('M18 35q3-10 20-9 16 3 11 13-17 12-31-4Z'),s('M23 32q8-4 18 2','plate',true,2)]),p('fore',44,36,[s('m43 33 10 8 6-3m-18 1 5 11 6-2','soft',true,2.3)]),p('head',47,30,[s('M42 29q3-13 16-7 8 4 2 10l-16 3Z','soft')],[[55,26]])),
 lizard:art('reed',p('tail',23,38,[s('M26 33Q7 27 2 47q13-13 25-6Z','deep')]),p('hind',26,39,[s('m25 35-13 7-7-3m26-1-9 13 8 1','soft',true,2.7)]),p('shell',35,35,[s('M19 35q6-15 24-10 12 6 6 16-18 9-30-6Z'),s('M24 31q8-4 17 1','plate',true,1.6)]),p('fore',45,36,[s('m43 32 12 8 7-3m-19 1 3 12 8-1','soft',true,2.5)]),p('head',48,29,[s('M43 28q3-13 15-7l6 8-13 7-8-2Z','soft')],[[55,25]])),
 chameleon:art('reed',p('tail',20,37,[s('M25 33C4 23 0 47 14 48c12 1 12-17 3-16-6 0-5 9 0 6-5 1-4-4 0-4 8 0 6 11-2 11-10-1-5-17 9-10Z','deep')]),p('hind',26,35,[s('m24 35-7 14h8l3-12','soft')]),p('shell',33,31,[s('M15 35q5-20 23-17 14 2 14 17-19 12-37 0Z'),s('m20 25 5-7 5 5 5-8 6 7','plate')]),p('head',45,27,[s('M36 27q0-12 14-11l4-9 5 16 5 6-12 10-14-5Z','soft')],[[53,24]]),p('fore',43,34,[s('m41 34 7 14h7l-9-14','soft')])),
 crab:art('rose',p('hind',32,38,[s('M19 35 6 34m13 7L5 45m40-10 13-1M45 41l14 4','soft',true,2.5)]),p('shell',32,36,[s(oval(32,36,17,13)),s('M20 36q12 8 24 0','plate',true,3)]),p('fore',32,29,[s('M18 31Q1 24 8 13l2 8 6-6q8 11 2 16Zm28 0q17-7 10-18l-2 8-6-6q-8 11-2 16Z','soft')]),p('head',32,25,[s('M25 27v-8m14 8v-8','soft',true,3)],[[25,18],[39,18]])),
 lobster:art('rose',p('tail',32,43,[s('M27 43 18 55q8 5 14-2 6 7 14 2l-9-12Z','plate')]),p('hind',32,33,[s('m27 32-16 6m16 0-13 9m23-15 16 6m-16 0 13 9','soft',true,2.3)]),p('shell',32,33,[s('M26 20q6-4 12 0l2 21q-8 14-16 0Z'),s('M25 34h14m-13 7h12','deep',true,1)]),p('fore',32,25,[s('M25 28C7 33 0 16 9 10l-1 9 8-6q10 2 9 15Zm14 0c18 5 25-12 16-18l1 9-8-6q-10 2-9 15Z','soft')]),p('head',32,20,[s('M28 18 20 8m16 10 8-10','soft',true,1.2)],[[28,21],[36,21]])),
 'water-snake':art('sage',p('tail',25,45,[s('M29 43Q6 35 5 50q9-6 23 2Z','deep')]),p('shell',32,37,[s('M15 42c-2-12 25-16 27-6 3 14-32 16-25 6 2-4 12-5 13-2-6-1-9 2-6 4 11 2 20-6 11-9-14-4-27 6-20 7Z')]),p('head',44,26,[s('M36 38c17-6-13-15 0-26 8-7 23-2 22 8-3 6-13 5-17 1-5 4 17 12 2 23Z','soft')],[[49,15]])),

 kingfisher:songbird('M18 29q-2-15 14-16 21 2 16 23-4 14-22 12Z','M30 22q-3-17 12-17 17 1 11 18l-13 7Z','M24 40 7 56q-5-4 4-21Z','M22 28q14-7 16 13-12 9-16-13Z','M50 16 64 21l-14 3Z',[[45,15]],'river'),
 hummingbird:airborne(songbird('M18 30q12-15 25-4 2 14-18 17Z','M37 25q-1-14 11-14 11 1 8 12l-11 8Z','M26 37 6 55l8-25Z','M28 30C3 24 6 1 12 6l20 20Z','M53 18 64 12l-8 10Z',[[49,17]],'sage')),
 swallow:airborne(songbird('M19 30q12-13 24-4 5 12-14 16Z','M36 24q-1-12 10-12 10 1 8 10l-12 7Z','M30 37 7 56l7-19L3 24l25 8Z','M28 30C13 12 3 7 3 17q0 11 22 20Zm5-1C46 4 61 3 59 15q-1 10-22 19Z','M52 19 63 21l-12 4Z',[[48,18]],'slate')),
 swift:airborne(songbird('M21 30q9-13 20-4 6 13-12 19Z','M35 25q-1-12 10-12 11 1 9 11l-13 6Z','M29 39 13 56l3-19L5 27l23 7Z','M27 31C11 28 2 7 5 5q16 1 26 23Zm7-2C43 12 57 3 61 6q-3 20-24 28Z','M52 19 63 23l-12 2Z',[[47,19]],'slate')),
 robin:songbird('M13 32q-1-17 18-18 21 2 19 22-4 15-23 14Z','M31 23q-3-15 12-15 16 1 12 17l-15 6Z','M23 41 7 50l6-19Z','M18 29q12-5 16 12-11 9-16-12Z','M53 19 62 23l-10 3Z',[[47,18]],'rose'),
 tit:songbird('M14 33q1-17 18-18 20 1 17 21-4 14-21 12Z','M31 23q-2-14 13-14 14 1 10 16l-14 5Z','M24 42 7 53l7-22Z','M19 30q13-5 16 12-13 8-16-12Z','M52 19 62 22l-10 3Z',[[47,18]],'reed','M31 18q12-13 23 1l-6-11-15 2Z'),
 sparrow:songbird('M13 34q1-16 19-17 20 1 17 21-5 13-22 11Z','M31 24q-3-15 12-15 16 2 12 16l-15 6Z','M24 43 6 50l8-18Z','M18 30q15-5 18 12-13 9-18-12Z','M53 21 62 24l-10 3Z',[[47,20]],'clay','M32 14q10-8 19 0l4 7-6-4-15 1Z'),
 redstart:songbird('M15 31q2-16 20-15 18 4 12 23-7 15-23 9Z','M32 22q-2-13 12-13 15 2 11 17l-16 4Z','M23 41 4 56 9 32l18 5Z','M20 28q14-4 15 15-13 5-15-15Z','M53 20 63 23l-11 3Z',[[47,19]],'rose'),
 woodpecker:songbird('M18 29q-1-15 17-15 18 3 12 24-7 14-21 11Z','M33 23 34 9l11-6 10 11-2 11-14 6Z','M25 40 8 57l2-23Z','M23 28q12-5 14 14-13 8-14-14Z','M52 16 64 21l-13 4Z',[[47,15]],'clay','M34 10 44 1l8 9Z'),
 owl:songbird('M12 31q1-13 20-13 20 0 20 14-1 21-20 21T12 31Z','M14 26 12 7l13 7h14L52 7l-2 19q-18 12-36 0Z','M25 46 20 56l12-6 12 6-5-10Z','M15 29q11 2 11 18-12 2-11-18Zm34 0q-11 2-11 18 12 2 11-18Z','M29 27q3-4 6 0l-3 5Z',[[23,23],[41,23]],'clay'),
 eagle:airborne(songbird('M20 32q9-16 20-6 7 15-8 23Z','M35 25q-1-14 12-14 15 0 11 13l-15 7Z','M29 43 18 57l15-6 13 6-7-16Z','M27 31C8 29 0 10 4 8q15 0 27 20Zm8-2C48 8 61 7 62 13q-3 20-23 24Z','M53 17q13-1 8 9l-4 2 1-7-7 2Z',[[49,18]],'clay')),
 magpie:songbird('M18 29q0-15 18-14 18 3 12 24-6 15-22 10Z','M33 23q-3-15 12-15 15 1 10 17l-15 7Z','M26 41 6 62 10 34l21 5Z','M22 29q15-6 16 14-12 7-16-14Z','M53 20 64 23l-12 3Z',[[48,18]],'slate'),
 parrot:songbird('M16 30q1-17 19-16 20 3 14 25-6 16-24 11Z','M30 25q-5-20 14-21 20 1 14 22l-17 8Z','M25 42 9 59l7-25Z','M21 29q14-6 16 15-13 8-16-15Z','M51 14q13 1 9 13l-4 5-1-12-7 1Z',[[46,15]],'sage'),

 dragonfly:bug('M29 22h6l-1 35h-4Z','M29 28C1 5-4 21 11 29l18 4Zm6 0C63 5 68 21 53 29l-18 4Zm-6 7C5 24 1 43 17 42l12-5Zm6 0c24-11 28 8 12 7l-12-5Z','M29 33 19 44m16-11 10 11',[[29,18],[35,18]],'river'),
 damselfly:bug('M30 22h4v36h-4Z','M29 28C5 11 8 2 16 8l15 20Zm6 0C59 11 56 2 48 8L33 28Z','M29 32 19 43m16-11 10 11',[[29.5,18],[34.5,18]],'sage'),
 butterfly:bug('M29 22q3-3 6 0l-1 29h-4Z','M29 28C12-6-5 14 12 31 0 49 18 62 29 37Zm6 0C52-6 69 14 52 31c12 18-6 31-17 6Z','M30 35 22 45m12-10 8 10',[[30,18],[34,18]],'rose','M12 19q3 7 12 12M52 19q-3 7-12 12M16 44l7-6m25 6-7-6'),
 moth:bug('M28 21q4-3 8 0l-2 32h-4Z','M29 26C10 3 1 13 10 32 0 48 17 56 29 37Zm6 0C54 3 63 13 54 32c10 16-7 24-19 5Z','M29 35 20 44m15-9 9 9',[[29,18],[35,18]],'clay','M13 26 24 32m27-6-11 6','M28 16 20 7m16 9 8-9'),
 bee:bug('M24 28q8-7 16 0 12 23-8 28-20-5-8-28Z','M29 29C4 27 4 8 15 13l16 13Zm6 0c25-2 25-21 14-16L33 26Z','M25 37 17 44m22-7 8 7',[[29,19],[35,19]],'gold','M22 36h20m-19 9h18'),
 wasp:bug('M28 27h8l-2 9q18 6-2 23-20-17-2-23Z','M30 28 9 14q-8 15 20 20Zm4 0 21-14q8 15-20 20Z','M26 35 14 46m24-11 12 11',[[29,18],[35,18]],'gold','M23 44h18m-13 7h8'),
 ladybug:bug('M20 27q12-11 24 0 17 28-12 29T20 27Z','M23 29q9-7 18 0v21H23Z','M21 29 9 25m11 13-13 3m15 5L12 55m31-26 12-4m-11 13 13 3m-15 5 10 9',[[29,18],[35,18]],'rose','M32 26v27m-10-17h1m18 0h1M22 44h1m18 0h1'),
 beetle:bug('M22 24q10-9 20 0 19 31-10 33T22 24Z','M25 27q7-4 14 0v24H25Z','M22 29 8 30l8 6m4 6L9 52m33-23 14 1-8 6m-4 6 11 10',[[29,17],[35,17]],'reed','M32 25v30m-9-23h18','M28 15 18 6m18 9 10-9'),
 firefly:bug('M27 23q5-4 10 0l5 20q-10 19-20 0Z','M28 28C7 13 0 34 25 35Zm8 0c21-15 28 6 3 7Z','M26 33 14 25m24 8 12-8',[[29,17],[35,17]],'gold','M24 43h16m-13 7h10'),
 mantis:bug('M29 24h6l5 29-8 6-8-6Z','M30 29 22 47l9 6m3-24 8 18-9 6','M28 26 10 14 6 34l12-7m18-1 18-12 4 20-12-7M28 43 13 57m23-14 15 14',[[27,17],[37,17]],'sage','M31 26v27','M27 15 20 7m17 8 7-8'),
 grasshopper:bug('M12 32q14-10 28-7l8 13q-17 19-36 5Z','M20 32q11-9 20-4l-7 14Z','M18 39 3 51h18m17-15 16 19h8m-17-28 1-19 8-3',[[29,18],[35,18]],'reed','M17 36 34 42','M28 14 23 5m13 9 8-9'),
 'water-strider':bug('M29 24h6l-1 32h-4Z','M29 27q-10-11-12-3l12 9m6-6q10-11 12-3l-12 9','M29 25 8 8m27 17L56 8M29 33 3 40m32-7 26 7M29 43 9 59m26-16 20 16',[[29,18],[35,18]],'slate'),

 duck:swimmer(11,'M35 40q8-5 2-14-5-15 10-15 13 1 10 16l-9 5-3 11Z','M15 37 4 31q-3 13 13 15Z','M14 38q12-11 25 0-10 11-25 0Z','sage'),
 mandarin:swimmer(11,'M36 41q8-9 2-17-3-13 11-13 14 2 8 17l-10 4-2 11Z','M15 37 3 29q-2 13 13 17Z','M17 40 22 18q12 8 14 23-10 8-19-1Z','clay','M41 18q-6-10-3-13l8 9Z'),
 mallard:swimmer(12,'M36 40q7-7 1-16-4-14 11-14 14 1 8 17l-9 5-1 11Z','M15 37 3 33q1 11 14 13Z','M13 39q13-12 26 0-11 12-26 0Z','sage','M37 27q9 5 16 1l-1 4-14-1Z'),
 grebe:swimmer(9,'M36 40q6-6 3-13-4-13 10-12 12 1 7 15l-10 3-1 10Z','M15 37 5 35q1 9 13 11Z','M14 38q12-8 24 1-9 9-24-1Z','clay'),
 coot:swimmer(12,'M35 41q7-7 3-17-2-14 12-12 12 2 6 16l-11 6-1 10Z','M16 37 5 34q-1 10 12 12Z','M13 38q12-11 25 1-10 11-25-1Z','slate','M46 16q-6 5-3 12l5 2 4-10Z'),
 loon:swimmer(8,'M37 40 40 18q6-11 15-2l-2 12-7 13Z','M14 37 2 35q4 11 17 10Z','M12 39q14-10 26 1-11 9-26-1Z','slate'),
 'crested-grebe':swimmer(10,'M35 41q10-8 3-17-2-13 11-11 13 2 7 16l-12 4 1 11Z','M14 38 3 32q-1 13 14 14Z','M13 38q12-9 25 2-12 10-25-2Z','clay','M40 17 33 6l13 8L53 4l1 17Z'),
 shelduck:swimmer(13,'M35 40q9-6 1-18-3-13 12-12 15 2 8 18l-11 5-1 11Z','M14 37 3 29q-2 14 14 17Z','M13 38q15-12 27 1-10 11-27-1Z','rose','M37 29q9 6 18-1l-3 6-13 1Z'),
 gull:airborne(songbird('M20 31q12-13 23-2 2 14-16 15Z','M35 25q-1-11 11-11 11 1 7 13l-11 3Z','M28 38 17 52l14-6 11 6-8-13Z','M27 30 8 10Q2 9 3 20q6 14 24 17Zm8 0L54 8q7-2 7 9-7 16-26 20Z','M51 21 63 25l-12 3Z',[[47,20]],'slate')),
 tern:airborne(songbird('M20 30q11-12 22-1 3 13-15 14Z','M34 25q0-12 12-12 12 2 7 14l-11 2Z','M29 39 10 57l8-18-9-9 21 5Z','M26 30 6 7q-5-3-4 8 6 15 25 22Zm9-1L57 5q6-2 5 8-5 17-25 23Z','M51 21 64 25l-13 2Z',[[47,20]],'river')),
 penguin:songbird('M17 23q15-12 30 0 16 32-15 33T17 23Z','M22 23q-7-21 10-21t10 21Z','M24 50 17 57l15-2 15 2-7-8Z','M18 25Q1 43 9 47l15-15Zm28 0q17 18 9 22L40 32Z','M28 18h8l-4 6Z',[[27,15],[37,15]],'slate'),
 puffin:songbird('M17 27q12-15 25-3 16 23-7 31-23 0-18-28Z','M23 25q-4-20 12-20 19 1 15 22l-15 8Z','M25 49 18 57l14-5 9 5-4-11Z','M21 28q12-3 16 20-14 7-16-20Z','M45 15q17 0 17 14l-15 2Z',[[39,17]],'clay'),

 fish:fish('M6 32C17 14 37 13 49 32 37 51 17 50 6 32Z','M45 29 60 17q-4 15 0 30L45 35Z','M25 19 32 9l6 12M25 45l8 11 5-13Z','M18 22q8 10 0 20',[14,28]),
 goldfish:fish('M6 31c0-16 32-18 39 1-8 21-39 16-39-1Z','M41 28q16-22 20-13l-5 18 6 18q-8 7-22-15Z','M23 18q0-15 12-12l4 16m-17 22q5 18 17 11l-4-13Z','M16 23q7 8 0 16',[13,27],'gold'),
 koi:fish('M5 32c13-19 33-16 44 1-16 18-35 17-44-1Z','M44 29 61 18l-3 15 3 14-17-12Z','M24 20q3-12 10-13l6 16m-16 21 8 13 7-15Z','M19 21q10 3 8 19m5-17 5 11M7 33l-3 7',[13,28],'rose'),
 perch:fish('M6 33q17-25 43-1-21 24-43 1Z','M44 28 61 17l-4 17 4 13-17-12Z','M19 20 23 7l8 9 7-10 6 18m-21 22 9 9 7-13Z','M23 23v18m8-20v24m8-20v14',[13,29],'reed'),
 trout:fish('M3 33c16-24 35-18 47-1-16 19-35 20-47 1Z','M45 29 62 18l-4 15 4 14-18-12Z','M26 20 30 9l10 14M24 45l7 10 8-12Z','M22 28h1m8-4h1m7 5h1m-17 8h1m9 2h1',[11,29]),
 salmon:fish('M3 34 12 22q16-12 39 11-19 22-40 9Z','M45 29 62 16l-5 17 5 15-17-12Z','M25 21 32 8l6 16M23 44l5 12 12-12Z','M16 25q6 9 0 15m15-14 9 8',[11,30],'rose'),
 eel:fish('M3 33c8-19 15-9 26 0 11 10 19 4 31-7-4 24-22 23-36 10-12-12-15 1-21-3Z','M47 34q8-3 14-12-2 16-14 20Z','M19 32q-1 12 9 14l-5-11Z','M15 29q16 21 34 11',[9,30],'slate'),
 catfish:fish('M5 32c4-18 29-17 44 0-15 18-40 18-44 0Z','M44 29 61 18l-4 15 4 15-17-12Z','M25 20 32 7l6 16M14 33Q1 49 5 52m10-16 8 13','M21 23q6 9 0 17',[13,27],'clay'),
 sturgeon:fish('M2 33 17 22q17-9 34 11l-17 13-22-7 6-5Z','M45 29 62 14l-6 20 6 13-17-11Z','M27 22 36 7l5 18M26 43l6 14 10-13Z','m20 28 5-3 5 6 5-3 6 7',[15,29],'clay'),
 stingray:fish('M32 6Q15 14 3 33q13 10 29 12 16-2 29-12Q49 14 32 6Z','M29 40q-1 19 21 20l-10-7-5-13Z','M12 31q10 1 15 10m25-10q-10 1-15 10','M18 31q6 6 11 7m17-7q-6 6-11 7',[25,26],'river'),
 pufferfish:fish('M8 31q0-23 21-23 22 0 22 24T29 55Q8 54 8 31Z','M47 29 61 21v23L47 35Z','m17 13-3-7m22 5 4-7M11 24l-7-1m7 17-7 3m14 5-2 9m24-8 5 6','M21 22h1m10-5h1m8 10h1m-22 9h1m14 8h1',[16,27],'gold'),
 seahorse:fish('M27 9q12-7 19 5 4 10-10 15-10 4 1 12 17 11 4 19-17 8-22-8-1-9 10-8l-3 6q-6-3-2 4 6 7 13 1 2-5-8-9-18-9-11-23L9 23l1-8 14 1Z','M24 42q19 4 16 12-4 10-16 3l1-5q9 7 11 1 0-4-12-6Z','M23 27 13 38l13 3Z','M31 31l7 6m-8-18 10 3',[31,16],'rose'),

 lotus:plant('M32 46v11','M32 48C8 43 3 27 9 22q15 0 23 19 8-19 23-19 6 21-23 26Z','M32 27v18','sage','M32 45C14 29 20 9 32 5c12 4 18 24 0 40ZM32 45C11 36 8 18 16 13q12 5 16 22 4-17 16-22 8 5 3 24Q42 48 32 45Z'),
 'water-lily':plant('M32 47v9','M4 54q11-16 28-7 17-9 28 7-28 11-56 0Z','M32 24v20','reed','M32 47C7 44 1 25 9 18l19 15C17 17 24 7 32 3c8 4 15 14 4 30l19-15c8 7 2 26-23 29Z'),
 reed:plant('M23 57V14m17 43V11','M22 47Q3 45 4 29q17 2 18 18Zm19-11q18-4 17-20-17 6-17 20Z','M21 17V6m19 8V3','reed','M19 24V10q4-11 8 0v14q-4 7-8 0Zm17-6V6q4-10 8 0v12q-4 7-8 0Z'),
 cattail:plant('M19 57V20m24 37V15','M22 55C15 31 6 28 4 33q3 17 18 22Zm17 1q2-20 22-27-1 21-22 27Z','M20 9v18m23-24v21','clay','M15 24V8q4-11 8 0v16q-4 10-8 0Zm24-5V5q4-10 8 0v14q-4 10-8 0Z'),
 'lotus-leaf':plant('M32 34q0 16 8 25','M31 5C1 3-5 40 29 47c34 4 43-41 2-42Z','M32 25 14 14m18 11L48 12M32 25 9 32m23-7 23 8m-23-8-2 17'),
 clover:plant('M31 34q0 15 5 25','M30 33C0 39-2 12 12 11q13 0 18 18C21 10 27 0 36 4c11 6 6 19-2 27C52 14 65 22 58 35c-6 13-20 11-24 1Z','M29 31 13 20m20 9 2-16m2 20 13-3','reed'),
 ginkgo:plant('M31 38q0 12 5 22','M32 48C6 33-2 20 5 9q10-9 27 11 17-20 27-11 7 11-1 24Q45 43 32 48Z','M32 43 12 16m20 27L52 16M32 43 23 11m9 32 9-32','gold'),
 fern:plant('M32 58 35 5','M30 48Q4 52 6 35q19-2 24 13Zm4-9q28 0 22-18-18 0-22 18ZM31 32Q7 33 9 19q18 1 22 13Zm4-8q21-2 18-15-15 0-18 15ZM32 17Q17 17 20 6q11 0 12 11Z','M12 41l17 6m8-9 13-3M15 24l15 7m7-14 10-4'),
 willow:plant('M29 57 32 15h2l4 42','M33 5C2 4-2 27 7 51h4C4 31 10 16 24 12 10 29 15 45 20 54h4C15 34 24 15 31 12c-5 18-3 32 3 43h4C30 34 33 17 37 12 50 24 52 37 48 53h5C65 23 58 5 33 5Z','M17 18q-8 14-2 28m31-27q9 16 5 26'),
 pine:plant('M32 43v16','M32 4Q20 13 12 24l11-1Q12 32 5 39l16 1L7 52q24 7 50 0L43 40l16-1Q52 30 41 23l11 1Q44 12 32 4Z','M32 16v32m-10-8 10 6 12-7','sage'),
 'cherry-blossom':fitted(plant('M32 34 35 58','M32 29C9-3-2 17 16 30-10 28 0 57 24 44c-8 27 25 23 20 3 23 16 35-12 13-17 22-16-1-36-13-10Z','M32 32 20 17m12 15 16-17m-16 17L13 34m19-2 14 14m-14-14-4 19','rose'),'translate(2 1) scale(.88)'),
 dandelion:plant('M32 31v27','M30 51Q7 52 9 39q15 0 21 12Zm5-7q18-2 23-13-18-2-23 13Z','M32 26V5M27 27 12 11m13 21H4m23 5L11 50m27-23 15-16M39 32h21M37 38l15 13','gold','M26 26q6-6 12 0v12q-6 6-12 0ZM29 7q3-6 6 0v6h-6ZM10 11q3-4 6 0l4 5-4 4ZM4 29h8v6H4m44-18 5-6q6-2 5 5l-6 5Zm5 12h8v6h-8M11 46l5-5 4 4-5 6Zm37-4 8 6q2 6-5 5l-7-8Z'),
};
