import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,Response as MFResponse} from 'miniflare';
import jpeg from 'jpeg-js';
import {hash,passwordHash} from '../worker/core.js';
import {DEFAULT_CONFIG,nyParts} from '../worker/config.js';
import {normalizeSettings} from '../worker/settings.js';
import {barkKey,sendBark,deliverNotifications,pushplusToken,sendPushplus} from '../worker/notifications.js';
let mf,db,mode=200,requests=[];const testKey='unit-test-device-key';
before(async()=>{
 mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'push-tests'},r2Buckets:['BUCKET'],bindings:{ADMIN_PASSWORD_HASH:await passwordHash('test-admin-password')},outboundService:async req=>{requests.push({url:req.url,body:await req.json()});return new MFResponse(JSON.stringify({code:mode,message:testKey}),{status:mode,headers:{'Content-Type':'application/json'}})}});
 db=await mf.getD1Database('DB');for(const f of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort())await db.batch((await readFile('drizzle/'+f,'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
});
after(async()=>{await mf?.dispose()});
beforeEach(async()=>{
 requests=[];mode=200;
 await db.batch(['push_jobs','push_daily','push_attempts','push_settings','events','orders','customers','sessions','settings','attempts','order_references','customer_codes'].map(t=>db.prepare('DELETE FROM '+t)));
 await db.prepare('INSERT INTO push_settings(id) VALUES(1)').run();
 const settings=normalizeSettings(DEFAULT_CONFIG);settings.slots.forEach(s=>s.cutoff='23:59');await db.prepare('INSERT INTO settings VALUES(1,?)').bind(JSON.stringify(settings)).run();
 await db.prepare("INSERT INTO customers(id,name,phone,wechat,password_hash,recovery_hash,created_at) VALUES('c1','Private Name','+12015550100','secret-wechat','x','x',?)").bind(new Date().toISOString()).run();
 for(const [cookie,role,id] of [['admin-cookie','admin','admin'],['customer-cookie','customer','c1']])await db.prepare('INSERT INTO sessions(token_hash,user_id,role,expires,last_active) VALUES(?,?,?,?,?)').bind(await hash(cookie),id,role,new Date(Date.now()+3600000).toISOString(),new Date().toISOString()).run();
});
async function call(path,body,who='admin',extra={}){
 const headers={Origin:'http://localhost','X-Requested-With':'Weizhuo',...extra};if(who)headers.Cookie=who==='admin'?'wz_admin=admin-cookie':'wz_customer=customer-cookie';
 if(body instanceof FormData){const r=new Response(body);headers['Content-Type']=r.headers.get('Content-Type');body=new Uint8Array(await r.arrayBuffer())}else if(body){headers['Content-Type']='application/json';body=JSON.stringify(body)}
 const r=await mf.dispatchFetch('http://localhost'+path,{method:body?'POST':'GET',headers,body});return {status:r.status,data:await r.json()};
}
async function settings(overrides={}){const s=(await call('/api/admin/push')).data;return call('/api/admin/push',{...s,provider:'bark',device_key:testKey,enabled:true,...overrides})}
async function draft(){const m=(await call('/api/menu?slot=lunch')).data;const r=await call('/api/orders',{date:m.date,slot:'lunch',name:'Private Name',phone:'+12015550100',wechat:'secret-wechat',pickup:'jsq2',items:[{id:'fried-noodles',option:'chicken',qty:1}],expected_total:1650,idempotency_key:crypto.randomUUID().replaceAll('-','')},'customer');assert.equal(r.status,201,JSON.stringify(r.data));return r.data}
async function receipt(o){const pixels=new Uint8Array(16*16*4).fill(255),f=new FormData();f.set('receipt',new File([jpeg.encode({data:pixels,width:16,height:16},70).data],'test.jpg',{type:'image/jpeg'}));f.set('channel','Zelle');assert.equal((await call('/api/orders/'+o.id+'/receipt',f,'customer')).status,200)}
async function submit(o){assert.equal((await call('/api/orders/'+o.id+'/submit',{},'customer')).status,200)}
async function waitJob(id,predicate){let j;for(let i=0;i<100;i++){j=await db.prepare('SELECT * FROM push_jobs WHERE id=?').bind(id).first();if(j&&predicate(j))return j;await new Promise(r=>setTimeout(r,20))}assert.fail('notification job did not settle: '+JSON.stringify({status:j?.status,error:j?.last_error,attempts:j?.attempts,requests:requests.length}))}
async function testJob(id,now=Date.now()){await db.prepare("INSERT INTO push_jobs(id,kind,generation,created_at,next_attempt) SELECT ?,'test',generation,?,? FROM push_settings").bind(id,now,now).run()}

test('Bark key validation accepts only default HTTPS service and never arbitrary webhook hosts',()=>{
 assert.equal(barkKey(' https://api.day.app/abcdef123/test?url=x '),'abcdef123');assert.equal(barkKey('abcdef123'),'abcdef123');
 for(const key of ['http://127.0.0.1/abcdef','https://api.day.app.evil.test/abcdef','https://user@api.day.app/abcdef','https://api.day.app:444/abcdef','abc'])assert.throws(()=>barkKey(key));
});
test('only staff can configure push and raw keys never appear in settings, menu or backup',async()=>{
 assert.equal((await call('/api/admin/push',undefined,null)).status,401);assert.equal((await call('/api/admin/push',{},'customer')).status,401);
 assert.equal((await settings()).status,200);const publicData=(await call('/api/admin/push')).data;assert.equal(publicData.configured,true);assert.ok(!JSON.stringify(publicData).includes(testKey));assert.ok(!JSON.stringify((await call('/api/menu')).data).includes(testKey));
 assert.equal((await settings({version:1})).status,409);assert.equal((await settings({daily_limit:501})).status,400);
 assert.equal((await settings({device_key:'https://elsewhere.test/abcdef'})).status,400);
 assert.equal((await call('/api/admin/push/test',{},'admin',{Origin:'https://evil.test'})).status,403);
 await db.prepare("UPDATE customers SET account_type='developer' WHERE id='c1'").run();await db.prepare("UPDATE sessions SET user_id='c1' WHERE role='admin'").run();assert.equal((await call('/api/admin/push')).status,200);
 const core=await readFile('worker/core.js','utf8');const backup=core.slice(core.indexOf("path==='/api/admin/backup'"));assert.ok(!backup.includes('push_settings'));assert.ok(!backup.includes('push_jobs'));
});
test('formal submit queues exactly once, drafts and receipts do not notify, payload omits personal data',async()=>{
 const o=await draft();await settings();await receipt(o);assert.equal((await db.prepare('SELECT count(*) n FROM push_jobs').first()).n,0);
 await submit(o);const job=await waitJob('order:'+o.id,j=>j.status==='accepted');assert.equal(job.attempts,1);await submit(o);await deliverNotifications({DB:db},{fetcher:()=>assert.fail('duplicate send')});
 assert.equal(requests.length,1);assert.equal(requests[0].url,'https://api.day.app/push');const p=requests[0].body;assert.equal(p.title,'车队配送单');assert.equal(p.url,'http://localhost/admin?order='+o.id);assert.match(p.body,/订单 C\d+/);assert.match(p.body,/用餐日期/);
 for(const secret of ['Private Name','2015550100','secret-wechat','receipt'])assert.ok(!JSON.stringify(p).includes(secret));
});
test('developer and ordinary test orders are excluded; turning on notifications does not replay old orders',async()=>{
 const old=await draft();await receipt(old);await submit(old);await settings();await submit(old);assert.equal((await db.prepare('SELECT count(*) n FROM push_jobs').first()).n,0);
 const ordinary=await draft();await db.prepare('UPDATE orders SET is_test=1 WHERE id=?').bind(ordinary.id).run();await receipt(ordinary);await submit(ordinary);
 await db.prepare("UPDATE customers SET account_type='developer' WHERE id='c1'").run();const developer=await draft();assert.equal(developer.is_test,true);await receipt(developer);await submit(developer);assert.equal((await db.prepare('SELECT count(*) n FROM push_jobs').first()).n,0);assert.equal(requests.length,0);
});
test('transient failure does not fail submission, retries are leased and capped without leaking provider messages',async()=>{
 mode=503;await settings();const o=await draft();await receipt(o);await submit(o);let job=await waitJob('order:'+o.id,j=>j.status==='pending'&&j.attempts===1);assert.ok(!job.last_error.includes(testKey));
 let sent=0;const mock=async()=>{sent++;return new Response('unavailable',{status:503})};
 await Promise.all([deliverNotifications({DB:db},{now:job.next_attempt+1,fetcher:mock}),deliverNotifications({DB:db},{now:job.next_attempt+1,fetcher:mock})]);assert.equal(sent,1);
 job=await db.prepare('SELECT * FROM push_jobs WHERE id=?').bind(job.id).first();assert.equal(job.attempts,2);await deliverNotifications({DB:db},{now:job.next_attempt+1,fetcher:mock});job=await db.prepare('SELECT * FROM push_jobs WHERE id=?').bind(job.id).first();assert.equal(job.status,'failed');assert.equal(job.attempts,3);assert.equal((await call('/api/orders/'+o.id,undefined,'customer')).data.phase,'submitted');
});
test('daily cap is atomic across workers and skips all extra sends without affecting order availability',async()=>{
 await settings({daily_limit:2});for(const id of ['t1','t2','t3','t4'])await testJob(id);let sent=0;const mock=async()=>{sent++;return Response.json({code:200})};
 await Promise.all([deliverNotifications({DB:db},{fetcher:mock}),deliverNotifications({DB:db},{fetcher:mock})]);assert.equal(sent,2);assert.equal((await db.prepare('SELECT attempts FROM push_daily WHERE day=?').bind(nyParts().date).first()).attempts,2);assert.equal((await db.prepare("SELECT count(*) n FROM push_jobs WHERE status='failed'").first()).n,2);assert.equal((await call('/api/menu')).status,200);
});
test('changing recipients or disabling cancels queued orders; test button works while auto notifications disabled',async()=>{
 mode=503;await settings();const o=await draft();await receipt(o);await submit(o);await waitJob('order:'+o.id,j=>j.status==='pending'&&j.attempts===1);
 await settings({enabled:false,device_key:'replacement-key'});assert.equal((await db.prepare('SELECT status FROM push_jobs WHERE id=?').bind('order:'+o.id).first()).status,'skipped');
 mode=200;const test=await call('/api/admin/push/test',{});assert.equal(test.status,200);await waitJob(test.data.id,j=>j.status==='accepted');assert.equal(requests.at(-1).body.device_key,'replacement-key');assert.match(requests.at(-1).body.body,/未创建订单/);
 assert.equal((await db.prepare('SELECT count(*) n FROM orders').first()).n,1);
});
test('pending jobs survive a lost request worker and logs/counters age out',async()=>{
 await settings();const time=Date.now();await testJob('persisted',time-1000);await testJob('stale',time-8*86400000);let sent=0;
 await deliverNotifications({DB:db},{now:time,fetcher:async()=>{sent++;return Response.json({code:200})}});assert.equal(sent,1);assert.equal((await db.prepare("SELECT status FROM push_jobs WHERE id='persisted'").first()).status,'accepted');assert.equal(await db.prepare("SELECT id FROM push_jobs WHERE id='stale'").first(),null);
});
test('Bark rejects are permanent while timeout is retryable and no credentials enter error text',async()=>{
 const p={device_key:testKey};assert.deepEqual(await sendBark(p,async()=>Response.json({code:400,message:testKey})),{ok:false,retry:false,error:'推送服务未接受，请核对 Bark 密钥或稍后测试'});
 const timeout=await sendBark(p,async()=>{throw Error(testKey)});assert.equal(timeout.retry,true);assert.ok(!timeout.error.includes(testKey));
});

test('WeChat uses only the free wechat channel, escapes content, and opens the specific authenticated order',async()=>{
 assert.throws(()=>pushplusToken('https://www.pushplus.plus'));assert.equal(pushplusToken('a'.repeat(32)),'a'.repeat(32));
 await settings({provider:'pushplus',device_key:'a'.repeat(32),daily_limit:180,message:'新单 <script>secret</script>'});
 const o=await draft();await receipt(o);
 // Persist the same formal event used by submission, then simulate the cloud sender.
 await db.batch([db.prepare("UPDATE orders SET phase='submitted',payment='review' WHERE id=?").bind(o.id),db.prepare("INSERT INTO events(order_id,actor,action,note,created_at) VALUES(?,'customer','正式提交给商家','',?)").bind(o.id,new Date().toISOString())]);
 let payload;await deliverNotifications({DB:db},{fetcher:async(url,init)=>{assert.equal(url,'https://www.pushplus.plus/send');assert.equal(init.redirect,'manual');payload=JSON.parse(init.body);return Response.json({code:200,data:'receipt-ref-123'})}});
 assert.equal(payload.channel,'wechat');assert.equal(payload.template,'html');assert.ok(!payload.content.includes('<script>'));assert.match(payload.content,/&lt;script&gt;/);assert.ok(payload.content.includes('/admin?order='+o.id));assert.ok(!payload.content.includes('Private Name'));
 const state=await db.prepare('SELECT * FROM push_jobs WHERE id=?').bind('order:'+o.id).first();assert.equal(state.status,'accepted');assert.equal(state.provider_ref,'receipt-ref-123');assert.equal(state.callback_token.length,64);
 const callback={event:'message_complate',messageInfo:{shortCode:'receipt-ref-123',sendStatus:2,message:'secret should never be stored'}};
 let r=await mf.dispatchFetch('http://localhost/api/push/callback/'+'0'.repeat(64),{method:'POST',body:JSON.stringify(callback)});assert.equal(r.status,404);
 r=await mf.dispatchFetch(payload.callbackUrl,{method:'POST',body:JSON.stringify({...callback,messageInfo:{...callback.messageInfo,shortCode:'wrong'}})});assert.equal(r.status,400);
 r=await mf.dispatchFetch(payload.callbackUrl,{method:'POST',body:JSON.stringify(callback)});assert.equal(r.status,200);assert.equal((await db.prepare('SELECT status FROM push_jobs WHERE id=?').bind(state.id).first()).status,'delivered');
 assert.equal((await call('/api/orders/'+o.id,undefined,null)).status,404,'notification link never bypasses order authorization');
 assert.ok(!JSON.stringify((await call('/api/admin/push')).data).includes(state.callback_token));
});
test('WeChat pacing and rolling daily cap prevent bursts even across simultaneous senders',async()=>{
 await settings({provider:'pushplus',device_key:'a'.repeat(32),daily_limit:2});const time=Date.now();for(const id of ['w1','w2','w3'])await testJob(id,time-1);let calls=0;const mock=async()=>{calls++;return Response.json({code:200,data:'r'+calls})};
 await Promise.all([deliverNotifications({DB:db},{now:time,fetcher:mock}),deliverNotifications({DB:db},{now:time,fetcher:mock})]);assert.equal(calls,1);
 await deliverNotifications({DB:db},{now:time+15001,fetcher:mock});assert.equal(calls,2);
 assert.equal((await db.prepare("SELECT count(*) n FROM push_jobs WHERE status='failed'").first()).n,1);
});
test('WeChat account errors pause further sends until staff fixes settings or tests again',async()=>{
 await settings({provider:'pushplus',device_key:'a'.repeat(32),daily_limit:180});const time=Date.now();await testJob('bad-account',time-1);await testJob('later-order',time-1);let calls=0;
 await deliverNotifications({DB:db},{now:time,fetcher:async()=>{calls++;return Response.json({code:905,msg:'do not expose '+testKey})}});assert.equal(calls,1);assert.match((await call('/api/admin/push')).data.paused_reason,/实名认证/);assert.ok(!JSON.stringify((await call('/api/admin/push')).data).includes(testKey));
 assert.equal((await sendPushplus({},async()=>Response.json({code:900,msg:testKey}))).pause,true);assert.equal((await sendPushplus({},async()=>Response.json({code:903,msg:testKey}))).retry,false);
});
