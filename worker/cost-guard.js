// App-level limits, not a Cloudflare billing cap. Only this application's R2
// binding is metered. Direct dashboard/API use and other buckets are excluded.
export const COST_LIMITS={stored_bytes:2_000_000_000,uploads_day:2000,uploads_month:50000,reads_day:20000,reads_month:500000};
const active=env=>env.COST_GUARD_ENABLED==='1';
const limitError=()=>Object.assign(new Error('图片用量达到网站保护上限，已暂停此操作，请联系商家。已保存订单仍保留。'),{status:503});
function period(){const iso=new Date().toISOString();return {day:iso.slice(0,10),month:iso.slice(0,7)}}
async function reserve(db,key,amount,limit){
 if(amount>limit)throw limitError();
 const r=await db.prepare('INSERT INTO cost_counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value WHERE value+excluded.value<=? RETURNING value').bind(key,amount,limit).first();
 if(!r)throw limitError();
}
export async function costStatus(env){
 if(!active(env))return {enabled:false};const {day,month}=period();
 const values=Object.fromEntries((await env.DB.prepare('SELECT key,value FROM cost_counters WHERE key IN (?,?,?,?,?)').bind('stored','upload:'+day,'upload:'+month,'read:'+day,'read:'+month).all()).results.map(x=>[x.key,x.value]));
 const used={stored_bytes:values.stored||0,uploads_day:values['upload:'+day]||0,uploads_month:values['upload:'+month]||0,reads_day:values['read:'+day]||0,reads_month:values['read:'+month]||0};
 return {enabled:true,limits:COST_LIMITS,used,uploads_paused:used.stored_bytes+5*1024*1024>COST_LIMITS.stored_bytes||used.uploads_day>=COST_LIMITS.uploads_day||used.uploads_month>=COST_LIMITS.uploads_month,notice:'网站内部保护，非 Cloudflare 账户账单封顶；仅统计此网站经绑定访问的新图片。'};
}
export async function requireUploadCapacity(env){if((await costStatus(env)).uploads_paused)throw limitError()}
export function guardedStorage(env){
 if(!active(env)||env.COST_GUARDED)return env;
 const bucket=env.BUCKET,db=env.DB;
 const wrapped={
  async put(key,value,options){
   const bytes=value.byteLength;if(!Number.isSafeInteger(bytes))throw new Error('Metered uploads require bounded bytes');const {day,month}=period();
   await reserve(db,'upload:'+day,1,COST_LIMITS.uploads_day);await reserve(db,'upload:'+month,1,COST_LIMITS.uploads_month);
   // Reserve before R2 so concurrent requests cannot cross the storage budget.
   // A failed/ambiguous upload keeps its reservation until a confirmed delete.
   const token=crypto.randomUUID();await db.batch([
    db.prepare('INSERT INTO tx_guards(id,ok) VALUES(?,CASE WHEN coalesce((SELECT value FROM cost_counters WHERE key=\'stored\'),0)+?<=? THEN 1 ELSE 0 END)').bind(token,bytes,COST_LIMITS.stored_bytes),
    db.prepare('INSERT INTO cost_objects(key,bytes) VALUES(?,?)').bind(key,bytes),
    db.prepare("INSERT INTO cost_counters(key,value) VALUES('stored',?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value").bind(bytes),
    db.prepare('DELETE FROM tx_guards WHERE id=?').bind(token)
   ]).catch(e=>{if(/must_match_version|CHECK constraint/.test(String(e)))throw limitError();throw e});
   try{return await bucket.put(key,value,options)}catch(e){await db.prepare('INSERT OR IGNORE INTO media_garbage(key,created_at) VALUES(?,?)').bind(key,new Date().toISOString()).run();throw e}
  },
  async get(key,options){const {day,month}=period();await reserve(db,'read:'+day,1,COST_LIMITS.reads_day);await reserve(db,'read:'+month,1,COST_LIMITS.reads_month);return bucket.get(key,options)},
  async delete(key){
   await bucket.delete(key);await db.batch([
    db.prepare("UPDATE cost_counters SET value=max(0,value-coalesce((SELECT bytes FROM cost_objects WHERE key=?),0)) WHERE key='stored'").bind(key),
    db.prepare('DELETE FROM cost_objects WHERE key=?').bind(key)
   ]);
  }
 };
 return {...env,BUCKET:wrapped,COST_GUARDED:true};
}
