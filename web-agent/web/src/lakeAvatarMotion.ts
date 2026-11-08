import type {LakeAvatarName} from './lakeAvatarCatalog';

type Transform=readonly [number,number,number,number?,number?];
const pose=(body:Transform,head:Transform=[0,0,0],wing=0,fore=0,hind=0,tail=0)=>({body,head,wing:[0,0,wing] as Transform,fore:[0,0,fore] as Transform,hind:[0,0,hind] as Transform,tail:[0,0,tail] as Transform});
// Anatomical gestures, not alternate speeds of a common bounce. Each species
// has its own ordered six-beat phrases for both work and conversation entry.
const poses={
 rest:pose([0,0,0]),lookL:pose([-.3,0,0],[-1,0,-9],-2),lookR:pose([.3,0,0],[1,0,9],2),
 nod:pose([0,.3,0],[0,1,11],0,-3),dip:pose([0,1.2,3],[1,1,15],-5,-7,4),rise:pose([0,-1.7,-1,1,1.025],[0,-1,-5],5,5,-3),
 stepL:pose([-1.8,-.4,-2],[.5,0,2],-3,-19,12,7),stepR:pose([1.8,-.4,2],[-.5,0,-2],3,12,-19,-7),
 crouch:pose([0,2,0,1.05,.92],[0,1,3],-8,-14,16),spring:pose([0,-3.3,0,.97,1.04],[0,-.5,-4],18,14,-14),
 reach:pose([.7,0,-1],[2.5,-.5,-4],6,-22,5,-7),sniff:pose([.4,.1,0],[2,-.6,-6],-2,-4,4,3),
 wash:pose([0,.6,-2],[-1,1.5,12],-4,-28,5,-5),shake:pose([.8,-.4,4],[0,0,-7],12,6,-8,13),
 glideL:pose([-3,-.6,-3],[0,0,2],-7,-9,5,18),glideR:pose([3,.4,3],[0,0,-2],7,5,-9,-18),
 hover:pose([0,-2,0],[1,0,-2],32,-5,3,5),flap:pose([0,-1.2,-1],[0,-.5,-3],-36,7,4,-6),
 spread:pose([0,-.7,0,1.02,1],[0,0,-4],26,19,-16,11),fold:pose([0,.5,0,.98,1],[0,1,4],-18,-12,10,-11),
 peck:pose([1,1.2,7],[2,2,18],-6,-7,4,5),settle:pose([0,.9,0],[0,0,1],-8,3,5,-3),
 curlL:pose([-1,0,-7,.97,1.02],[-.5,0,-4],-6,-11,8,25),curlR:pose([1,0,7,.97,1.02],[.5,0,4],6,8,-11,-25),
 swell:pose([0,-.4,0,1.06,1.07],[0,-.5,0],13,6,-6,8),slim:pose([0,.3,0,.95,1.02],[1,0,-2],-10,-5,5,-9),
 swayL:pose([-.7,0,-3],[0,0,-5],-12,-5,4,7),swayR:pose([.7,0,3],[0,0,5],12,4,-5,-7),
 unfurl:pose([0,-1.2,0,1.02,1.025],[0,-.7,-2],18,7,-4,4),quiver:pose([.5,-.3,-1],[0,0,3],-13,-8,7,-12),
} as const;
type PoseName=keyof typeof poses;
function phrase(value:string):readonly PoseName[]{
 const beats=value.split(' ');
 if(beats.length!==6||beats.some(beat=>!(beat in poses)))throw new Error(`Invalid avatar choreography: ${value}`);
 return beats as PoseName[];
}
function m(label:string,working:string,greeting:string,workMs=3800,greetMs=1350){return {label,working:phrase(working),greeting:phrase(greeting),workMs,greetMs};}
export const lakeAvatarMotions={
 heron:m('探水抬首','lookL reach dip rest rise stepR','rise lookR nod rest stepL settle'),
 crane:m('单足舒翼','stepL rest rise spread fold stepR','rise spread rest lookL nod settle',4300,1500),
 egret:m('伸颈理羽','reach dip rest wash rise lookR','reach rise spread fold nod settle',4100,1450),
 stork:m('稳步点头','stepR nod rest stepL lookR rise','stepR rise nod lookL rest settle',4200),
 ibis:m('低首巡水','dip peck rest lookL reach rise','lookR dip rest rise nod settle',3900),
 spoonbill:m('摆首觅食','lookL dip lookR dip rest rise','lookL reach lookR rise rest settle',4400,1450),
 flamingo:m('屈膝展身','crouch rest rise spread fold lookR','stepL rise spread lookR rest settle',4700,1550),
 swan:m('缓游回望','glideL rest reach glideR lookL settle','rise reach lookL lookR nod settle',4900,1500),
 goose:m('游弋警觉','glideR lookR rest glideL nod rise','reach lookR rise nod rest settle',4100),
 cormorant:m('晾翼收羽','spread rest fold dip rise lookL','rise spread lookL fold rest settle',4500,1500),
 pelican:m('低喙舒翼','dip reach rest spread fold rise','reach dip rise spread rest settle',4400,1450),
 avocet:m('轻步扫水','stepL dip lookL lookR rise stepR','stepL lookL reach lookR rise settle',3900,1450),
 sandpiper:m('两啄一望','peck rest peck rise lookR stepL','lookR peck rise stepR rest settle',3100,1100),
 otter:m('揉脸探头','wash rest sniff lookR reach settle','sniff reach wash rise rest settle',3600),
 beaver:m('抬爪拍尾','reach nod rest shake fold settle','rise reach nod shake rest settle',3900),
 nutria:m('嗅探回身','sniff lookL rest stepR lookR settle','sniff lookR reach stepL rest settle',3700),
 muskrat:m('小步环顾','stepL sniff rest lookL stepR rise','lookL sniff rise lookR rest settle',3400,1250),
 seal:m('仰首摆鳍','rise lookR rest spread fold settle','rise nod spread lookL rest settle',4100,1450),
 'sea-lion':m('昂首招呼','reach rise rest lookR fold settle','rise reach nod spread fold settle',4400,1500),
 capybara:m('安静嗅闻','sniff rest settle lookR rest rise','lookR rest sniff nod rise settle',5200,1600),
 hippo:m('舒身浮沉','swell rest dip rise lookL settle','rise swell lookR nod rest settle',4600,1500),
 'water-shrew':m('细嗅快步','sniff stepR lookL rest stepL rise','sniff reach stepR lookL rest settle',2900,1150),
 raccoon:m('搓爪观察','wash lookL rest wash lookR rise','wash rise lookL lookR nod settle',3600),
 mink:m('探身甩尾','reach stepR rest curlL sniff rise','reach sniff shake lookR rest settle',3300,1250),
 fox:m('侧耳扫尾','lookL sniff rest curlR lookR settle','lookL lookR reach shake rest settle',3900,1450),
 rabbit:m('竖耳轻跃','lookL crouch rest spring settle sniff','rise lookR crouch spring rest settle',3600),
 turtle:m('伸颈慢行','reach rest stepL sniff stepR settle','sniff reach lookR nod rest settle',5100,1550),
 softshell:m('探吻划水','reach glideL rest dip glideR rise','reach lookL rise glideR rest settle',4500,1450),
 frog:m('蹬腿探看','crouch rest spring settle lookR reach','crouch spring rest lookR nod settle',3500,1250),
 'tree-frog':m('伸趾攀步','reach stepL rest rise stepR lookL','reach spread lookL nod rest settle',3700),
 toad:m('低身环视','crouch lookL rest lookR stepL settle','lookL swell lookR nod rest settle',4800,1500),
 crocodile:m('缓行抬吻','stepL rest reach lookR stepR dip','reach lookR dip rise rest settle',4900,1500),
 salamander:m('摆尾换步','curlL stepR rest curlR stepL reach','curlL reach curlR rise rest settle',3900),
 newt:m('轻摆探路','stepL curlR sniff rest stepR lookL','lookL curlR reach curlL rest settle',3600),
 lizard:m('转首快步','sniff stepL lookR rest stepR reach','lookR reach stepL shake rest settle',3100,1150),
 chameleon:m('卷尾眺望','lookL curlL rest reach lookR curlR','lookL reach curlR nod rest settle',4800,1550),
 crab:m('横步举螯','stepL spread rest stepR fold lookR','spread stepL fold stepR rest settle',3400,1250),
 lobster:m('举钳收尾','reach spread rest curlL fold rise','spread reach fold curlR rest settle',3700),
 'water-snake':m('曲身巡游','curlL glideL rest curlR glideR rise','curlR reach curlL lookR rest settle',4400,1500),
 kingfisher:m('俯身候鱼','lookR rest dip peck rise lookL','lookR dip rise spread rest settle',3600),
 hummingbird:m('悬停探喙','hover flap reach hover fold lookR','hover flap reach spread rest settle',1800,1050),
 swallow:m('掠飞回旋','glideL flap hover glideR fold rise','glideL spread glideR fold rest settle',2600,1150),
 swift:m('疾掠展翼','flap glideR fold glideL hover rise','spread glideL flap glideR rest settle',2300,1100),
 robin:m('点首踱步','nod stepL rest lookR peck rise','lookR nod stepR rise rest settle',3300,1250),
 tit:m('侧首理羽','lookL wash rest lookR rise stepL','lookL rise nod spread rest settle',3200,1200),
 sparrow:m('跳步轻啄','stepL crouch spring rest peck rise','crouch spring nod lookL rest settle',2900,1150),
 redstart:m('抬尾回眸','curlR lookL rest stepR shake rise','curlR rise lookL nod rest settle',3300,1250),
 woodpecker:m('三啄抬头','peck rest peck rest peck rise','peck nod peck rise lookR settle',2400,1100),
 owl:m('左右歪头','lookL rest lookR nod rest rise','lookL lookR nod rise rest settle',4500,1550),
 eagle:m('振翼远望','spread lookR flap rest fold rise','spread flap lookL rise rest settle',3800,1450),
 magpie:m('侧步扬尾','stepR curlL rest lookR nod rise','stepR lookR curlL spread rest settle',3400),
 parrot:m('歪首梳羽','lookR wash rest lookL shake rise','lookR nod lookL shake rest settle',3800,1450),
 dragonfly:m('振翅悬停','hover flap rest glideL hover glideR','hover spread glideR flap rest settle',2100,1100),
 damselfly:m('合翅轻悬','hover fold rest glideR spread rise','rise fold hover spread rest settle',2700,1200),
 butterfly:m('翕翅盘旋','spread hover fold glideL flap glideR','spread fold rise spread rest settle',3100,1350),
 moth:m('轻振收翅','flap rest fold hover spread settle','flap spread fold rise rest settle',3000,1300),
 bee:m('绕花探寻','hover glideR dip glideL flap rise','hover lookR dip rise rest settle',2200,1100),
 wasp:m('驻空摆腹','hover curlL flap glideR fold rise','hover curlR spread fold rest settle',2300,1150),
 ladybug:m('开翅探步','stepL spread fold rest stepR rise','spread lookR fold reach rest settle',3400),
 beetle:m('探角爬行','stepL sniff stepR rest reach rise','sniff spread stepR fold rest settle',3900,1400),
 firefly:m('微悬闪身','hover swell rest glideR slim rise','hover swell glideL rise rest settle',3600,1450),
 mantis:m('合臂侧望','fold lookL rest reach lookR spread','fold reach lookR spread rest settle',4300,1500),
 grasshopper:m('屈腿试跃','crouch lookR rest spring settle stepL','crouch rise spring lookR rest settle',3200,1250),
 'water-strider':m('点水滑步','spread glideL stepR glideR fold rise','spread stepR glideL rise rest settle',3300,1300),
 duck:m('划水低头','glideL dip rest glideR shake rise','rise lookR shake nod rest settle',4200,1400),
 mandarin:m('展羽回首','spread glideR lookL rest fold rise','lookL spread rise fold rest settle',4400,1500),
 mallard:m('探水甩羽','dip glideL rest shake glideR rise','dip rise shake lookR rest settle',3900),
 grebe:m('轻潜探头','dip slim rest rise glideR lookL','dip slim rise lookL rest settle',3600,1300),
 coot:m('小幅划行','glideL stepR rest dip glideR rise','stepR glideL nod rise rest settle',4000),
 loon:m('伸颈潜游','reach dip slim glideL rest rise','reach slim dip rise rest settle',4600,1500),
 'crested-grebe':m('摇首展冠','lookL glideR lookR rest rise spread','lookL lookR spread rise rest settle',4200,1500),
 shelduck:m('昂首轻摆','rise glideL lookR rest shake glideR','rise lookR nod shake fold settle',4300,1450),
 gull:m('迎风展翅','spread glideL rest flap glideR rise','spread glideR flap lookL rest settle',3600,1350),
 tern:m('掠水折返','glideR dip flap glideL hover rise','glideR dip spread glideL rest settle',2800,1200),
 penguin:m('摇摆招手','stepL rest stepR spread fold rise','stepL stepR spread nod rest settle',3600,1400),
 puffin:m('摆喙舒翼','lookR fold rest spread stepL rise','lookR nod spread stepR rest settle',3700,1400),
 fish:m('摆尾巡游','glideL curlL rest glideR curlR rise','glideL curlR glideR reach rest settle',3400,1300),
 goldfish:m('舒鳍回转','spread glideL curlR rest glideR fold','spread curlL glideR fold rest settle',4000,1450),
 koi:m('缓游回身','glideR curlL rise rest glideL curlR','glideR curlL reach glideL rest settle',4400,1500),
 perch:m('停游展鳍','glideL spread rest glideR fold rise','spread glideR fold curlL rest settle',3500),
 trout:m('疾游轻转','glideR slim curlL rest glideL spread','glideR slim curlL glideL rest settle',2700,1150),
 salmon:m('逆流摆身','glideL rise slim rest glideR curlL','rise glideL curlR spread rest settle',3000,1250),
 eel:m('蜿蜒游弋','curlL glideR curlR rest glideL slim','curlL glideL curlR reach rest settle',3700,1400),
 catfish:m('探须慢游','reach glideL sniff rest curlR glideR','sniff reach glideR curlL rest settle',4200,1450),
 sturgeon:m('贴底回旋','glideL dip curlR rest glideR reach','dip reach glideL curlR rest settle',4300,1500),
 stingray:m('展翼滑翔','spread glideL fold rest glideR rise','spread glideL rise fold rest settle',4600,1550),
 pufferfish:m('鼓身吐息','swell rest slim glideR fold rise','swell lookR slim rise rest settle',4100,1450),
 seahorse:m('卷尾点首','curlL nod rest rise curlR reach','curlL rise nod curlR rest settle',4600,1550),
 lotus:m('舒瓣迎风','unfurl swayL rest swayR fold rise','unfurl spread swayL swayR rest settle',5500,1700),
 'water-lily':m('轻开合瓣','unfurl rest fold swayL swayR rise','unfurl swayR spread fold rest settle',5800,1750),
 reed:m('穗尖轻颤','swayL quiver rest swayR quiver rise','swayL quiver swayR rise rest settle',4900,1550),
 cattail:m('柔穗摇曳','swayR rest swayL fold unfurl rise','swayR swayL unfurl nod rest settle',5300,1600),
 'lotus-leaf':m('叶面承风','swayL swell rest swayR slim rise','swayL swell swayR fold rest settle',5600,1650),
 clover:m('三叶轻招','swayR unfurl rest swayL quiver fold','unfurl swayL quiver swayR rest settle',4800,1550),
 ginkgo:m('扇叶轻展','unfurl swayR fold rest swayL rise','unfurl swayR fold swayL rest settle',5700,1700),
 fern:m('卷叶舒展','fold swayL rest unfurl swayR rise','fold unfurl swayR quiver rest settle',5900,1750),
 willow:m('垂枝拂水','swayL dip rest swayR reach fold','swayL reach swayR dip rest settle',6200,1800),
 pine:m('枝梢点首','swayR rest quiver swayL fold rise','swayR quiver swayL nod rest settle',6000,1700),
 'cherry-blossom':m('花瓣轻旋','swayL unfurl rest swayR fold rise','unfurl swayL fold swayR rest settle',5200,1650),
 dandelion:m('绒球随风','swayR spread rest quiver swayL fold','spread swayR quiver swayL rest settle',5400,1700),
} satisfies Record<LakeAvatarName,ReturnType<typeof m>>;

const channels=['body','head','wing','fore','hind','tail'] as const;
const matrix=(t:Transform,strength:number)=>`translate(${t[0]*strength}px,${t[1]*strength}px) rotate(${t[2]*strength}deg) scale(${1+((t[3]??1)-1)*strength},${1+((t[4]??1)-1)*strength})`;
const foldingWings=new Set<LakeAvatarName>(['dragonfly','damselfly','butterfly','moth','bee','wasp','firefly']);
const cache=new Map<LakeAvatarName,Record<string,string>>();
export function avatarMotionStyle(role:LakeAvatarName){
 let style=cache.get(role);if(style)return style;
 const motion=lakeAvatarMotions[role];style={'--avatar-work-time':`${motion.workMs}ms`,'--avatar-greet-time':`${motion.greetMs}ms`};
 for(const [mode,program,strength] of [['w',motion.working,.48],['g',motion.greeting,1]] as const){
  program.forEach((beat,index)=>channels.forEach(channel=>{style![`--av-${mode}-${channel}-${index+1}`]=matrix(channel==='wing'&&foldingWings.has(role)?[0,0,poses[beat].wing[2]*.12,1-Math.abs(poses[beat].wing[2])/70,1]:poses[beat][channel],strength);}));
 }
 cache.set(role,style);return style;
}
