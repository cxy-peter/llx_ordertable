import {DEFAULT_CONFIG,nyParts} from './config.js';

export const DEFAULT_BATCHES={
 lunch:[['12:20','第一批'],['12:45','第二批'],['13:20','第三批'],['14:00','第四批']],
 dinner:[['18:10','早鸟批'],['18:45','第二批'],['19:30','第三批'],['20:00','第四批'],['21:00','第五批'],['21:30','末批']]
};
export function batches(slot){return DEFAULT_BATCHES[slot].map(([time,name],i)=>({id:slot+'-'+(i+1),name,time,enabled:true}))}
export function normalizeSettings(value){
 const s=structuredClone(value||DEFAULT_CONFIG);
 if(!s.schema_version){
  const tj=s.pickups.find(p=>p.id==='journal36');if(tj){tj.name='36 TJ';tj.short='36 TJ';if(tj.address==='Lobby 前台，或 18TJ 前台')tj.address='36 The Journal Square · Lobby 前台'}
  if(!s.pickups.some(p=>p.id==='journal18'))s.pickups.splice(4,0,{id:'journal18',short:'18 TJ',name:'18 TJ',address:'18 TJ · 前台',hint:'请核对楼宇，18 TJ 与 36 TJ 分开配送。',time:'以商家通知为准',enabled:true});
  for(const slot of s.slots){slot.batches??=batches(slot.id);if(slot.id==='dinner'&&slot.cutoff==='23:59')slot.cutoff='21:30';slot.delivery='按所选批次预计发车，具体到达时间以配送进度为准'}
 }
 s.schema_version=3;s.revision??=0;s.day_overrides??={};s.other_pickup_enabled??=true;
 s.security={registration_open:true,invite_required:false,invite_hash:'',daily_registration_limit:200,idle_minutes:5,...s.security};
 for(const p of s.pickups)p.enabled??=true;
 for(const m of s.menu){m.available_date??='';m.subtitle??='';}
 return s;
}
export function dailySlots(s,date=nyParts().date){return s.day_overrides[date]?.slots||s.slots}
export function publicSettings(s){const {security,day_overrides,...safe}=s;return {...safe,registration:{open:security.registration_open,invite_required:security.invite_required},idle_minutes:security.idle_minutes}}

export function validateSettings(p,old){
 const fail=s=>{throw new Error(s)};
 const str=(v,max,required=false)=>{if(typeof v!=='string'||v.length>max||required&&!v.trim())fail('文字字段不完整或过长');return v.trim()};
 const num=(v,min,max)=>{if(!Number.isInteger(v)||v<min||v>max)fail('数值范围不正确');return v};
 const arr=(v,min,max)=>{if(!Array.isArray(v)||v.length<min||v.length>max)fail('配置数量不正确');return v};
 const ids=v=>{if(new Set(v.map(x=>x.id)).size!==v.length||v.some(x=>!/^[-a-zA-Z0-9_]{1,64}$/.test(x.id)))fail('编号重复或不正确')};
 const time=v=>{if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))fail('时间应为 HH:MM');return v};
 const date=v=>{if(v&&!/^20\d\d-\d\d-\d\d$/.test(v))fail('日期格式不正确');return v};
 const slots=input=>{arr(input,2,2);ids(input);if(!['lunch','dinner'].every(id=>input.some(s=>s.id===id)))fail('午晚餐场次不完整');return input.map(s=>{arr(s.batches,0,24);ids(s.batches);return {id:s.id,name:s.id==='lunch'?'午餐':'晚餐',cutoff:time(s.cutoff),enabled:!!s.enabled,delivery:str(s.delivery,100,true),batches:s.batches.map(b=>({id:b.id,name:str(b.name,30,true),time:time(b.time),enabled:!!b.enabled})).sort((a,b)=>a.time.localeCompare(b.time))}})};
 const s={...old,revision:old.revision+1,notice:str(p.notice,500,true),tax_bps:num(p.tax_bps,0,3000),fee_cents:num(p.fee_cents,0,10000),slots:slots(p.slots),other_pickup_enabled:!!p.other_pickup_enabled};
 arr(p.menu,1,200);ids(p.menu);s.menu=p.menu.map(m=>{
  arr(m.options,1,20);ids(m.options);arr(m.slots,1,2);if(m.slots.some(x=>!['lunch','dinner'].includes(x)))fail('菜品所属场次不正确');
  const previous=old.menu.find(x=>x.id===m.id); // Images can only be replaced through the authenticated upload endpoint.
  const options=m.options.map(o=>({id:o.id,name:str(o.name,40,true),price:num(o.price,1,100000)}));
  return {id:m.id,name:str(m.name,60,true),subtitle:str(m.subtitle||'',200),category:str(m.category,30,true),available:!!m.available,sold_out:!!m.sold_out,available_date:date(m.available_date||''),slots:[...new Set(m.slots)],options,price:Math.min(...options.map(o=>o.price)),image:previous?.image||null};
 });
 arr(p.pickups,1,40);ids(p.pickups);s.pickups=p.pickups.map(x=>({id:x.id,name:str(x.name,60,true),short:str(x.short||x.name,60),address:str(x.address,200,true),hint:str(x.hint||'',200),time:str(x.time||'以商家通知为准',100),enabled:!!x.enabled}));
 const overrides=p.day_overrides||{};if(typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).length>90)fail('最多保留 90 个日期的配送安排');s.day_overrides={};for(const [d,v] of Object.entries(overrides)){date(d);s.day_overrides[d]={slots:slots(v.slots)}}
 const sec=p.security||{};s.security={...old.security,registration_open:!!sec.registration_open,invite_required:!!sec.invite_required,daily_registration_limit:num(sec.daily_registration_limit,1,2000),idle_minutes:num(sec.idle_minutes,1,60)};
 return s;
}
