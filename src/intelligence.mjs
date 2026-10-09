import {createHash} from 'node:crypto';
import {decode,classify,pool} from './collector.mjs';

const HOUR=3600000;
const id=s=>createHash('sha256').update(s).digest('hex').slice(0,20);
export function canonicalURL(raw){try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))return null;u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref)$/i.test(k))u.searchParams.delete(k);return u.href}catch{return null}}
function date(raw,now){const t=Date.parse(raw);return Number.isFinite(t)&&t<=now?new Date(t).toISOString():null}
function xmlField(block,key){return decode(block.match(new RegExp('<'+key+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+key+'>','i'))?.[1])}
export function parseFeed(xml,source,now=Date.now()){
 if(!/<rss\b|<feed\b/i.test(xml))throw new Error('来源未返回 RSS/Atom，不能把网页当作采集成功');
 const blocks=[...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];
 return blocks.slice(0,30).map(m=>{const b=m[2],title=xmlField(b,'title'),raw=xmlField(b,'link')||b.match(/<link\b(?=[^>]*\brel=['"]alternate['"])[^>]*href=['"]([^'"]+)/i)?.[1]||b.match(/<link\b[^>]*href=['"]([^'"]+)/i)?.[1],url=canonicalURL(raw),publisher=xmlField(b,'source')||source.name;
 const publisherUrl=canonicalURL(b.match(/<source\b[^>]*url=['"]([^'"]+)/i)?.[1]);
 return {id:id(url||title),title,url,source:publisher,sourceId:source.id,publisherUrl,publishedAt:date(xmlField(b,'pubDate')||xmlField(b,'published')||xmlField(b,'dc:date'),now),discoveredAt:new Date(now).toISOString(),summary:xmlField(b,'description')||xmlField(b,'summary'),origin:source.kind==='official'?'official':'discovery',ownerActorId:source.kind==='official'?source.actorId:null,collectionActorId:source.actorId,evidenceType:source.kind==='official'?'官方发布 · 效果与收益宣称仍需验证':'媒体发现 · 原文及事实待核查',contentType:'news'}
 }).filter(x=>x.title&&x.url);
}
export function actorMatches(text,actor){return actor.aliases.some(alias=>{const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(/^[\x00-\x7f]+$/.test(alias)?'(?<![a-z0-9])'+escaped+'(?![a-z0-9])':escaped,'i').test(text)})}
export function enrichItem(item,actors,now=Date.now()){
 const text=item.title+' '+(item.summary||''),actorIds=actors.filter(a=>a.id===item.ownerActorId||actorMatches(text,a)).map(a=>a.id);
 const validPublished=date(item.publishedAt,now),tags=[...new Set([...classify(text),...actors.filter(a=>actorIds.includes(a.id)).flatMap(a=>a.tags||[])])];
 const noise=/job opening|we are hiring|招聘|抽奖|限时优惠|promo code|giveaway|black friday|BFCM|高清完整版|HD中字|在线观看|免费在线观看|中文字幕|迅雷下载|最新电影/i.test(item.title);
 const relevance=/小游戏|微信|抖音|IAA|rewarded|ad monet|user acquisition|买量|变现|网赚|激励|mistplay|justplay|adjoe|supersonic|voodoo/i.test(text)?5:actorIds.length?3:1;
 const substance=/launch|releas|acqui|merger|report|revenue|regulat|policy|上线|发布|收购|流水|收入|政策|报告|广告|测试/i.test(text)?4:2;
 const practical=/case study|retention|CPI|ROAS|eCPM|LTV|monetiz|广告|数值|留存|买量|关卡|试玩|playable|激励|提现/i.test(text)?4:1;
 const score=Math.max(0,Math.min(100,substance*5+relevance*6+practical*4+(item.origin==='official'?12:3)-(noise?45:0)));
 const materialReady=/launch|releas|unveil|announc|acqui|report|revenue|regulat|policy|appoint|introduc|expand|上线|发布|收购|收入|政策|报告|推出|合作|融资|更新|增长|下架|测试|开放|获奖|财报|任命/i.test(item.title)||decode(item.summary||'').replace(item.title,'').replace(item.source||'','').trim().length>=80;
 return {...item,summary:decode(item.summary||'').slice(0,240),actorIds,tags,publishedAt:validPublished,ruleScore:score,noise,materialReady,undated:!validPublished,archived:!validPublished||now-Date.parse(validPublished)>48*HOUR,selectionMode:'rule-v1',why:relevance===5?'关注用户获取、奖励设计、广告变现或小游戏生态；先核对原文中的数据口径。':practical===4?'可作为商业化、留存或玩法拆解线索，效果数字需核对实验条件。':'跟踪产品、平台与发行变化；原文主张不等于独立验证。'}
}
export function publisherKey(item){
 // Discovery publisher identity is a signal, not proof of independent reporting.
 if(item.publisherUrl){try{return 'publisher:'+new URL(item.publisherUrl).hostname.replace(/^www\./,'')}catch{}}
 if(item.url?.includes('news.google.com'))return 'label:'+item.source.toLowerCase().replace(/\s+/g,'');
 try{return 'publisher:'+new URL(item.url).hostname.replace(/^www\./,'')}catch{return 'unknown'}
}
const normalize=s=>s.toLowerCase().replace(/\s+[-–|]\s+[^-–|]+$/,'').replace(/[^\p{L}\p{N}]+/gu,'');
function titleTokens(s){const words=s.toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]+/g)||[];return new Set(words.flatMap(w=>/[\u4e00-\u9fff]/.test(w)?Array.from({length:Math.max(0,w.length-1)},(_,i)=>w.slice(i,i+2)):[w]).filter(w=>!['the','with','from','that','this','for','and','game','games','gaming','游戏','公司','宣布','发布'].includes(w)))}
export function sameEvent(a,b){
 if(normalize(a.title)===normalize(b.title))return true;
 // Conservative candidate clustering: same actors, action details and numbers; no cross-language guessing.
 if(!a.actorIds?.some(x=>b.actorIds?.includes(x)))return false;
 const numbers=s=>(s.match(/\d+(?:[.]\d+)?/g)||[]).sort().join(',');if(numbers(a.title)!==numbers(b.title))return false;
 const x=titleTokens(a.title),y=titleTokens(b.title),common=[...x].filter(t=>y.has(t)).length;
 return Math.min(x.size,y.size)>=7&&common/Math.max(x.size,y.size)>=.82;
}
export function eventHeat(items,now=Date.now()){
 const latest=new Map();for(const x of items){const t=Date.parse(x.publishedAt);if(!Number.isFinite(t)||t>now||now-t>48*HOUR)continue;const k=publisherKey(x);latest.set(k,Math.max(latest.get(k)||0,t))}
 return {heat:Number([...latest.values()].reduce((n,t)=>n+Math.pow(.5,(now-t)/HOUR/24),0).toFixed(3)),participants:latest.size};
}
export function buildEvents(items,now=Date.now(),previous=[]){
 const groups=[];for(const x of [...items].filter(x=>x.publishedAt&&!x.noise&&x.materialReady!==false).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))){const group=groups.find(g=>Math.abs(Date.parse(g[0].publishedAt)-Date.parse(x.publishedAt))<=72*HOUR&&sameEvent(g[0],x));if(group)group.push(x);else groups.push([x])}
 return groups.map(g=>{const representative=[...g].sort((a,b)=>(b.origin==='official')-(a.origin==='official')||b.ruleScore-a.ruleScore)[0],h=eventHeat(g,now),prior=previous.find(e=>e.evidence.some(p=>g.some(x=>x.url===p.url)));return {id:prior?.id||id(normalize(g[0].title)),title:representative.title,url:representative.url,summary:representative.summary,actorIds:[...new Set(g.flatMap(x=>x.actorIds))],tags:[...new Set(g.flatMap(x=>x.tags))],publishedAt:g[0].publishedAt,discoveredAt:g.reduce((a,x)=>a<x.discoveredAt?a:x.discoveredAt,g[0].discoveredAt),firstAt:g.at(-1).publishedAt,heat:h.heat,participants:h.participants,reportCount:g.length,ruleScore:Math.max(...g.map(x=>x.ruleScore)),officialCount:g.filter(x=>x.origin==='official').length,grouping:'标题相似规则候选，尚未人工确认事件一致性',evidence:g.map(x=>({title:x.title,url:x.url,source:x.source,publisherUrl:x.publisherUrl,publishedAt:x.publishedAt,origin:x.origin,evidenceType:x.evidenceType})),verification:g.some(x=>x.origin==='official')?'有官方发布；宣传效果未独立验证':'媒体报道；事实待核查'}}).sort((a,b)=>b.heat-a.heat||b.ruleScore-a.ruleScore||Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
}
function localDate(t){return new Date(t+8*HOUR).toISOString().slice(0,10)}
export function buildDigests(events,previous=[],now=Date.now()){
 // Daily edition uses the same 09:00 boundary as the user's digest automation.
 const day=localDate(now),todayAt=Date.parse(day+'T09:00:00+08:00'),cutoff=now>=todayAt?todayAt:todayAt-24*HOUR;
 const dateKey=localDate(cutoff);const existing=previous.find(x=>x.date===dateKey);if(existing)return previous;
 const candidates=events.filter(e=>e.evidence.some(x=>{const t=Date.parse(x.publishedAt);return t>cutoff-24*HOUR&&t<=cutoff})).sort((a,b)=>b.ruleScore-a.ruleScore||b.participants-a.participants);
 const used=new Set(previous.slice(0,7).flatMap(x=>x.entries.map(e=>e.id))),counts=new Map(),main=[],followup=[];
 for(const e of candidates){const inWindow=e.evidence.filter(x=>Date.parse(x.publishedAt)>cutoff-24*HOUR&&Date.parse(x.publishedAt)<=cutoff);const source=inWindow.find(x=>x.origin==='official')?.source||inWindow[0].source;if(used.has(e.id)){followup.push(e);continue}if((counts.get(source)||0)>=2||main.length>=12){followup.push(e);continue}counts.set(source,(counts.get(source)||0)+1);main.push(e)}
 const edition={date:dateKey,publishedAt:new Date(cutoff).toISOString(),generatedAt:new Date(now).toISOString(),windowStart:new Date(cutoff-24*HOUR).toISOString(),windowEnd:new Date(cutoff).toISOString(),mode:'规则编排 · 保留原标题与原文摘要',entries:main,briefs:followup.slice(0,10),quiet:!candidates.length};
 return [edition,...previous].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,60);
}
export const PRIMARY_FEEDS=[
 ['supersonic','Supersonic 官方博客','https://supersonic.com/feed/'],
 ['adjoe','adjoe 官方博客','https://adjoe.io/feed/'],
 ['appsflyer','AppsFlyer 官方博客','https://www.appsflyer.com/feed/'],
 ['godot','Godot 官方公告','https://godotengine.org/rss.xml'],
 ['playstation','PlayStation 官方博客','https://blog.playstation.com/feed/'],
 ['xbox','Xbox Wire 官方消息','https://news.xbox.com/en-us/feed/'],
 ['googleplay','Android Developers 官方博客','https://android-developers.googleblog.com/feeds/posts/default?alt=rss'],
].map(([actorId,name,url])=>({id:'official-'+actorId,actorId,name,url,kind:'official',intervalHours:3}));
export function actorSource(actor){return {id:'actor-'+actor.id,actorId:actor.id,name:actor.name+' 新闻发现',kind:'discovery',intervalHours:1,url:'https://news.google.com/rss/search?q='+encodeURIComponent(actor.query+' when:30d')+'&hl='+((actor.region==='中国'||/[\u4e00-\u9fff]/.test(actor.query))?'zh-CN&gl=CN&ceid=CN:zh-Hans':'en-US&gl=US&ceid=US:en')}}
export async function collectIntelligence(old,actors,now=Date.now()){
 const primary=new Map(PRIMARY_FEEDS.filter(s=>actors.some(a=>a.id===s.actorId)).map(s=>[s.actorId,s]));for(const a of actors)if(a.feedUrl)primary.set(a.id,{id:'official-'+a.id,actorId:a.id,name:a.name+' 官方订阅',url:a.feedUrl,kind:'official',intervalHours:3});
 const sources=[...primary.values(),...actors.map(actorSource)],status=[],newItems=(old.news||[]).map(x=>enrichItem({...x,origin:x.origin||'discovery'},actors,now)).filter(x=>x.actorIds.length&&x.contentType==='news');
 await pool(sources.map(source=>async()=>{const previous=old.intelligence?.sourceStatus?.find(s=>s.id===source.id);if(previous?.lastSuccessAt&&Math.floor(now/HOUR)-Math.floor(Date.parse(previous.lastSuccessAt)/HOUR)<source.intervalHours){status.push({...previous,skipped:true});return}
 try{const response=await fetch(source.url,{headers:{'User-Agent':'GameHot/2.0 (+https://creepergreg4-tech.github.io/game-hot/)','Accept':'application/rss+xml, application/atom+xml, application/xml'},signal:AbortSignal.timeout(14000)});if(!response.ok)throw new Error('HTTP '+response.status);const items=parseFeed(await response.text(),source,now).map(x=>enrichItem(x,actors,now)).filter(x=>source.kind==='official'||x.actorIds.includes(source.actorId));newItems.push(...items);status.push({...source,ok:true,count:items.length,checkedAt:new Date(now).toISOString(),lastSuccessAt:new Date(now).toISOString()})}catch(e){status.push({...source,ok:false,count:0,checkedAt:new Date(now).toISOString(),lastSuccessAt:previous?.lastSuccessAt||null,error:e.message})}}),4);
 const map=new Map();for(const x of [...(old.intelligence?.items||[]),...newItems]){const key=canonicalURL(x.url);if(!key)continue;const prev=map.get(key);map.set(key,{...x,actorIds:[...new Set([...(prev?.actorIds||[]),...x.actorIds])],discoveredAt:prev?.discoveredAt||x.discoveredAt})}
 const items=[...map.values()].map(x=>enrichItem(x,actors,now)).filter(x=>!/高清完整版|HD中字|在线观看|免费在线观看|中文字幕|迅雷下载|最新电影/i.test(x.title)).sort((a,b)=>Date.parse(b.publishedAt||b.discoveredAt)-Date.parse(a.publishedAt||a.discoveredAt)).slice(0,1800);
 const events=buildEvents(items,now,old.intelligence?.events||[]),insufficient=new Set(items.filter(x=>!x.materialReady).map(x=>x.url));
 const previous=(old.intelligence?.digests||[]).map(d=>({...d,entries:d.entries.filter(e=>!e.evidence.every(x=>insufficient.has(x.url))),briefs:d.briefs.filter(e=>!e.evidence.every(x=>insufficient.has(x.url)))}));
 const digests=buildDigests(events,previous,now);
 return {version:2,updatedAt:new Date(now).toISOString(),actors,sources,sourceStatus:status,items,events,digests,pipeline:{upstream:'https://github.com/KKKKhazix/AIHOT',upstreamCommit:'6e67a9d9e8d87b95b8118a8a0b328a9bebd2bb48',mode:'规则筛选与保守归组；未启用模型双评分',windowHours:48,halfLifeHours:24,grouping:'candidate',notice:'来源数量表示发布渠道候选，不证明报道独立或事实属实。初始旧文只进历史，未知日期不进入热点与日报。'},run:{at:new Date(now).toISOString(),success:status.filter(s=>s.ok&&!s.skipped).length,failed:status.filter(s=>!s.ok).length,skipped:status.filter(s=>s.skipped).length,total:sources.length}};
}
