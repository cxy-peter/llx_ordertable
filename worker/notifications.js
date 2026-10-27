import {nyParts} from './config.js';
import {orderReference} from './references.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{name:'NotificationError',status})};
export function barkKey(input){
 let key=String(input||'').trim();
 if(key.startsWith('https://')){let u;try{u=new URL(key)}catch{fail('Bark 链接格式不正确')}
  if(u.origin!=='https://api.day.app'||u.username||u.password)fail('请使用 Bark 默认服务器 api.day.app 的密钥或链接');
  key=u.pathname.split('/').filter(Boolean)[0]||'';
 }
 if(!/^[A-Za-z0-9_-]{6,128}$/.test(key))fail('请填写有效的 Bark 设备密钥，或复制 App 内的完整测试链接');
 return key;
}
export function pushplusToken(input){const key=String(input||'').trim();if(!/^[A-Za-z0-9_-]{16,128}$/.test(key))fail('请复制 pushplus 的消息 token，不是微信号或网页地址');return key}
function safeSettings(s){return {provider:s.provider,paused_reason:s.paused_reason,enabled:!!s.enabled,configured:!!s.device_key,title:s.title,message:s.message,daily_limit:s.daily_limit,version:s.version}}

export async function notificationRoutes(c){
 const {path,method,requireAdmin,one,rows,q,DB,body,text,integer,json,rate,url}=c;
 if(!path.startsWith('/api/admin/push'))return null;
 const admin=await requireAdmin(),s=await one('SELECT * FROM push_settings WHERE id=1');
 if(method==='GET'&&path==='/api/admin/push'){
  const daily=await one('SELECT attempts FROM push_daily WHERE day=?',nyParts().date);
  const logs=await rows('SELECT id,kind,status,attempts,created_at,finished_at,last_error FROM push_jobs ORDER BY created_at DESC,id DESC LIMIT 20');
  const rolling=await one('SELECT count(*) n FROM push_attempts WHERE created_at>?',Date.now()-86400000);
  return json({...safeSettings(s),attempts_today:daily?.attempts||0,attempts_24h:rolling.n,logs});
 }
 if(method==='POST'&&path==='/api/admin/push'){
  await rate('push-settings',admin.user_id,20,10);const p=await body(c.request);
  if(p.version!==s.version)fail('通知设置已被其他人更新，请重新载入后修改',409);
  if(typeof p.enabled!=='boolean')fail('请选择是否启用通知');
  const provider=p.provider||s.provider;if(!['bark','pushplus'].includes(provider))fail('请选择提醒渠道');
  const raw=text(p,'device_key',2048),key=p.forget_key?'':raw?(provider==='bark'?barkKey(raw):pushplusToken(raw)):provider===s.provider?s.device_key:'';
  if(p.enabled&&!key)fail('请先填写所选渠道的接收密钥');
  const title=text(p,'title',40,true),message=text(p,'message',100,true),limit=integer(p.daily_limit,1,provider==='pushplus'?180:500,'推送上限');
  const generation=s.generation+(key!==s.device_key||provider!==s.provider||Number(p.enabled)!==s.enabled?1:0);
  const updated=await q("UPDATE push_settings SET enabled=?,device_key=?,provider=?,paused_reason='',title=?,message=?,daily_limit=?,site_origin=?,generation=?,version=version+1 WHERE id=1 AND version=?",p.enabled?1:0,key,provider,title,message,limit,url.origin,generation,s.version).run();
  if(!updated.meta.changes)fail('通知设置已被其他人更新，请重新载入',409);
  // Do not forward queued messages to a newly bound phone or replay old orders on enable.
  await q("UPDATE push_jobs SET status='skipped',last_error='接收手机或开关已变更',finished_at=? WHERE status='pending' AND generation<>?",Date.now(),generation).run();
  return json({ok:true,...safeSettings({...s,provider,paused_reason:'',enabled:p.enabled,device_key:key,title,message,daily_limit:limit,version:s.version+1})});
 }
 if(method==='POST'&&path==='/api/admin/push/test'){
  await rate('push-test','merchant',3,10);if(!s.device_key)fail('请先保存接收渠道的密钥');
  await q("UPDATE push_settings SET paused_reason='' WHERE id=1 AND version=?",s.version).run();
  const id='test:'+crypto.randomUUID(),now=Date.now();
  await q('INSERT INTO push_jobs(id,kind,generation,created_at,next_attempt) VALUES(?,?,?,?,?)',id,'test',s.generation,now,now).run();
  return json({ok:true,id,status:'pending'});
 }
 return null;
}

export function pushPayload(settings,job,order){
 let detail='这是一条测试通知，未创建订单，也不计入营业。';
 if(order){const session=JSON.parse(order.session);detail=`订单 ${orderReference(order,true).number}\n用餐日期 ${order.date} · ${session.session_name}`;}
 const payload={device_key:settings.device_key,title:job.kind==='test'?'测试 · '+settings.title:settings.title,
  body:(job.kind==='test'?'':settings.message+'\n')+detail,group:'linglongxuan-orders',sound:'minuet',level:'active',
  url:settings.site_origin+'/admin'+(order?'?order='+order.id:''),isArchive:'0'};
 if(settings.provider!=='pushplus')return payload;
 const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return {token:settings.device_key,channel:'wechat',template:'html',title:payload.title,
  content:'<p>'+escape(payload.body).replaceAll('\n','<br>')+'</p><p><a href="'+escape(payload.url)+'">点这里查看并处理订单</a></p>',
  callbackUrl:settings.site_origin+'/api/push/callback/'+job.callback_token};
}

// Only a fixed HTTPS endpoint is supported. Never echo provider responses: they can contain keys.
export async function sendBark(payload,fetcher=fetch){
 try{
  const r=await fetcher('https://api.day.app/push',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
  if(!r.ok)return {ok:false,retry:r.status===429||r.status>=500,error:'推送服务 HTTP '+r.status};
  const data=await r.json();if(data.code===200)return {ok:true};
  return {ok:false,retry:data.code===429||Number(data.code)>=500,error:'推送服务未接受，请核对 Bark 密钥或稍后测试'};
 }catch{return {ok:false,retry:true,error:'推送服务连接失败或超时'}}
}

export async function sendPushplus(payload,fetcher=fetch){
 try{
  const r=await fetcher('https://www.pushplus.plus/send',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
  if(!r.ok)return {ok:false,retry:r.status===429||r.status>=500,error:'微信推送服务 HTTP '+r.status};
  const d=await r.json();if(d.code===200&&typeof d.data==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(d.data))return {ok:true,ref:d.data};
  const errors={900:'推送账号受限，请在 pushplus 检查额度或账号状态',905:'请先在 pushplus 完成实名认证',903:'pushplus token 无效，请重新绑定',888:'推送平台提示积分不足，请检查账号；网站不会自动充值',401:'推送平台未授权，请检查账号',403:'推送平台拒绝请求，请检查账号'};
  return {ok:false,retry:d.code===500,error:errors[d.code]||'微信推送未接受，请检查 pushplus 发送记录',pause:!!errors[d.code]};
 }catch{return {ok:false,retry:true,error:'微信推送服务连接失败或超时'}}
}

// Provider callbacks use a random per-attempt capability, never an administrator cookie.
export async function receivePushCallback(request,env){
 const match=new URL(request.url).pathname.match(/^\/api\/push\/callback\/([a-f0-9]{64})$/);
 if(!match||request.method!=='POST')return new Response('Not found',{status:404});
 const job=await env.DB.prepare('SELECT id,status,provider_ref FROM push_jobs WHERE callback_token=?').bind(match[1]).first();if(!job)return new Response('Not found',{status:404});
 let size=0,parts=[];if(!request.body)return new Response('Invalid callback',{status:400});const reader=request.body.getReader();
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return new Response('Too large',{status:413})}parts.push(value)}
 let data;try{const raw=new Uint8Array(size);let at=0;for(const p of parts){raw.set(p,at);at+=p.length}data=JSON.parse(new TextDecoder().decode(raw))}catch{return new Response('Invalid callback',{status:400})}
 const info=data.messageInfo;if(data.event!=='message_complate'||!info||![2,3].includes(info.sendStatus)||typeof info.shortCode!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(info.shortCode)||(job.provider_ref&&job.provider_ref!==info.shortCode))return new Response('Invalid callback',{status:400});
 await env.DB.prepare("UPDATE push_jobs SET status=?,provider_ref=?,last_error=?,finished_at=? WHERE id=? AND callback_token=? AND status IN ('sending','accepted')").bind(info.sendStatus===2?'delivered':'failed',info.shortCode,info.sendStatus===2?'':'微信渠道投递失败，请在 pushplus 查看原因并检查关注状态',Date.now(),job.id,match[1]).run();
 return Response.json({code:200,msg:'success'});
}

export async function deliverNotifications(env,{fetcher=fetch,now=Date.now(),limit=5}={}){
 const db=env.DB,q=(sql,...args)=>db.prepare(sql).bind(...args);
 const candidates=(await q("SELECT id FROM push_jobs WHERE (status='pending' AND next_attempt<=?) OR (status='sending' AND lease_until<=?) ORDER BY created_at,id LIMIT ?",now,now,Math.min(5,limit)).all()).results;
 for(const {id} of candidates){
  const token=crypto.randomUUID();const job=await q("UPDATE push_jobs SET status='sending',claim_token=?,lease_until=? WHERE id=? AND ((status='pending' AND next_attempt<=?) OR (status='sending' AND lease_until<=?)) RETURNING *",token,now+60000,id,now,now).first();
  if(!job)continue;
  const s=await q('SELECT * FROM push_settings WHERE id=1').first();
  const finish=(status,error='',ref='')=>q("UPDATE push_jobs SET status=?,last_error=?,provider_ref=?,finished_at=?,lease_until=0 WHERE id=? AND claim_token=? AND status='sending'",status,error,ref,now,id,token).run();
  if(job.generation!==s.generation||!s.device_key||(job.kind==='order'&&!s.enabled)){await finish('skipped','通知已关闭或接收手机已更换');continue}
  if(now-job.created_at>6*3600000){await finish('failed','超过 6 小时未发送，请打开后台查看订单');continue}
  if(job.attempts>=3){await finish('failed','已达到 3 次尝试，请打开后台查看订单');continue}
  if(s.paused_reason){await finish('failed',s.paused_reason);continue}
  let order=null;if(job.kind==='order'){
   order=await q('SELECT * FROM order_details WHERE id=?',job.order_id).first();
   if(!order||order.phase!=='submitted'||order.is_test||order.test_only||order.fulfillment!=='pending'){await finish('skipped','订单已处理、已删除或属于测试');continue}
  }
  if(s.provider==='pushplus'){
   // A rolling 24-hour cap leaves room below the free account's 200 requests/day;
   // a global minimum interval is stronger than a fixed-minute counter.
   const reserved=await q("INSERT INTO push_attempts(created_at) SELECT ? WHERE (SELECT count(*) FROM push_attempts WHERE created_at>?)<? AND coalesce((SELECT max(created_at) FROM push_attempts),0)<=? RETURNING id",now,now-86400000,Math.min(180,s.daily_limit),now-15000).first();
   if(!reserved){const used=await q('SELECT count(*) n FROM push_attempts WHERE created_at>?',now-86400000).first();if(used.n>=Math.min(180,s.daily_limit))await finish('failed','达到微信过去 24 小时推送上限，订单仍保存在后台');else await q("UPDATE push_jobs SET status='pending',next_attempt=?,lease_until=0,last_error='已排队，避免微信推送过于频繁' WHERE id=? AND claim_token=?",now+15000,id,token).run();continue}
  }
  const day=nyParts(new Date(now)).date;
  const reserved=await q('INSERT INTO push_daily(day,attempts) SELECT ?,1 WHERE ?>0 ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts',day,s.daily_limit,s.daily_limit).first();
  if(!reserved){await finish('failed','达到今日推送上限，订单仍保存在后台');continue}
  await q('UPDATE push_jobs SET attempts=attempts+1 WHERE id=? AND claim_token=?',id,token).run();
  if(s.provider==='pushplus'){job.callback_token=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');await q("UPDATE push_jobs SET callback_token=?,provider_ref='' WHERE id=? AND claim_token=?",job.callback_token,id,token).run()}
  const result=await (s.provider==='pushplus'?sendPushplus:sendBark)(pushPayload(s,job,order),fetcher);
  if(result.pause)await q('UPDATE push_settings SET paused_reason=? WHERE id=1 AND generation=?',result.error,s.generation).run();
  if(result.ok)await finish('accepted','',result.ref||'');
  else if(result.retry&&job.attempts+1<3)await q("UPDATE push_jobs SET status='pending',next_attempt=?,last_error=?,lease_until=0 WHERE id=? AND claim_token=?",now+(job.attempts===0?60000:300000),result.error,id,token).run();
  else await finish('failed',result.error);
 }
 // Notification logs contain no names, phone numbers, receipts, or device keys.
 await db.batch([q("DELETE FROM push_jobs WHERE created_at<? AND status NOT IN ('pending','sending')",now-7*86400000),q('DELETE FROM push_daily WHERE day<?',nyParts(new Date(now-8*86400000)).date),q('DELETE FROM push_attempts WHERE created_at<?',now-2*86400000)]);
}
