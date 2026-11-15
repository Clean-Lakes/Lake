import type {LakeAvatarName} from './lakeAvatarCatalog';

export type ThinkingMotionChannel='body'|'head'|'fore'|'other'|'tail'|'wing'|'shell'|'ear';
export type LakeAvatarThinkingDefinition={
 label:string;
 durationMs:number;
 /** Contact height after artwork.fit, in the 64px viewBox, not the SVG box bottom. */
 foot:number;
 side:'left'|'right';
 poses:Partial<Record<ThinkingMotionChannel,readonly string[]>>;
};

// The last 30% is a deliberate rest. These gestures express thinking only;
// they do not project tool execution, task progress or completion.
export const thinkingPoseOffsets=[0,.12,.22,.32,.44,.58,.7,1] as const;
const restingLook=['r0','r-7','r-7','r0','r8','r4','r0','r0'];
const lightWing=['r0','r-3','r-3','r0','r3','r1','r0','r0'];
const quietTail=['r0','r-5','r-5','r4','r7','r2','r0','r0'];
const gestures={
 watching:{head:restingLook,wing:lightWing},
 sniffing:{head:['t0,0','t1,-.5','t3,-.5','t3,-.5r-6','t2,0r-6','t1,0','t0,0','t0,0'],fore:['r0','r-5','r-8','r-5','r0','r0','r0','r0'],tail:quietTail},
 reaching:{head:['t0,0','t1,0','t3,0','t4,-.5r-5','t4,-.5r-5','t2,0','t0,0','t0,0'],fore:['r0','r0','r-5','r-8','r-8','r-3','r0','r0']},
 hovering:{body:['t0,0','t0,-1','t1,-2','t1,-2','t0,-1','t0,0','t0,0','t0,0'],head:restingLook,wing:['s1,1','s.8,1','s1,1','s.8,1','s1,1','s.9,1','s1,1','s1,1']},
 swimming:{head:restingLook,wing:lightWing,tail:quietTail},
 finning:{tail:['r0','r-8','r-5','r7','r8','r3','r0','r0'],wing:['r0','r-5','r-5','r3','r5','r1','r0','r0']},
 curling:{head:restingLook,tail:['r0','r-8','r-8','r2','r8','r3','r0','r0']},
 foliage:{wing:['r0','r-3','r-3','r0','r3','r1','r0','r0']},
} satisfies Record<string,LakeAvatarThinkingDefinition['poses']>;
function t(label:string,gesture:keyof typeof gestures,foot:number,durationMs=4600,side:'left'|'right'='left'):LakeAvatarThinkingDefinition{
 return {label,durationMs,foot,side,poses:gestures[gesture]};
}

/** Text and border choreography share the exact resolved avatar identity. */
export const lakeAvatarThinking:Record<LakeAvatarName,LakeAvatarThinkingDefinition>={
 heron:t('正在伸颈寻思中','watching',58,4800),
 crane:t('正在舒翼凝思中','watching',59,5000),
 egret:t('正在垂首推想中','watching',59,4800),
 stork:t('正在点头斟酌中','watching',59,5000),
 ibis:t('正在低首琢磨中','watching',59,4600),
 spoonbill:t('正在摆喙推敲中','watching',59,4800),
 flamingo:t('正在独立凝神中','watching',59,5200),
 swan:t('正在回首理思中','swimming',50,5200),
 goose:t('正在伸颈盘思中','swimming',51,4800),
 cormorant:t('正在收翼思量中','watching',57,5000),
 pelican:t('正在低喙寻思中','watching',58,5000),
 avocet:t('正在侧喙推演中','watching',59,4800),
 sandpiper:t('正在点首琢磨中','watching',58,4200),

 otter:{label:'正在搓爪琢磨中',durationMs:4200,foot:51,side:'left',poses:{
  head:['r0','r0','r0','r0','r-10','r-10','r0','r0'],
  fore:['t0,0r-22','t1,-1r-28','t-1,0r-18','t1,-1r-28','t0,0r-22','t0,0r-22','t0,0r-22','t0,0r-22'],
  other:['t-7,1r8','t-6,0r14','t-8,1r4','t-6,0r14','t-7,1r8','t-7,1r8','t-7,1r8','t-7,1r8'],
  tail:['r0','r0','r0','r0','r5','r5','r0','r0'],
 }},
 beaver:{label:'正在搭建思路中',durationMs:4600,foot:50,side:'left',poses:{
  body:['t0,0','t2,0','t2,0','t0,0','t0,0','t0,0','t0,0','t0,0'],
  fore:['r0','r-12','r0','r-12','r0','r0','r0','r0'],
  head:['r0','r3','r3','r0','r-9','r-9','r0','r0'],
  tail:['r0','r-7','r-7','r0','r3','r0','r0','r0'],
 }},
 nutria:t('正在探鼻寻思中','sniffing',50,4600),
 muskrat:t('正在侧首想办法中','sniffing',50,4400),
 seal:t('正在摆鳍琢磨中','sniffing',53,5000),
 'sea-lion':t('正在昂首思量中','sniffing',54,5000),
 capybara:t('正在静坐慢想中','sniffing',51,5600),
 hippo:t('正在抬鼻推敲中','sniffing',52,5400),
 'water-shrew':t('正在细嗅线索中','sniffing',51,4200),
 raccoon:t('正在抬爪理思中','sniffing',51,4600),
 mink:t('正在探身寻路中','sniffing',51,4400),
 fox:{label:'正在盘算办法中',durationMs:4600,foot:51,side:'right',poses:{
  ear:['t0,0','t0,-1.5','t0,-1.5','t0,0','t0,0','t0,0','t0,0','t0,0'],
  head:['r0','r-3','r-3','r-10','r-10','r0','r0','r0'],
  tail:['r0','r-3','r-3','r12','r17','r8','r0','r0'],
 }},
 rabbit:t('正在竖耳琢磨中','sniffing',51,4600),

 turtle:{label:'正在慢慢推演中',durationMs:5600,foot:46,side:'left',poses:{
  head:['t0,0r0','t1,0r0','t4,0r0','t6,-1r-7','t6,-1r-7','t3,0r0','t0,0r0','t0,0r0'],
  fore:['r0','r0','r-8','r-13','r-13','r-5','r0','r0'],
  tail:['r0','r0','r-4','r-4','r0','r0','r0','r0'],
 }},
 softshell:t('正在探颈细想中','reaching',49,5400),
 frog:t('正在伏身酝酿中','reaching',51,4600),
 'tree-frog':t('正在伸趾试想中','reaching',52,4600),
 toad:t('正在静伏斟酌中','reaching',50,5400),
 crocodile:t('正在抬吻盘算中','reaching',50,5200),
 salamander:t('正在侧首寻解中','reaching',52,4800),
 newt:t('正在探首推想中','reaching',52,4800),
 lizard:t('正在转首寻思中','reaching',52,4400),
 chameleon:t('正在凝望推敲中','reaching',49,5400),
 crab:t('正在举螯盘算中','reaching',49,4600),
 lobster:t('正在合钳琢磨中','reaching',58,4800),
 'water-snake':t('正在盘身理思中','curling',52,5200),

 kingfisher:t('正在俯首寻解中','watching',56,4600,'right'),
 hummingbird:t('正在悬停寻灵感中','hovering',54,3600,'right'),
 swallow:t('正在收翼回想中','watching',55,4200,'right'),
 swift:t('正在展翼推想中','watching',55,4000,'right'),
 robin:t('正在点头理思中','watching',56,4400,'right'),
 tit:t('正在侧首推敲中','watching',56,4200,'right'),
 sparrow:t('正在低头细想中','watching',56,4200,'right'),
 redstart:t('正在翘尾寻思中','swimming',56,4400,'right'),
 woodpecker:{label:'正在逐点琢磨中',durationMs:3800,foot:56,side:'right',poses:{
  head:['r0','t0,2r25','r0','t0,2r25','r-10','r-10','r0','r0'],
  wing:['r0','r3','r0','r3','r0','r0','r0','r0'],
 }},
 owl:{label:'正在歪头推敲中',durationMs:4800,foot:56,side:'right',poses:{
  head:['r0','r-12','r-12','r0','r13','r13','r0','r0'],
  wing:['r0','r-2','r-2','r0','r2','r2','r0','r0'],
 }},
 eagle:t('正在远望筹思中','watching',56,4800,'right'),
 magpie:t('正在扬尾盘思中','swimming',56,4600,'right'),
 parrot:t('正在偏首琢磨中','watching',56,4600,'right'),

 dragonfly:t('正在驻空推演中','hovering',57,3800,'right'),
 damselfly:t('正在合翅凝思中','hovering',58,4200,'right'),
 butterfly:t('正在翕翅寻灵感中','hovering',52,4400,'right'),
 moth:t('正在轻扇理思中','hovering',53,4400,'right'),
 bee:{label:'正在采集灵感中',durationMs:3800,foot:55,side:'right',poses:{
  body:['t0,0','t0,-3','t2,-3','t3,-1','t3,-1','t0,0','t0,0','t0,0'],
  head:['r0','r0','r8','r8','r0','r0','r0','r0'],
  wing:['s1,1','s.65,1','s1,1','s.65,1','s1,1','s.8,1','s1,1','s1,1'],
 }},
 wasp:t('正在探角寻解中','hovering',59,4000,'right'),
 ladybug:t('正在合翅盘算中','watching',56,4800),
 beetle:t('正在探角琢磨中','watching',57,5000),
 firefly:t('正在微光凝思中','hovering',54,4800,'right'),
 mantis:t('正在合臂推敲中','watching',59,5200),
 grasshopper:t('正在屈腿酝酿中','watching',55,4600),
 'water-strider':t('正在点水理思中','hovering',59,4600,'right'),

 duck:t('正在摆喙想办法中','swimming',51,4800),
 mandarin:t('正在回首斟酌中','swimming',51,5000),
 mallard:t('正在侧喙理思中','swimming',51,4800),
 grebe:t('正在探头寻思中','swimming',50,4800),
 coot:t('正在抬首推演中','swimming',51,5000),
 loon:t('正在伸颈细推中','swimming',50,5200),
 'crested-grebe':t('正在摇首琢磨中','swimming',50,5000),
 shelduck:t('正在昂首酝酿中','swimming',52,5000),
 gull:t('正在迎风寻思中','watching',52,4600,'right'),
 tern:t('正在收翼寻解中','watching',56,4400,'right'),
 penguin:t('正在摆翼盘算中','watching',57,4800,'right'),
 puffin:t('正在摆喙推想中','watching',57,4800,'right'),

 fish:t('正在摆尾理思中','finning',55,4600,'right'),
 goldfish:t('正在舒鳍琢磨中','finning',56,5000,'right'),
 koi:t('正在缓摆推演中','finning',57,5200,'right'),
 perch:t('正在展鳍斟酌中','finning',55,4800,'right'),
 trout:t('正在轻摆寻解中','finning',55,4400,'right'),
 salmon:t('正在摆鳍盘算中','finning',56,4600,'right'),
 eel:t('正在曲身推想中','curling',46,5000,'right'),
 catfish:t('正在探须寻思中','finning',52,5200,'right'),
 sturgeon:t('正在展鳍细想中','finning',57,5200,'right'),
 stingray:t('正在舒翼理思中','finning',59,5400,'right'),
 pufferfish:{label:'正在鼓着脑袋想中',durationMs:4800,foot:55,side:'right',poses:{
  shell:['s1,1','s1.04,1.04','s1.07,1.07','s1.07,1.07','s1.07,1.07','s1.02,1.02','s1,1','s1,1'],
  tail:['r0','r-7','r5','r-5','r3','r0','r0','r0'],
  wing:['r0','r-8','r-8','r4','r4','r0','r0','r0'],
  head:['t0,0','t-.5,0','t-1,-.5','t-1,-.5','t-1,-.5','t0,0','t0,0','t0,0'],
 }},
 seahorse:t('正在卷尾推敲中','curling',60,5400,'right'),

 lotus:t('正在舒瓣酝酿中','foliage',57,5600),
 'water-lily':t('正在合瓣凝思中','foliage',58,5800),
 reed:t('正在摇穗理思中','foliage',57,5400),
 cattail:t('正在摆穗推想中','foliage',57,5600),
 'lotus-leaf':t('正在摇叶酝酿中','foliage',59,5800),
 clover:t('正在舒叶寻灵感中','foliage',59,5400),
 ginkgo:t('正在展叶推敲中','foliage',60,5800),
 fern:t('正在卷叶推演中','foliage',58,6000),
 willow:t('正在垂枝细想中','foliage',57,6200),
 pine:t('正在摇梢凝思中','foliage',59,6000),
 'cherry-blossom':t('正在舒花酝酿中','foliage',52,5600),
 dandelion:t('正在随风寻灵感中','foliage',58,5800),
};
