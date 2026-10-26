import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import jpeg from 'jpeg-js';
import {unzipSync,strFromU8} from 'fflate';
import {passwordHash,hash} from '../worker/core.js';
import {DEFAULT_CONFIG,currentMenu,nyParts} from '../worker/config.js';
import {normalizeSettings} from '../worker/settings.js';
import {purgeMedia} from '../worker/operations.js';
import {settleDueOrders} from '../worker/fulfillment.js';
import {guardedStorage,COST_LIMITS,costStatus} from '../worker/cost-guard.js';
let mf,db,admin;
const headers={'X-Requested-With':'Weizhuo','Origin':'http://localhost'};
class Client{
 cookies=new Map();
 ip='127.0.0.1';
 async call(path,body,method=body?'POST':'GET',extra={}){
  const h={...headers,'CF-Connecting-IP':this.ip,...extra};if(this.cookies.size)h.Cookie=[...this.cookies].map(([k,v])=>k+'='+v).join('; ');
  if(body instanceof FormData){const encoded=new Response(body);h['Content-Type']=encoded.headers.get('Content-Type');body=new Uint8Array(await encoded.arrayBuffer())}
  else if(body&&!(body instanceof Uint8Array)){h['Content-Type']='application/json';body=JSON.stringify(body)}
  const r=await mf.dispatchFetch('http://localhost'+path,{method,headers:h,body});const cookie=r.headers.get('set-cookie');if(cookie){const pair=cookie.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1))}return r;
 }
 async json(path,p,method,extra){const r=await this.call(path,p,method,extra);return {status:r.status,data:await r.json(),headers:r.headers}}
}
before(async()=>{
 mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'test-db'},r2Buckets:['BUCKET'],bindings:{ADMIN_PASSWORD_HASH:await passwordHash('admin-test-pass')}});
 db=await mf.getD1Database('DB');for(const f of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort()){const sql=await readFile('drizzle/'+f,'utf8');await db.batch(sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)))}
});
after(async()=>{await mf?.dispose()});
beforeEach(async()=>{
 await db.batch(['events','orders','sessions','customers','attempts','settings','tx_guards','challenges','order_history','media_garbage','cleanup_plans','order_references','customer_codes','cost_objects','cost_counters','interaction_guards'].map(t=>db.prepare('DELETE FROM '+t)));
 admin=new Client();assert.equal((await admin.json('/api/admin/login',{username:'admin',password:'admin-test-pass'})).status,200);
 const config=normalizeSettings(DEFAULT_CONFIG);config.slots.forEach(s=>{s.cutoff='23:59';s.enabled=true});await db.prepare('INSERT INTO settings VALUES(1,?)').bind(JSON.stringify(config)).run();
});
async function registration(c,n=1){const challenge=(await c.json('/api/customer/challenge')).data;await db.prepare('UPDATE challenges SET created_at=created_at-2000 WHERE id=?').bind(challenge.id).run();const nums=challenge.question.match(/\d+/g).map(Number);return {phone:'201555'+String(n).padStart(4,'0'),name:'测试顾客 '+n,wechat:'wechat_test_'+n,password:'customer-test-pass',challenge_id:challenge.id,answer:String(nums[0]+nums[1]),device:crypto.randomUUID().replaceAll('-',''),website:''}}
async function customer(n=1){const c=new Client();const r=await c.json('/api/customer/register',await registration(c,n));assert.equal(r.status,201,JSON.stringify(r.data));c.profile=r.data;return c}
async function draft(c,items=[{id:'fried-noodles',option:'chicken',qty:1}],more={}){
 const menu=(await c.json('/api/menu?slot=lunch')).data;
 const total=items.reduce((s,i)=>s+menu.menu.find(m=>m.id===i.id).options.find(o=>o.id===i.option).price*i.qty,0);
 const p={name:c.profile.name,phone:c.profile.phone,wechat:c.profile.wechat,pickup:'jsq2',items,date:menu.date,slot:'lunch',expected_total:total,idempotency_key:crypto.randomUUID().replaceAll('-',''),...more};
 const r=await c.json('/api/orders',p);assert.equal(r.status,201,JSON.stringify(r.data));return {o:r.data,p};
}
function image(){const data=new Uint8Array(64*64*4).fill(180);for(let i=3;i<data.length;i+=4)data[i]=255;return jpeg.encode({width:64,height:64,data},70).data}
async function upload(c,o,raw=image()){
 const f=new FormData();f.set('receipt',new File([raw],'test.jpg',{type:'image/jpeg'}));f.set('channel','Zelle');f.set('payer','Different Payer');return c.json('/api/orders/'+o.id+'/receipt',f);
}
async function submit(c,o){assert.equal((await upload(c,o)).status,200);const r=await c.json('/api/orders/'+o.id+'/submit',{});assert.equal(r.status,200,JSON.stringify(r.data));return (await c.json('/api/orders/'+o.id)).data}
async function ready(o){const latest=(await admin.json('/api/orders/'+o.id)).data;assert.equal((await admin.json('/api/admin/orders/'+o.id+'/prep',{version:latest.version,all:true})).status,200)}
async function action(o,action,extra={}){if(action==='dispatched'){const state=(await admin.json('/api/orders/'+o.id)).data;if(state.fulfillment==='preparing'&&!state.kitchen.ready)await ready(o)}const latest=(await admin.json('/api/orders/'+o.id)).data;return admin.json('/api/admin/orders/'+o.id+'/action',{version:latest.version,action,...extra})}
async function verified(c,o){await submit(c,o);assert.equal((await action(o,'verify',{received_amount:o.total,received_currency:'USD'})).status,200);return o}

test('entry pages use content-versioned scripts and styles and query URLs serve the current asset',async()=>{
 for(const route of ['/','/admin']){
  const html=await (await mf.dispatchFetch('http://localhost'+route)).text();
  const links=[...html.matchAll(/(?:src|href)="(\/static\/[^"?]+\.(?:js|css))(\?v=[a-f0-9]{12})?"/g)];assert.ok(links.length>=5);
  for(const [,path,version] of links){assert.ok(version,'Unversioned asset: '+path);const response=await mf.dispatchFetch('http://localhost'+path+version);assert.equal(response.status,200);assert.equal(await response.text(),await readFile('public/'+path.slice('/static/'.length),'utf8'))}
 }
});

test('real catalog, eight separate delivery points and exact corrected variant prices',async()=>{
 const {data}=await admin.json('/api/menu?slot=lunch');assert.equal(data.menu.length,23);assert.equal(data.pickups.length,8);
 assert.deepEqual(data.menu.find(x=>x.id==='fried-noodles').options.map(x=>x.price),[1450,1650,1750,1750,1650]);
 assert.deepEqual(data.menu.find(x=>x.id==='mung-soup').options.map(x=>x.price),[100,300,500]);
 assert.equal(data.payments.find(x=>x.id==='Zelle').account,'DEMO ONLY - DO NOT PAY');assert.equal(data.payments.find(x=>x.id==='支付宝').account,'仅演示，请勿付款');
 assert.ok(!(await admin.json('/api/menu?slot=dinner')).data.menu.some(x=>x.category==='午餐饭盒'));
});
test('daily rollover uses New York date and switches at local midnight including DST',()=>{
 assert.equal(nyParts(new Date('2026-10-27T03:59:00Z')).date,'2026-10-26');assert.equal(nyParts(new Date('2026-10-27T04:00:00Z')).date,'2026-10-27');
 assert.equal(nyParts(new Date('2026-11-03T04:59:00Z')).date,'2026-11-02');assert.equal(nyParts(new Date('2026-11-03T05:00:00Z')).date,'2026-11-03');
 assert.equal(currentMenu(DEFAULT_CONFIG,'lunch',new Date('2026-10-26T19:00:00Z')).open,false);
});
test('registration, second device login, logout and recovery-code password reset',async()=>{
 const a=await customer(),b=new Client();const {o}=await draft(a);
 assert.equal((await b.json('/api/customer/login',{phone:'2015550001',password:'customer-test-pass'})).status,200);assert.equal((await b.json('/api/orders/'+o.id)).status,200);
 assert.equal((await b.json('/api/customer/reset',{phone:'2015550001',recovery_code:a.profile.recovery_code,password:'new-password-test'})).status,200);
 assert.equal((await a.json('/api/customer/me')).status,401);assert.equal((await b.json('/api/customer/login',{phone:'2015550001',password:'customer-test-pass'})).status,401);
 assert.equal((await b.json('/api/customer/login',{phone:'2015550001',password:'new-password-test'})).status,200);
 await b.json('/api/customer/logout',{});assert.equal((await b.json('/api/customer/orders')).status,401);
});
test('guests cannot access orders or any admin summary, settings, export or backup',async()=>{
 const g=new Client();for(const path of ['/api/admin/orders','/api/admin/settings','/api/admin/export','/api/admin/me','/api/customer/orders'])assert.equal((await g.call(path)).status,401,path);
 assert.equal((await g.call('/api/admin/backup',{})).status,401);assert.equal((await g.call('/api/orders',{})).status,401);
});
test('draft and saved receipt remain hidden from administrator until formal submit',async()=>{
 const c=await customer(),{o}=await draft(c);assert.equal(o.phase,'draft');assert.equal((await admin.json('/api/admin/orders')).data.orders.length,0);assert.equal((await admin.json('/api/orders/'+o.id)).status,404);
 assert.equal((await c.json('/api/orders/'+o.id+'/submit',{})).status,400);const uploaded=await upload(c,o);assert.equal(uploaded.status,200,JSON.stringify(uploaded.data));
 assert.equal((await admin.json('/api/orders/'+o.id+'/receipt')).status,404);assert.equal((await admin.json('/api/admin/orders')).data.orders.length,0);
 assert.equal((await c.json('/api/orders/'+o.id+'/submit',{})).status,200);assert.equal((await admin.json('/api/admin/orders')).data.orders.length,1);
 const fresh=(await admin.json('/api/orders/'+o.id)).data;assert.equal(fresh.payment,'review');assert.equal(fresh.fulfillment,'pending');assert.equal(fresh.payer,'Different Payer');assert.equal((await action(o,'preparing')).status,400);
});
test('different customers cannot read, upload or submit each other orders and private receipts',async()=>{
 const a=await customer(1),b=await customer(2),{o}=await draft(a);await submit(a,o);
 for(const p of ['/api/orders/'+o.id,'/api/orders/'+o.id+'/receipt']){assert.equal((await b.call(p)).status,404);assert.equal((await new Client().call(p)).status,404)}
 assert.equal((await b.json('/api/orders/'+o.id+'/submit',{})).status,404);assert.equal((await upload(b,o)).status,404);
 assert.equal((await b.json('/api/customer/orders')).data.orders.length,0);const d=(await a.json('/api/orders/'+o.id)).data;assert.ok(!('receipt' in d));assert.ok(!('user_id' in d));
});
test('concurrent customers and concurrent idempotent retries preserve distinct records',async()=>{
 const c=await customer(),{o,p}=await draft(c);const repeats=await Promise.all(Array.from({length:8},()=>c.json('/api/orders',p)));assert.ok(repeats.every(r=>r.status===200&&r.data.id===o.id));
 const result=await Promise.all(Array.from({length:6},(_,i)=>draft(c,undefined,{idempotency_key:crypto.randomUUID().replaceAll('-',''),note:'并发 '+i})));assert.equal(new Set(result.map(x=>x.o.id)).size,6);
 assert.equal((await c.json('/api/orders',{...p,name:'改名'})).status,409);assert.equal((await c.json('/api/customer/orders')).data.orders.length,7);
});
test('server validates prices, quote, counts, variants and same-day session',async()=>{
 const c=await customer(),{p}=await draft(c);const retry=extra=>c.json('/api/orders',{...p,idempotency_key:crypto.randomUUID().replaceAll('-',''),...extra});
 assert.equal((await retry({expected_total:1})).status,409);assert.equal((await retry({date:'2000-01-01'})).status,409);
 for(const change of [{qty:-1},{qty:true},{option:'wrong'},{id:'missing'}])assert.ok((await retry({items:[{id:'fried-noodles',option:'veg',qty:1,...change}]})).status>=400);
});
test('invalid and oversized upload retains draft; subsequent valid upload succeeds',async()=>{
 const c=await customer(),{o}=await draft(c);assert.equal((await upload(c,o,new TextEncoder().encode('<script>bad</script>'))).status,400);assert.equal((await upload(c,o,new Uint8Array(5*1024*1024+1))).status,413);
 const fresh=(await c.json('/api/orders/'+o.id)).data;assert.equal(fresh.phase,'draft');assert.equal(fresh.has_receipt,false);assert.equal((await upload(c,o)).status,200);
 const response=await c.call('/api/orders/'+o.id+'/receipt');assert.equal(response.headers.get('Content-Type'),'image/jpeg');assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('CNY and dollar differences require basis; verified values remain separate from USD order',async()=>{
 const c=await customer(),{o}=await draft(c);await submit(c,o);
 assert.equal((await action(o,'verify',{received_amount:11880,received_currency:'CNY'})).status,400);
 assert.equal((await action(o,'verify',{received_amount:11880,received_currency:'CNY',exchange_basis:'确认 1 USD = 7.20 CNY'})).status,200);
 const fresh=(await c.json('/api/orders/'+o.id)).data;assert.equal(fresh.total,1650);assert.equal(fresh.received_amount,11880);assert.equal(fresh.received_currency,'CNY');
});
test('cancel, refund pending and explicit refund completion preserve separate states',async()=>{
 const c=await customer(),{o}=await draft(c);await verified(c,o);assert.equal((await action(o,'cancel',{note:'测试取消'})).status,200);let d=(await c.json('/api/orders/'+o.id)).data;
 assert.equal(d.payment,'refund_pending');assert.equal(d.fulfillment,'cancelled');assert.equal((await upload(c,o)).status,400);
 assert.equal((await action(o,'refunded',{note:'模拟原渠道退款 USD 16.50，参考 DEMO123'})).status,200);assert.equal((await c.json('/api/orders/'+o.id)).data.payment,'refunded');
});
test('batch guard rolls back all writes and version conflicts cannot overwrite updates',async()=>{
 const c=await customer(),a=(await draft(c)).o,b=(await draft(c)).o;await verified(c,a);await verified(c,b);await action(a,'preparing');
 let list=await Promise.all([a,b].map(async o=>{const d=(await admin.json('/api/orders/'+o.id)).data;return {id:d.id,version:d.version}}));
 assert.equal((await admin.json('/api/admin/batch',{action:'dispatched',orders:list})).status,409);assert.equal((await admin.json('/api/orders/'+a.id)).data.fulfillment,'preparing');
 await action(b,'preparing');await ready(a);await ready(b);list=await Promise.all([a,b].map(async o=>{const d=(await admin.json('/api/orders/'+o.id)).data;return {id:d.id,version:d.version}}));
 assert.equal((await admin.json('/api/admin/batch',{action:'dispatched',orders:list})).status,200);
 assert.equal((await admin.json('/api/admin/orders/'+a.id+'/action',{action:'arrived',version:list[0].version})).status,409);
});
test('same-point photo batch is private; arrival does not automatically mean collected',async()=>{
 const a=await customer(1),b=await customer(2),oa=(await draft(a)).o,ob=(await draft(b)).o;
 for(const [c,o] of [[a,oa],[b,ob]]){await verified(c,o);await action(o,'preparing');await action(o,'dispatched')}
 const list=await Promise.all([oa,ob].map(async o=>{const d=(await admin.json('/api/orders/'+o.id)).data;return {id:d.id,version:d.version}}));
 const f=new FormData();f.set('orders',JSON.stringify(list));f.set('photo',new File([image()],'arrived.jpg'));f.set('note','前台架子');assert.equal((await admin.json('/api/admin/arrival',f)).status,200);
 for(const [c,o] of [[a,oa],[b,ob]]){const d=(await c.json('/api/orders/'+o.id)).data;assert.equal(d.fulfillment,'arrived');assert.equal(d.has_arrival_photo,true);assert.equal((await c.call('/api/orders/'+o.id+'/arrival-photo')).status,200)}
 assert.equal((await a.call('/api/orders/'+ob.id+'/arrival-photo')).status,404);assert.equal((await new Client().call('/api/orders/'+oa.id+'/arrival-photo')).status,404);
 assert.equal((await action(oa,'collected')).status,200);assert.equal((await a.json('/api/orders/'+oa.id)).data.fulfillment,'collected');
});
test('batch photo rejects mixed delivery points and validates all versions before writes',async()=>{
 const c=await customer(),a=(await draft(c)).o,b=(await draft(c,undefined,{pickup:'urby'})).o;
 for(const o of [a,b]){await verified(c,o);await action(o,'preparing');await action(o,'dispatched')}
 const list=await Promise.all([a,b].map(async o=>{const d=(await admin.json('/api/orders/'+o.id)).data;return {id:d.id,version:d.version}}));const f=new FormData();f.set('orders',JSON.stringify(list));f.set('photo',new File([image()],'photo.jpg'));
 assert.equal((await admin.json('/api/admin/arrival',f)).status,400);assert.equal((await c.json('/api/orders/'+a.id)).data.has_arrival_photo,false);
});
test('menu changes preserve snapshots and sold-out or paused sessions reject new orders',async()=>{
 const c=await customer(),{o,p}=await draft(c),s=(await admin.json('/api/admin/settings')).data;const item=s.menu.find(x=>x.id==='fried-noodles');item.options.find(x=>x.id==='chicken').price=2500;item.sold_out=true;
 assert.equal((await admin.json('/api/admin/settings',s)).status,200);assert.equal((await c.json('/api/orders/'+o.id)).data.total,1650);assert.equal((await c.json('/api/orders',{...p,idempotency_key:crypto.randomUUID().replaceAll('-','')})).status,409);
 s.revision++;s.slots.find(x=>x.id==='lunch').enabled=false;assert.equal((await admin.json('/api/admin/settings',s)).status,200);assert.equal((await c.json('/api/menu?slot=lunch')).data.open,false);
});
test('xlsx excludes drafts, private links and executable formulas; backup includes referenced photos',async()=>{
 const c=await customer(),hidden=(await draft(c)).o,visible=(await draft(c,undefined,{name:'=HYPERLINK("bad")'})).o;await verified(c,visible);await action(visible,'preparing');
 let r=await admin.call('/api/admin/export'),files=unzipSync(new Uint8Array(await r.arrayBuffer()));assert.equal(r.status,200);const xml=strFromU8(files['xl/worksheets/sheet1.xml']);
 assert.ok(xml.includes('=HYPERLINK'));assert.ok(!xml.includes('<f>'));assert.ok(!xml.includes(hidden.public_id));assert.ok(!xml.includes('receipt/'));assert.equal((xml.match(/<row /g)||[]).length,2);
 r=await admin.call('/api/admin/backup',{});assert.equal(r.status,200);files=unzipSync(new Uint8Array(await r.arrayBuffer()));const backup=JSON.parse(strFromU8(files['orders.json']));assert.equal(backup.orders.length,1);assert.ok(Object.keys(files).some(k=>k.startsWith('images/receipt/')));
});
test('cross-origin writes, missing request header and login brute force are rejected',async()=>{
 const c=new Client();assert.equal((await c.call('/api/admin/login',{username:'admin',password:'admin-test-pass'},'POST',{Origin:'https://other.invalid'})).status,403);
 for(let i=0;i<8;i++)await c.json('/api/admin/login',{username:'admin',password:'wrong'});assert.equal((await c.json('/api/admin/login',{username:'admin',password:'admin-test-pass'})).status,429);
 const r=await mf.dispatchFetch('http://localhost/api/admin/login',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}});assert.equal(r.status,403);
});
test('simultaneous merchant actions apply once and leave no partial guards',async()=>{
 const c=await customer(),{o}=await draft(c);await verified(c,o);const version=(await admin.json('/api/orders/'+o.id)).data.version;
 const results=await Promise.all([admin.json('/api/admin/orders/'+o.id+'/action',{action:'preparing',version}),admin.json('/api/admin/orders/'+o.id+'/action',{action:'cancel',version,note:'并发取消'})]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal((await db.prepare('SELECT count(*) n FROM tx_guards').first()).n,0);
});
test('existing draft survives cutoff, accepts late proof and records late submission',async()=>{
 const c=await customer(),{o}=await draft(c),saved=await db.prepare('SELECT session FROM orders WHERE id=?').bind(o.id).first();const s=JSON.parse(saved.session);s.cutoff='2000-01-01T00:00:00Z';
 await db.prepare('UPDATE orders SET session=? WHERE id=?').bind(JSON.stringify(s),o.id).run();await submit(c,o);const d=(await admin.json('/api/orders/'+o.id)).data;assert.equal(d.payment,'review');assert.ok(d.events.some(e=>e.note.includes('截止后补交')));
});

test('daily schedule overrides, early batch and expired batch visibility use New York time',()=>{
 const s=normalizeSettings(DEFAULT_CONFIG);s.day_overrides['2026-10-26']={slots:structuredClone(s.slots)};s.day_overrides['2026-10-26'].slots[1].batches[0].time='18:15';
 const today=currentMenu(s,'dinner',new Date('2026-10-26T22:12:00Z'));assert.equal(today.batches[0].time,'18:15');assert.equal(today.batches[0].open,true);assert.equal(today.batches[0].name,'早鸟批');
 assert.equal(currentMenu(s,'dinner',new Date('2026-10-26T22:16:00Z')).batches[0].open,false);assert.equal(currentMenu(s,'dinner',new Date('2026-10-27T21:00:00Z')).batches[0].time,'18:10');assert.ok(!('security' in today));
});

test('daily delivery windows include past enabled batches, honor overrides and handle empty/single/paused schedules',()=>{
 const s=normalizeSettings(DEFAULT_CONFIG),date=new Date('2026-10-26T23:00:00Z');
 s.day_overrides['2026-10-26']={slots:structuredClone(s.slots)};
 s.day_overrides['2026-10-26'].slots[1].batches=[
  {id:'last',name:'末批',time:'22:00',enabled:true},
  {id:'off',name:'停开',time:'17:00',enabled:false},
  {id:'early',name:'早鸟',time:'18:15',enabled:true}
 ];
 const today=currentMenu(s,'dinner',date);
 assert.deepEqual(today.slots[1].delivery_window,{start:'18:15',end:'22:00'});
 assert.equal(today.batches.find(b=>b.id==='early').open,false);
 assert.deepEqual(today.slots[0].delivery_window,{start:'12:20',end:'14:00'});
 assert.deepEqual(currentMenu(s,'dinner',new Date('2026-10-27T23:00:00Z')).slots[1].delivery_window,{start:'18:10',end:'21:30'});
 s.day_overrides['2026-10-26'].slots[1].batches[0].enabled=false;
 assert.deepEqual(currentMenu(s,'dinner',date).slots[1].delivery_window,{start:'18:15',end:'18:15'});
 s.day_overrides['2026-10-26'].slots[1].enabled=false;
 assert.equal(currentMenu(s,'dinner',date).slots[1].enabled,false);
 s.day_overrides['2026-10-26'].slots[1].batches=[];
 assert.equal(currentMenu(s,'dinner',date).slots[1].delivery_window,null);
});
test('editable pickups and dated temporary dishes preserve existing snapshots',async()=>{
 const c=await customer(),{o}=await draft(c),s=(await admin.json('/api/admin/settings')).data;
 s.pickups.find(p=>p.id==='jsq2').address='新前台位置';s.pickups.find(p=>p.id==='urby').enabled=false;
 s.menu.push({id:'temporary-food',name:'临时上新',category:'临时菜',subtitle:'当日供应',available_date:s.date,available:true,sold_out:false,slots:['lunch'],options:[{id:'normal',name:'一份',price:1800}]});
 const saved=await admin.json('/api/admin/settings',s);assert.equal(saved.status,200,JSON.stringify(saved.data));let m=(await c.json('/api/menu?slot=lunch')).data;assert.ok(m.menu.some(x=>x.id==='temporary-food'));assert.ok(!m.pickups.some(x=>x.id==='urby'));assert.equal((await c.json('/api/orders/'+o.id)).data.pickup_info.address,'Lobby 外卖架子，或电梯口对面小房间');
 assert.equal((await admin.json('/api/admin/settings',s)).status,409); // stale settings cannot overwrite concurrent edits.
 const tomorrow=structuredClone(s);tomorrow.menu.at(-1).available_date='2000-01-01';assert.ok(!currentMenu(tomorrow,'lunch').menu.some(x=>x.id==='temporary-food'));
});
test('ASAP default, required WeChat and custom location require explicit contact confirmation',async()=>{
 const c=await customer(),{o,p}=await draft(c);assert.equal(o.session.batch_id,'asap');assert.equal(o.wechat,c.profile.wechat);
 const post=extra=>c.json('/api/orders',{...p,idempotency_key:crypto.randomUUID().replaceAll('-',''),...extra});
 assert.equal((await post({wechat:''})).status,400);assert.equal((await post({pickup:'other',pickup_other:'其他前台'})).status,400);assert.equal((await post({pickup:'other',pickup_other:'其他前台',other_confirmed:true})).status,201);assert.equal((await post({batch:'missing'})).status,409);
});
test('selected departure is validated and retained; mixed batches cannot bulk dispatch',async()=>{
 const c=await customer(),s=(await admin.json('/api/admin/settings')).data;s.slots[0].batches=[{id:'late',name:'测试末批',time:'23:59',enabled:true}];assert.equal((await admin.json('/api/admin/settings',s)).status,200);
 const a=(await draft(c,undefined,{batch:'late'})).o,b=(await draft(c)).o;assert.equal(a.session.departure,'23:59');for(const o of [a,b]){await verified(c,o);await action(o,'preparing')}
 const selected=await Promise.all([a,b].map(async o=>{const f=(await admin.json('/api/orders/'+o.id)).data;return {id:o.id,version:f.version}}));assert.equal((await admin.json('/api/admin/batch',{action:'dispatched',orders:selected})).status,400);
});
test('receipt persists across payment-channel edits and metadata updates without reupload',async()=>{
 const c=await customer(),{o}=await draft(c);await upload(c,o);const original=await db.prepare('SELECT receipt FROM orders WHERE id=?').bind(o.id).first();
 assert.equal((await c.json('/api/orders/'+o.id+'/receipt-meta',{channel:'Venmo',payer:'新付款人',transaction_id:'TX123'})).status,200);
 const updated=(await c.json('/api/orders/'+o.id)).data;assert.equal(updated.channel,'Venmo');assert.equal(updated.payer,'新付款人');assert.equal(updated.has_receipt,true);assert.equal((await admin.json('/api/admin/orders')).data.orders.length,0);
 assert.equal((await db.prepare('SELECT receipt FROM orders WHERE id=?').bind(o.id).first()).receipt,original.receipt);assert.equal((await c.json('/api/orders/'+o.id+'/submit',{})).status,200);
});
test('delivery rollback requires reason, preserves payment and hides superseded arrival image',async()=>{
 const c=await customer(),{o}=await draft(c);await verified(c,o);await action(o,'preparing');await action(o,'dispatched');assert.equal((await action(o,'rollback')).status,400);
 assert.equal((await action(o,'rollback',{note:'误点发车'})).status,200);assert.equal((await c.json('/api/orders/'+o.id)).data.fulfillment,'preparing');await action(o,'dispatched');
 const fd=new FormData();fd.set('photo',new File([image()],'arrival.jpg'));assert.equal((await admin.json('/api/orders/'+o.id+'/arrival-photo',fd)).status,200);await action(o,'rollback',{note:'照片上传到错误订单'});
 const fresh=(await c.json('/api/orders/'+o.id)).data;assert.equal(fresh.fulfillment,'dispatched');assert.equal(fresh.payment,'verified');assert.equal(fresh.has_arrival_photo,false);assert.equal((await c.call('/api/orders/'+o.id+'/arrival-photo')).status,404);assert.ok((await admin.json('/api/orders/'+o.id)).data.events.some(e=>e.action.includes('纠正配送状态')));
});
test('notifications follow formal-submission events, including old drafts submitted later',async()=>{
 const c=await customer(),a=(await draft(c)).o,b=(await draft(c)).o;await submit(c,b);const cursor=(await admin.json('/api/admin/updates')).data.cursor;assert.equal((await admin.json('/api/admin/updates?after='+cursor)).data.new_count,0);
 await upload(c,a);assert.equal((await admin.json('/api/admin/updates?after='+cursor)).data.new_count,0);await c.json('/api/orders/'+a.id+'/submit',{});const update=(await admin.json('/api/admin/updates?after='+cursor)).data;assert.equal(update.new_count,1);assert.ok(update.cursor>cursor);assert.equal((await admin.json('/api/admin/updates?after='+update.cursor)).data.new_count,0);
});
test('five-minute inactivity expires on server, polling never renews, active interaction does',async()=>{
 const c=await customer();let t=new Date(Date.now()-4*60000).toISOString();await db.prepare("UPDATE sessions SET last_active=? WHERE role='customer'").bind(t).run();await c.json('/api/customer/orders');assert.equal((await db.prepare("SELECT last_active FROM sessions WHERE role='customer'").first()).last_active,t);
 await c.json('/api/customer/me',undefined,'GET',{'X-WZ-Active':'1'});assert.ok(Date.parse((await db.prepare("SELECT last_active FROM sessions WHERE role='customer'").first()).last_active)>Date.parse(t));
 t=new Date(Date.now()-6*60000).toISOString();await db.prepare("UPDATE sessions SET last_active=? WHERE role='customer'").bind(t).run();assert.equal((await c.json('/api/customer/me',undefined,'GET',{'X-WZ-Active':'1'})).status,401);
 assert.equal((await admin.json('/api/admin/duty',{enabled:true})).status,200);await db.prepare("UPDATE sessions SET last_active=? WHERE role='admin'").bind(t).run();assert.equal((await admin.json('/api/admin/me')).status,200);await admin.json('/api/admin/duty',{enabled:false});await db.prepare("UPDATE sessions SET last_active=? WHERE role='admin'").bind(t).run();assert.equal((await admin.json('/api/admin/me')).status,401);
});
test('registration blocks honeypot, bad challenge, replay, missing WeChat and enforces invitation',async()=>{
 const c=new Client();let p=await registration(c);assert.equal((await c.json('/api/customer/register',{...p,wechat:''})).status,400);assert.equal((await c.json('/api/customer/register',{...p,website:'bot.invalid'})).status,400);assert.equal((await c.json('/api/customer/register',{...p,answer:'wrong'})).status,400);
 const s=(await admin.json('/api/admin/settings')).data;s.security.invite_required=true;s.security.new_invite_code='test-secret-invite';await admin.json('/api/admin/settings',s);
 assert.equal((await c.json('/api/customer/register',p)).status,400);const r=await c.json('/api/customer/register',{...p,invite_code:'test-secret-invite'});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal((await c.json('/api/customer/register',{...p,phone:'2015550099',invite_code:'test-secret-invite'})).status,400);
 const publicMenu=JSON.stringify((await c.json('/api/menu')).data);assert.ok(!publicMenu.includes('invite_hash'));assert.ok(!publicMenu.includes('test-secret-invite'));
});
test('registration rate limit remains atomic under parallel attempts',async()=>{
 const c=new Client(),p=await registration(c);const results=await Promise.all(Array.from({length:12},()=>c.json('/api/customer/register',{...p,website:'bot'})));assert.equal(results.filter(r=>r.status===400).length,6);assert.equal(results.filter(r=>r.status===429).length,6);
});
test('merchant can disable accounts and close registration while preserving existing orders',async()=>{
 const c=await customer(),{o}=await draft(c);await submit(c,o);await admin.json('/api/admin/customer-status',{id:c.profile.id,disabled:true});assert.equal((await c.json('/api/customer/orders')).status,401);assert.equal((await c.json('/api/customer/login',{phone:c.profile.phone,password:'customer-test-pass'})).status,403);assert.equal((await admin.json('/api/orders/'+o.id)).status,200);
 await admin.json('/api/admin/customer-status',{id:c.profile.id,disabled:false});assert.equal((await c.json('/api/customer/login',{phone:c.profile.phone,password:'customer-test-pass'})).status,200);
 const s=(await admin.json('/api/admin/settings')).data;s.security.registration_open=false;await admin.json('/api/admin/settings',s);assert.equal((await c.json('/api/customer/challenge')).status,403);
});
test('merchant history applies date filters before pagination and does not silently truncate',async()=>{
 const c=await customer(),{o}=await draft(c);await submit(c,o);const source=await db.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
 const keys=Object.keys(source).filter(k=>k!=='id'),sql='INSERT INTO orders('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')';const statements=[];
 for(let i=0;i<505;i++){const r={...source,public_id:'page-'+i,idem_hash:'page-'+i,date:i===0?'2001-01-01':source.date};statements.push(db.prepare(sql).bind(...keys.map(k=>r[k])))}
 for(let i=0;i<statements.length;i+=50)await db.batch(statements.slice(i,i+50));
 const first=(await admin.json('/api/admin/orders?date='+source.date)).data;assert.equal(first.orders.length,500);assert.ok(first.next);const second=(await admin.json('/api/admin/orders?date='+source.date+'&before='+first.next)).data;assert.equal(second.orders.length,5);assert.equal(new Set([...first.orders,...second.orders].map(o=>o.id)).size,505);
 const historical=(await admin.json('/api/admin/orders?date=2001-01-01')).data;assert.equal(historical.orders.length,1);
});
test('ten independent accounts concurrently create, upload and submit twenty isolated orders',async t=>{
 const clients=[];for(let n=1;n<=10;n++){const c=new Client();c.ip='192.0.2.'+n;const r=await c.json('/api/customer/register',await registration(c,100+n));assert.equal(r.status,201);c.profile=r.data;clients.push(c)}
 const started=performance.now();const results=await Promise.all(clients.flatMap(c=>[1,2].map(async n=>{const {o}=await draft(c,undefined,{note:'并发验收 '+n});await submit(c,o);return {c,o}})));
 assert.equal(new Set(results.map(x=>x.o.id)).size,20);assert.equal((await admin.json('/api/admin/orders')).data.orders.length,20);
 for(let n=0;n<10;n++){assert.equal((await clients[n].json('/api/customer/orders')).data.orders.length,2);const foreign=results.find(x=>x.c!==clients[n]).o;assert.equal((await clients[n].call('/api/orders/'+foreign.id)).status,404)}
 t.diagnostic('Local Miniflare: 20 concurrent order+receipt+submit flows completed in '+Math.round(performance.now()-started)+' ms; not a production daily-capacity guarantee.');
});
test('legacy drafts can add mandatory WeChat without losing saved receipt',async()=>{
 const c=await customer(),{o}=await draft(c);await upload(c,o);await db.prepare("UPDATE orders SET wechat='' WHERE id=?").bind(o.id).run();assert.equal((await c.json('/api/orders/'+o.id+'/submit',{})).status,400);
 assert.equal((await c.json('/api/orders/'+o.id+'/contact',{wechat:'legacy_contact'})).status,200);assert.equal((await c.json('/api/orders/'+o.id+'/submit',{})).status,200);const fresh=(await c.json('/api/orders/'+o.id)).data;assert.equal(fresh.has_receipt,true);assert.equal(fresh.wechat,'legacy_contact');
});

test('kitchen completion is per order variant, concurrency guarded, and required for dispatch',async()=>{
 const c=await customer(),{o}=await draft(c,[{id:'fried-noodles',option:'chicken',qty:2},{id:'fried-noodles',option:'veg',qty:1}]);await verified(c,o);await action(o,'preparing');
 let f=(await admin.json('/api/orders/'+o.id)).data;assert.equal(f.kitchen.remaining,3);
 assert.equal((await admin.json('/api/admin/orders/'+o.id+'/action',{action:'dispatched',version:f.version})).status,400);
 assert.equal((await c.json('/api/admin/orders/'+o.id+'/prep',{version:f.version,all:true})).status,401);
 const p={version:f.version,index:0,completed:1};assert.equal((await admin.json('/api/admin/orders/'+o.id+'/prep',p)).status,200);assert.equal((await admin.json('/api/admin/orders/'+o.id+'/prep',p)).status,409);
 f=(await admin.json('/api/orders/'+o.id)).data;assert.equal(f.kitchen.remaining,2);assert.equal(f.kitchen.lines[1].done,0);assert.equal((await admin.json('/api/admin/orders/'+o.id+'/prep',{version:f.version,index:0,completed:3})).status,400);
 assert.equal((await admin.json('/api/admin/orders/'+o.id+'/prep',{version:f.version,index:0,completed:0})).status,200);await ready(o);assert.equal((await action(o,'dispatched')).status,200);
 const other=(await draft(c)).o;await verified(c,other);await action(other,'preparing');assert.equal((await admin.json('/api/orders/'+other.id)).data.kitchen.remaining,1);assert.equal((await admin.json('/api/orders/'+o.id)).data.kitchen.ready,true);
});
test('receipt replacement deletes obsolete objects; completion deletes receipts but shared arrival waits for last order',async()=>{
 const c=await customer(),a=(await draft(c)).o,b=(await draft(c)).o;await upload(c,a);const bucket=await mf.getR2Bucket('BUCKET'),old=(await db.prepare('SELECT receipt FROM orders WHERE id=?').bind(a.id).first()).receipt;await upload(c,a);assert.equal(await bucket.get(old),null);
 for(const o of [a,b]){await verified(c,o);await action(o,'preparing');await action(o,'dispatched')}
 const list=await Promise.all([a,b].map(async o=>{const d=(await admin.json('/api/orders/'+o.id)).data;return {id:d.id,version:d.version}}));const f=new FormData();f.set('orders',JSON.stringify(list));f.set('photo',new File([image()],'photo.jpg'));assert.equal((await admin.json('/api/admin/arrival',f)).status,200);
 const row=await db.prepare('SELECT receipt,arrival_photo FROM orders WHERE id=?').bind(a.id).first();await action(a,'collected');assert.equal(await bucket.get(row.receipt),null);assert.ok(await bucket.get(row.arrival_photo));assert.equal((await c.call('/api/orders/'+a.id+'/arrival-photo')).status,404);assert.equal((await c.call('/api/orders/'+b.id+'/arrival-photo')).status,200);
 await action(b,'collected');assert.equal(await bucket.get(row.arrival_photo),null);assert.equal((await db.prepare('SELECT count(*) n FROM media_garbage').first()).n,0);
});
test('refund pending keeps proof until refund is explicitly completed',async()=>{
 const c=await customer(),{o}=await draft(c);await verified(c,o);await action(o,'cancel',{note:'退款测试'});const row=await db.prepare('SELECT receipt FROM orders WHERE id=?').bind(o.id).first(),bucket=await mf.getR2Bucket('BUCKET');assert.ok(await bucket.get(row.receipt));
 await admin.json('/api/admin/media/cleanup',{});assert.ok(await bucket.get(row.receipt));await action(o,'refunded',{note:'测试退款处理结束'});assert.equal(await bucket.get(row.receipt),null);assert.ok((await c.json('/api/orders/'+o.id)).data.media_removed_at);
});
async function oldClosed(c){const {o}=await draft(c);await verified(c,o);await action(o,'cancel',{note:'历史验收'});await action(o,'refunded',{note:'模拟退款已完成'});await db.prepare('UPDATE orders SET closed_at=?,updated_at=? WHERE id=?').bind('2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z',o.id).run();return o}
async function prepareCleanup(ids){const r=await admin.call('/api/admin/retention/prepare',{ids});assert.equal(r.status,200);const bytes=new Uint8Array(await r.arrayBuffer()),archiveHash=r.headers.get('X-Archive-SHA256');assert.equal(await hash(bytes),archiveHash);return {files:unzipSync(bytes),payload:{token:r.headers.get('X-Cleanup-Token'),archive_hash:archiveHash,download_confirmed:true,confirmation:'删除 '+ids.length+' 笔旧订单'}}}
test('seven day cleanup requires backup and explicit confirmation, retains private repeat-order history',async()=>{
 const a=await customer(1),b=await customer(2),o=await oldClosed(a),pending=(await draft(a)).o;await verified(a,pending);await action(pending,'cancel',{note:'尚待退款'});await db.prepare('UPDATE orders SET updated_at=? WHERE id=?').bind('2025-01-01T00:00:00.000Z',pending.id).run();
 let d=(await admin.json('/api/admin/retention')).data;assert.deepEqual(d.orders.map(x=>x.id),[o.id]);assert.equal((await admin.json('/api/admin/retention/confirm',{token:'invented'})).status,400);assert.equal((await admin.json('/api/admin/retention/prepare',{ids:[pending.id]})).status,409);
 const prepared=await prepareCleanup([o.id]);assert.equal(JSON.parse(strFromU8(prepared.files['orders.json'])).orders[0].id,o.id);assert.ok(!prepared.files['customers.json']);
 assert.equal((await admin.json('/api/admin/retention/confirm',{...prepared.payload,download_confirmed:false})).status,400);assert.equal((await a.json('/api/admin/retention/confirm',prepared.payload)).status,401);
 assert.equal((await admin.json('/api/admin/retention/confirm',prepared.payload)).status,200);assert.equal((await admin.json('/api/admin/retention/confirm',prepared.payload)).data.already_done,true);
 assert.equal((await admin.json('/api/orders/'+o.id)).status,404);assert.equal((await db.prepare('SELECT count(*) n FROM events WHERE order_id=?').bind(o.id).first()).n,0);
 const h=(await a.json('/api/customer/history')).data.history;assert.equal(h[0].id,o.id);for(const key of ['phone','wechat','payer','transaction_id','receipt','note','total','user_id'])assert.ok(!(key in h[0]),key);assert.equal((await b.json('/api/customer/history')).data.history.length,0);assert.equal((await b.json('/api/customer/reorder',{id:o.id,slot:'lunch'})).status,404);assert.equal((await a.json('/api/customer/reorder',{id:o.id,slot:'lunch'})).data.cart.length,1);
});
test('cleanup rejects changed snapshots atomically and newly completed old orders must still wait seven days',async()=>{
 const c=await customer(),a=await oldClosed(c),b=await oldClosed(c),prepared=await prepareCleanup([a.id,b.id]);await db.prepare('UPDATE orders SET version=version+1 WHERE id=?').bind(b.id).run();assert.equal((await admin.json('/api/admin/retention/confirm',prepared.payload)).status,409);assert.equal((await admin.json('/api/orders/'+a.id)).status,200);assert.equal((await db.prepare('SELECT count(*) n FROM order_history').first()).n,0);
 await db.prepare('UPDATE orders SET closed_at=? WHERE id=?').bind(new Date().toISOString(),a.id).run();assert.equal((await admin.json('/api/admin/retention/prepare',{ids:[a.id]})).status,409);
});
test('history reorder refreshes prices, skips unavailable variants and never submits automatically',async()=>{
 const c=await customer(),{o}=await draft(c,[{id:'fried-noodles',option:'chicken',qty:2},{id:'mung-soup',option:'small',qty:1}]),s=(await admin.json('/api/admin/settings')).data;
 s.menu.find(x=>x.id==='fried-noodles').options.find(x=>x.id==='chicken').price=1900;s.menu.find(x=>x.id==='mung-soup').sold_out=true;await admin.json('/api/admin/settings',s);
 const r=await c.json('/api/customer/reorder',{id:o.id,slot:'lunch'});assert.equal(r.status,200);assert.equal(r.data.cart.length,1);assert.equal(r.data.cart[0].qty,2);assert.equal(r.data.warnings.length,2);assert.equal((await db.prepare('SELECT count(*) n FROM orders').first()).n,1);assert.equal((await c.json('/api/orders/'+o.id)).data.total,3400);
});
test('customer can edit own profile cross-device without changing order snapshots or other users',async()=>{
 const a=await customer(1),b=await customer(2),{o}=await draft(a),me=(await a.json('/api/customer/me')).data,p={version:me.profile_version,name:'新称呼',wechat:'new_wechat',contact_phone:'2015558888',pickup:'journal18',pickup_other:'',note:'微辣',user_id:b.profile.id};
 assert.equal((await a.json('/api/customer/profile',p)).status,200);assert.equal((await a.json('/api/customer/profile',p)).status,409);const other=new Client();await other.json('/api/customer/login',{phone:a.profile.phone,password:'customer-test-pass'});assert.equal((await other.json('/api/customer/me')).data.profile.pickup,'journal18');assert.equal((await b.json('/api/customer/me')).data.name,b.profile.name);assert.equal((await a.json('/api/orders/'+o.id)).data.name,a.profile.name);
 assert.equal((await a.json('/api/customer/password',{current_password:'wrong',password:'updated-test-password'})).status,400);assert.equal((await a.json('/api/customer/password',{current_password:'customer-test-pass',password:'updated-test-password'})).status,200);assert.equal((await other.json('/api/customer/me')).status,401);assert.equal((await a.json('/api/customer/me')).status,200);
});
test('failed R2 deletion remains queued for retry and referenced photos cannot starve unrelated cleanup',async()=>{
 const bucket=await mf.getR2Bucket('BUCKET'),key='receipt/qa-delete-retry.jpg';await bucket.put(key,image());await db.prepare('INSERT INTO media_garbage(key,created_at) VALUES(?,?)').bind(key,'2000-01-01T00:00:00Z').run();
 const failed=await purgeMedia({DB:db,BUCKET:{delete:async()=>{throw Error('simulated storage outage')}}});assert.equal(failed.pending,1);assert.ok(await bucket.get(key));assert.equal((await db.prepare('SELECT attempts FROM media_garbage WHERE key=?').bind(key).first()).attempts,1);
 const success=await purgeMedia({DB:db,BUCKET:bucket});assert.equal(success.pending,0);assert.equal(await bucket.get(key),null);
});

test('display references differ by audience, match by four digits and survive archival',async()=>{
 const a=await customer(1),b=await customer(2);const [{o:first},{o:second},{o:other}]=await Promise.all([draft(a),draft(a),draft(b)]);
 assert.equal(new Set([first.check_code,second.check_code,other.check_code]).size,3);
 assert.deepEqual([first.customer_sequence,second.customer_sequence].sort(),[1,2]);assert.equal(other.customer_sequence,1);
 await verified(a,first);const merchant=(await admin.json('/api/orders/'+first.id)).data;
 assert.notEqual(merchant.number,first.number);assert.equal(merchant.number.slice(-4),first.number.slice(-4));assert.match(first.check_code,/^\d{4}$/);
 const old=await oldClosed(a),prepared=await prepareCleanup([old.id]);assert.equal((await admin.json('/api/admin/retention/confirm',prepared.payload)).status,200);
 const history=(await a.json('/api/customer/history')).data.history[0];assert.equal(history.number,old.number);assert.equal(history.check_code,old.check_code);
 const next=(await draft(a)).o;assert.ok(next.customer_sequence>old.customer_sequence);assert.notEqual(next.check_code,old.check_code);
});
test('only owning customer can confirm after arrival; manual confirmation is idempotent and cleans photos',async()=>{
 const c=await customer(1),stranger=await customer(2),{o}=await draft(c);await verified(c,o);
 let fresh=(await c.json('/api/orders/'+o.id)).data;
 assert.equal((await c.json('/api/orders/'+o.id+'/confirm-received',{version:fresh.version})).status,409);
 await action(o,'preparing');await action(o,'dispatched');await action(o,'arrived');fresh=(await c.json('/api/orders/'+o.id)).data;
 assert.equal(Date.parse(fresh.auto_confirm_at)-Date.parse(fresh.arrived_at),900000);
 assert.equal((await stranger.json('/api/orders/'+o.id+'/confirm-received',{version:fresh.version})).status,404);
 assert.equal((await c.json('/api/orders/'+o.id+'/confirm-received',{version:fresh.version})).status,200);
 assert.equal((await c.json('/api/orders/'+o.id+'/confirm-received',{version:fresh.version})).data.already_done,true);
 fresh=(await c.json('/api/orders/'+o.id)).data;assert.equal(fresh.confirmed_by,'customer');assert.equal(fresh.has_receipt,false);
 assert.equal((await admin.json('/api/orders/'+o.id)).data.events.filter(x=>x.action==='顾客确认已收到餐品').length,1);
});
test('cloud scheduler confirms at 15 minutes without a browser and rollback cancels the timer',async()=>{
 const c=await customer(),a=(await draft(c)).o,b=(await draft(c)).o;
 for(const o of [a,b]){await verified(c,o);await action(o,'preparing');await action(o,'dispatched');await action(o,'arrived')}
 const fresh=(await c.json('/api/orders/'+a.id)).data,env={DB:db,BUCKET:await mf.getR2Bucket('BUCKET')};
 assert.equal((await settleDueOrders(env,new Date(Date.parse(fresh.auto_confirm_at)-1).toISOString())).confirmed,0);
 await action(b,'rollback',{note:'误报送达'});assert.equal((await c.json('/api/orders/'+b.id)).data.auto_confirm_at,null);
 await db.prepare('UPDATE orders SET auto_confirm_at=? WHERE id=?').bind(new Date(Date.now()-1000).toISOString(),a.id).run();
 const worker=await import('../dist/server/index.js');let pending;await worker.default.scheduled({},env,{waitUntil:p=>{pending=p}});await pending;
 const result=await db.prepare('SELECT fulfillment,confirmed_by,receipt FROM orders WHERE id=?').bind(a.id).first();assert.equal(result.fulfillment,'collected');assert.equal(result.confirmed_by,'system');assert.equal(result.receipt,null);
 assert.equal((await c.json('/api/orders/'+b.id)).data.fulfillment,'dispatched');assert.equal((await settleDueOrders(env)).confirmed,0);
 const events=(await admin.json('/api/orders/'+a.id)).data.events;assert.equal(events.filter(x=>x.actor==='system'&&x.action.includes('自动确认')).length,1);
});
test('cost guard reserves concurrently, stops at limits and permits idempotent cleanup',async()=>{
 let puts=0,gets=0,deletes=0;const env=guardedStorage({DB:db,COST_GUARD_ENABLED:'1',BUCKET:{put:async()=>{puts++},get:async()=>{gets++;return null},delete:async()=>{deletes++}}});
 await db.prepare("INSERT INTO cost_counters(key,value) VALUES('stored',?)").bind(COST_LIMITS.stored_bytes-10).run();
 const result=await Promise.allSettled([env.BUCKET.put('qa/a',new Uint8Array(10)),env.BUCKET.put('qa/b',new Uint8Array(10))]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(puts,1);
 const key=(await db.prepare('SELECT key FROM cost_objects').first()).key;await env.BUCKET.delete(key);await env.BUCKET.delete(key);assert.equal((await costStatus(env)).used.stored_bytes,COST_LIMITS.stored_bytes-10);
 await db.prepare('INSERT INTO cost_counters(key,value) VALUES(?,?)').bind('read:'+new Date().toISOString().slice(0,7),COST_LIMITS.reads_month).run();await assert.rejects(env.BUCKET.get('qa/c'),/保护上限/);assert.equal(gets,0);assert.equal(deletes,2);
});


test('test orders are excluded from real lists, alerts and every business export sheet',async()=>{
 const c=await customer(),{o:real}=await draft(c,undefined,{name:'营业顾客'}),{o:testing}=await draft(c,undefined,{name:'不计营业验收',is_test:true});
 assert.equal(testing.is_test,false);await verified(c,real);await action(real,'preparing');await verified(c,testing);await action(testing,'preparing');
 const before=(await admin.json('/api/orders/'+testing.id)).data;
 assert.equal((await c.json('/api/admin/orders/'+testing.id+'/kind',{is_test:true,version:before.version,note:'验收'})).status,401);
 assert.equal((await admin.json('/api/admin/orders/'+testing.id+'/kind',{is_test:true,version:before.version,note:'验收，不计营业'})).status,200);
 const ordinary=(await admin.json('/api/admin/orders')).data.orders;assert.deepEqual(ordinary.map(x=>x.id),[real.id]);assert.equal(ordinary.reduce((n,o)=>n+o.total,0),real.total);
 const tests=(await admin.json('/api/admin/orders?scope=test')).data.orders;assert.deepEqual(tests.map(x=>x.id),[testing.id]);assert.equal(tests[0].kitchen.total,1);
 assert.equal((await admin.json('/api/admin/updates?after=0')).data.new_count,1);assert.equal((await admin.json('/api/admin/orders?scope=all')).status,400);
 const files=unzipSync(new Uint8Array(await (await admin.call('/api/admin/export')).arrayBuffer()));
 for(const [name,data] of Object.entries(files))if(name.startsWith('xl/worksheets/'))assert.ok(!strFromU8(data).includes(tests[0].number));
 assert.ok(strFromU8(files['xl/worksheets/sheet1.xml']).includes('营业顾客'));assert.ok(!strFromU8(files['xl/worksheets/sheet1.xml']).includes('不计营业验收'));
 const testExport=await admin.call('/api/admin/export?scope=test');assert.match(testExport.headers.get('content-disposition'),/test-orders/);const tf=unzipSync(new Uint8Array(await testExport.arrayBuffer()));assert.ok(strFromU8(tf['xl/worksheets/sheet1.xml']).includes('测试订单（不计营业）'));
 assert.equal((await admin.json('/api/admin/orders/'+testing.id+'/kind',{is_test:false,version:before.version,note:'stale'})).status,409);
 const fresh=(await admin.json('/api/orders/'+testing.id)).data;assert.equal((await admin.json('/api/admin/orders/'+testing.id+'/kind',{is_test:false,version:fresh.version,note:'恢复真实'})).status,200);
 assert.equal((await admin.json('/api/admin/orders')).data.orders.length,2);
});

test('developer is a merchant peer, can only create test orders, and downgrade revokes admin access',async()=>{
 const c=new Client(),registrationBody=await registration(c,9);registrationBody.account_type='developer';registrationBody.name='Peter';const r=await c.json('/api/customer/register',registrationBody);assert.equal(r.status,201);c.profile=r.data;
 assert.equal((await c.json('/api/customer/me')).data.account_type,'customer');const d=new Client();
 assert.equal((await d.json('/api/admin/login',{username:c.profile.phone,password:'customer-test-pass'})).status,401);
 assert.equal((await admin.json('/api/admin/customer-type',{id:c.profile.id,account_type:'developer',expected_type:'customer'})).status,200);
 assert.equal((await d.json('/api/admin/login',{username:c.profile.phone,password:'customer-test-pass'})).status,200);
 for(const path of ['/api/admin/orders','/api/admin/settings','/api/admin/customers','/api/admin/coupons'])assert.equal((await d.json(path)).status,200,path);
 const {o}=await draft(c,undefined,{is_test:false});assert.equal(o.is_test,true);assert.equal(o.test_only,true);await submit(c,o);assert.equal((await d.json('/api/admin/orders')).data.orders.length,0);assert.equal((await d.json('/api/admin/orders?scope=test')).data.orders[0].id,o.id);
 assert.equal((await d.json('/api/admin/orders/'+o.id+'/kind',{version:(await d.json('/api/orders/'+o.id)).data.version,is_test:false,note:'不可转真实'})).status,400);
 assert.equal((await d.json('/api/admin/orders/'+o.id+'/action',{action:'verify',version:(await d.json('/api/orders/'+o.id)).data.version,received_amount:o.total,received_currency:'USD'})).status,200);
 assert.equal((await admin.json('/api/admin/customer-type',{id:c.profile.id,account_type:'customer',expected_type:'developer'})).status,200);
 assert.equal((await d.json('/api/admin/orders')).status,401);assert.equal((await c.json('/api/customer/orders')).status,200);
 assert.equal((await c.json('/api/orders/'+o.id)).data.is_test,true);
});

test('super consumer is exempt but cannot enter backend; new orders remain real after historical test flags',async()=>{
 const c=await customer(),{o:old}=await draft(c);await submit(c,old);await admin.json('/api/admin/orders/'+old.id+'/kind',{version:(await admin.json('/api/orders/'+old.id)).data.version,is_test:true,note:'以前的测试单'});
 assert.equal((await admin.json('/api/admin/customer-type',{id:c.profile.id,account_type:'super_customer',expected_type:'customer'})).status,200);
 assert.equal((await c.json('/api/customer/me')).data.account_type,'super_customer');
 for(let i=0;i<35;i++)assert.equal((await c.json('/api/navigation',{})).data.exempt,true);
 const backend=new Client();assert.equal((await backend.json('/api/admin/login',{username:c.profile.phone,password:'customer-test-pass'})).status,401);assert.equal((await c.json('/api/admin/orders')).status,401);
 const {o}=await draft(c);assert.equal(o.is_test,false);assert.equal(o.test_only,false);await submit(c,o);
 assert.deepEqual((await admin.json('/api/admin/orders')).data.orders.map(x=>x.id),[o.id]);assert.equal((await c.json('/api/orders/'+old.id)).data.is_test,true);
});

test('independent developer alias logs in on both pages; staff-created orders are also test-only',async()=>{
 const input={login_name:'developer',phone:'2025550199',name:'独立开发者',wechat:'demo_developer',password:'developer-test-pass'};
 const ordinary=await customer();assert.equal((await ordinary.json('/api/admin/developer-account',input)).status,401);
 const created=await admin.json('/api/admin/developer-account',input);assert.equal(created.status,200);
 assert.equal((await admin.json('/api/admin/developer-account',input)).status,409);
 const dev=new Client();assert.equal((await dev.json('/api/customer/login',{phone:'developer',password:input.password})).status,200);assert.equal((await dev.json('/api/customer/me')).data.login_name,'developer');
 assert.equal((await dev.json('/api/admin/login',{username:'developer',password:input.password})).status,200);
 assert.equal((await dev.json('/api/admin/coupons')).data.can_manage,true);assert.equal((await dev.json('/api/admin/coupons/issue',{})).status,409);
 const menu=(await dev.json('/api/menu?slot=lunch')).data;
 const made=await dev.json('/api/orders',{source:'staff',name:'开发者代客测试',phone:input.phone,wechat:input.wechat,pickup:'jsq2',items:[{id:'fried-noodles',option:'chicken',qty:1}],date:menu.date,slot:'lunch',expected_total:1650,idempotency_key:crypto.randomUUID().replaceAll('-',''),is_test:false});
 assert.equal(made.status,201);assert.equal(made.data.test_only,true);assert.equal(made.data.is_test,true);assert.ok(!('created_by' in made.data));
 assert.equal((await admin.json('/api/admin/orders/'+made.data.id+'/kind',{version:made.data.version,is_test:false,note:'主管理员也不能转真实'})).status,400);
 await assert.rejects(db.prepare('UPDATE orders SET is_test=0 WHERE id=?').bind(made.data.id).run());
});

test('navigation challenge is server enforced, one use, and preserves saved orders',async()=>{
 const c=await customer(),{o}=await draft(c);let result;
 for(let i=0;i<30;i++){result=await c.json('/api/navigation',{});assert.equal(result.status,200)}
 result=await c.json('/api/navigation',{});assert.equal(result.status,428);const challenge=result.data.challenge;
 assert.equal((await c.json('/api/customer/orders')).status,428);assert.equal((await c.json('/api/orders/'+o.id)).status,428);
 assert.ok(!('answer_hash' in challenge));const other=await customer(2);assert.equal((await other.json('/api/navigation/verify',{challenge_id:challenge.id,answer:'1'})).status,400);
 assert.equal((await c.json('/api/navigation/verify',{challenge_id:challenge.id,answer:'999'})).status,428);
 const answer=String(challenge.question.match(/\d+/g).map(Number).reduce((a,b)=>a+b));
 assert.equal((await c.json('/api/navigation/verify',{challenge_id:challenge.id,answer})).status,200);
 assert.equal((await c.json('/api/navigation/verify',{challenge_id:challenge.id,answer})).status,400);
 assert.equal((await c.json('/api/orders/'+o.id)).data.id,o.id);assert.equal((await c.json('/api/navigation',{})).status,200);
});

test('administrator and developer navigation exempt; expired arithmetic challenge rotates',async()=>{
 const c=await customer();await admin.json('/api/admin/customer-type',{id:c.profile.id,account_type:'developer',expected_type:'customer'});
 for(let i=0;i<35;i++){assert.equal((await c.json('/api/navigation',{})).data.exempt,true);assert.equal((await admin.json('/api/navigation',{})).data.exempt,true)}
 assert.equal((await db.prepare('SELECT count(*) n FROM interaction_guards').first()).n,0);
 await admin.json('/api/admin/customer-type',{id:c.profile.id,account_type:'customer',expected_type:'developer'});
 let r;for(let i=0;i<31;i++)r=await c.json('/api/navigation',{});const old=r.data.challenge;
 await db.prepare('UPDATE interaction_guards SET expires=0').run();const answer=String(old.question.match(/\d+/g).map(Number).reduce((a,b)=>a+b));
 const expired=await c.json('/api/navigation/verify',{challenge_id:old.id,answer});assert.equal(expired.status,428);assert.notEqual(expired.data.challenge.id,old.id);
});

test('archived simplified history preserves test flag without leaking another user records',async()=>{
 const c=await customer(),{o}=await draft(c);await verified(c,o);await action(o,'preparing');await action(o,'dispatched');await action(o,'arrived');await action(o,'collected');
 const fresh=(await admin.json('/api/orders/'+o.id)).data;await admin.json('/api/admin/orders/'+o.id+'/kind',{is_test:true,version:fresh.version,note:'测试归档'});
 await db.prepare('UPDATE orders SET closed_at=? WHERE id=?').bind(new Date(Date.now()-8*86400000).toISOString(),o.id).run();
 const prep=await admin.call('/api/admin/retention/prepare',{ids:[o.id]});assert.equal(prep.status,200);
 const r=await admin.json('/api/admin/retention/confirm',{token:prep.headers.get('X-Cleanup-Token'),archive_hash:prep.headers.get('X-Archive-SHA256'),download_confirmed:true,confirmation:'删除 1 笔旧订单'});assert.equal(r.status,200,JSON.stringify(r.data));
 const history=(await c.json('/api/customer/history')).data.history;assert.equal(history.length,1);assert.equal(history[0].is_test,1);assert.ok(!('user_id' in history[0]));
});

test('coupon extension stays disabled and never silently discounts an order',async()=>{
 const c=await customer();assert.equal((await c.json('/api/admin/coupons')).status,401);
 const info=(await admin.json('/api/admin/coupons')).data;assert.equal(info.enabled,false);assert.equal(info.can_issue,false);assert.equal(info.can_manage,true);
 assert.equal((await admin.json('/api/admin/coupons/issue',{})).status,409);
 const {p}=await draft(c);assert.equal((await c.json('/api/orders',{...p,idempotency_key:crypto.randomUUID().replaceAll('-',''),coupon_code:'FAKE'})).status,409);
});
