import {DEFAULT_CONFIG,currentMenu,nyParts} from './config.js';
import {normalizeSettings,validateSettings} from './settings.js';
import {xlsx} from './files.js';
import {validateUploadJpeg} from './uploads.js';
import {zipSync,strToU8} from 'fflate';
import {operations,prepInfo,closed,queueMedia,purgeMedia} from './operations.js';
import {navigationGuard} from './navigation-guard.js';
import {orderScope} from './order-kind.js';
import {orderReference} from './references.js';
import {confirmReceipt,settleDueOrders} from './fulfillment.js';
import {guardedStorage,costStatus,requireUploadCapacity} from './cost-guard.js';

const PAY={unpaid:'未报付款',review:'待核实',verified:'已核实',exception:'付款异常',refund_pending:'退款待处理',refunded:'已退款'};
const FUL={pending:'待接单',preparing:'备餐中',dispatched:'已发车',arrived:'已到配送点',collected:'已领取',cancelled:'已取消'};
const ACTIVE=['preparing','dispatched','arrived'];
const enc=new TextEncoder();const now=()=>new Date().toISOString();const uuid=()=>crypto.randomUUID();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(v){return hex(await crypto.subtle.digest('SHA-256',v instanceof Uint8Array?v:enc.encode(v)))}
export async function passwordHash(v,salt=hex(crypto.getRandomValues(new Uint8Array(16)))){
 const key=await crypto.subtle.importKey('raw',enc.encode(v),'PBKDF2',false,['deriveBits']);
 return `pbkdf2$100000$${salt}$${hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},key,256))}`;
}
async function passwordMatches(v,stored){
 if(!stored)return false;const parts=stored.split('$');if(parts.length!==4||parts[0]!=='pbkdf2')return false;
 const value=await passwordHash(v,parts[2]);let difference=value.length^stored.length;for(let i=0;i<Math.max(value.length,stored.length);i++)difference|=(value.charCodeAt(i)||0)^(stored.charCodeAt(i)||0);return difference===0;
}
class HttpError extends Error{constructor(message,status=400){super(message);this.status=status}}
function bad(message,status=400){throw new HttpError(message,status)}
const json=(obj,status=200,headers={})=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
function text(v,key,max=200,required=false){const s=v?.[key]??'';if(typeof s!=='string'||s.length>max)bad('字段格式不正确：'+key);const t=s.trim();if(required&&!t)bad('请填写：'+key);return t}
function phone(raw){let p=String(raw).trim().replace(/[()\s.-]/g,'');if(/^\d{10}$/.test(p))p='+1'+p;else if(/^1\d{10}$/.test(p))p='+'+p;if(!/^\+\d{7,15}$/.test(p))bad('请输入有效手机号，美国号码可直接填 10 位数字；其他地区请带国家区号。');return p}
function checkPassword(p){if(typeof p!=='string'||p.length<8||p.length>128)bad('密码需为 8–128 个字符')}
function integer(v,min,max,label){if(!Number.isInteger(v)||v<min||v>max)bad(label+'不正确');return v}
function snapshotCutoff(menu){
 const part=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'longOffset'}).formatToParts(new Date()).find(x=>x.type==='timeZoneName').value;
 return new Date(`${menu.date}T${menu.cutoff_time}:00${part.replace('GMT','')||'+00:00'}`).toISOString();
}
async function boundedBody(request,limit){
 if(Number(request.headers.get('Content-Length')||0)>limit)bad('文件或请求太大',413);
 if(!request.body)return new Uint8Array();const reader=request.body.getReader();let size=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();bad('文件或请求太大',413)}chunks.push(value)}
 const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length}return out;
}
async function body(request){try{const b=await boundedBody(request,200_000);const p=JSON.parse(new TextDecoder().decode(b));if(!p||typeof p!=='object'||Array.isArray(p))bad('请求格式不正确');return p}catch(e){if(e instanceof HttpError)throw e;bad('请求格式不正确')}}

export async function handleApi(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method,DB=env.DB;
 if(!DB)bad('云端数据库尚未连接',503);
 const q=(sql,...args)=>DB.prepare(sql).bind(...args);
 const one=(sql,...args)=>q(sql,...args).first();const rows=async(sql,...args)=>(await q(sql,...args).all()).results;
 let configPromise;const config=()=>configPromise??=(async()=>{const s=await one('SELECT value FROM settings WHERE id=1');return normalizeSettings(s?JSON.parse(s.value):DEFAULT_CONFIG)})();
 const cookies=Object.fromEntries((request.headers.get('Cookie')||'').split(';').filter(s=>s.includes('=')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i).trim(),s.slice(i+1)]}));
 async function session(role){
  const t=cookies[role==='admin'?'wz_admin':'wz_customer'];if(!t)return null;
  const s=await one('SELECT * FROM sessions WHERE token_hash=? AND role=? AND expires>?',await hash(t),role,now());if(!s)return null;
  if(role==='customer'){
   const timeout=(await config()).security.idle_minutes*60000;
   if(!s.last_active||(!s.idle_exempt&&Date.now()-Date.parse(s.last_active)>timeout)){await q('DELETE FROM sessions WHERE token_hash=?',s.token_hash).run();return null}
  }
  if(role==='customer'||s.user_id!=='admin'){
   const c=await one('SELECT disabled,account_type FROM customers WHERE id=?',s.user_id);if(!c||c.disabled||(role==='admin'&&c.account_type!=='developer'))return null;
  }
  if(request.headers.get('X-WZ-Active')==='1'&&Date.now()-Date.parse(s.last_active)>30000)await q('UPDATE sessions SET last_active=? WHERE token_hash=?',now(),s.token_hash).run();
  return s;
 }

 let adminPromise,customerPromise;
 const adminSession=()=>adminPromise??=session('admin');const customerSession=()=>customerPromise??=session('customer');
 async function requireAdmin(){const s=await adminSession();if(!s)bad('请先登录商家后台',401);return s}
 async function requireCustomer(){const s=await customerSession();if(!s)bad('请先登录顾客账号',401);return s}
 async function authorizedOrder(id){
  const o=await one('SELECT * FROM order_details WHERE id=?',id);if(!o)bad('订单不存在或无权访问',404);
  if((await adminSession())&&o.phase==='submitted')return o;
  const s=await customerSession();if(!s||o.user_id!==s.user_id)bad('订单不存在或尚未正式提交给商家',404);return o;
 }
 function serialize(o,admin=false){const d={...o};for(const k of ['idem_hash','payload_hash','user_id','created_by','receipt','arrival_photo'])delete d[k];
  Object.assign(d,orderReference(o,admin));d.is_test=!!o.is_test;d.test_only=!!o.test_only;d.has_receipt=!!o.receipt;d.has_arrival_photo=!!o.arrival_photo;
  for(const k of ['items','pickup_info','session'])d[k]=JSON.parse(o[k]);d.prep=JSON.parse(o.prep||'{}');d.kitchen=prepInfo(o);return d;
 }
 const event=(id,actor,action,note='')=>q('INSERT INTO events(order_id,actor,action,note,created_at) VALUES(?,?,?,?,?)',id,actor,action,note,now());
 const secure=url.protocol==='https:'?'; Secure':'';
 async function newSession(user,role){const t=random(),duration=role==='admin'?43200:2592000;await q('INSERT INTO sessions(token_hash,user_id,role,expires,last_active) VALUES(?,?,?,?,?)',await hash(t),user,role,new Date(Date.now()+duration*1000).toISOString(),now()).run();return `${role==='admin'?'wz_admin':'wz_customer'}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${duration}${secure}`}
 async function rate(kind,identity,limit=8,minutes=15,record=true){
  const since=new Date(Date.now()-minutes*60000).toISOString();const key=await hash(kind+':'+identity);
  const result=await q('INSERT INTO attempts(key,created_at) SELECT ?,? WHERE (SELECT count(*) FROM attempts WHERE key=? AND created_at>?)<?',key,now(),key,since,limit).run();if(!result.meta.changes)bad('尝试过于频繁，请稍后再试',429);return key;
 }
 const ip=request.headers.get('CF-Connecting-IP')||'unknown';
 function guard(o){const id=uuid();return [q('INSERT INTO tx_guards(id,ok) VALUES(?,coalesce((SELECT CASE WHEN version=? THEN 1 ELSE 0 END FROM orders WHERE id=?),0))',id,o.version,o.id),q('DELETE FROM tx_guards WHERE id=?',id)]}
 async function guarded(o,statements){const [first,last]=guard(o);try{return await DB.batch([first,...statements,last])}catch(e){if(/must_match_version|CHECK constraint/.test(String(e)))bad('订单已被其他操作更新，请刷新重试',409);throw e}}
 async function multipart(){const raw=await boundedBody(request,6*1024*1024);try{return await new Response(raw,{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData()}catch{bad('上传格式不正确')}}
 async function storeImage(file,prefix){if(!file||typeof file.arrayBuffer!=='function')bad('请选择图片');if(file.size>5*1024*1024)bad('图片不能超过 5 MB',413);let bytes;try{bytes=validateUploadJpeg(await file.arrayBuffer())}catch(e){bad(e.message)}const key=prefix+'/'+random()+'.jpg';await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});return key}

 const navigation=await navigationGuard({path,method,request,one,q,rows,body,json,hash,random,rate,adminSession,customerSession,ip});if(navigation)return navigation;
 const operation=await operations({request,path,method,url,env,DB,q,one,rows,body,text,integer,bad,json,hash,random,config,requireAdmin,requireCustomer,guard,guarded,event,serialize,passwordHash,passwordMatches,newSession,rate,phone,checkPassword});if(operation)return operation;
 if(method==='GET'&&path==='/api/health')return json({ok:true,version:4,storage:'cloud-d1-r2',date:nyParts().date});
 if(method==='GET'&&path==='/api/menu'){const m=currentMenu(await config(),url.searchParams.get('slot'));return json({...m,cutoff:snapshotCutoff(m)})}
 if(method==='GET'&&path==='/api/customer/me'){
  const s=await requireCustomer(),c=await one('SELECT id,phone,name,wechat,account_type,login_name,profile,profile_version,(SELECT code FROM customer_codes WHERE user_id=customers.id) customer_code FROM customers WHERE id=?',s.user_id);if(!c)bad('账号不存在',401);return json({...c,customer_code:'C'+String(c.customer_code).padStart(6,'0'),profile:JSON.parse(c.profile),idle_minutes:(await config()).security.idle_minutes});
 }
 if(method==='GET'&&path==='/api/customer/challenge'){
  const security=(await config()).security;if(!security.registration_open)bad('暂时停止注册，请联系商家',403);
  await rate('challenge',ip,20,10);
  await DB.batch([q('DELETE FROM challenges WHERE expires<?',Date.now()),q('DELETE FROM attempts WHERE created_at<?',new Date(Date.now()-86400000).toISOString()),q('DELETE FROM sessions WHERE expires<?',now())]);
  const values=crypto.getRandomValues(new Uint8Array(2)),a=values[0]%17+3,b=values[1]%13+2,id=random();
  await q('INSERT INTO challenges(id,ip_hash,answer_hash,created_at,expires) VALUES(?,?,?,?,?)',id,await hash(ip),await hash(String(a+b)),Date.now(),Date.now()+600000).run();
  return json({id,question:a+' + '+b+' = ?',invite_required:security.invite_required,turnstile_site_key:env.TURNSTILE_SITE_KEY||null});
 }
 if(method==='POST'&&path==='/api/customer/register'){
  const p=await body(request),ph=phone(text(p,'phone',32,true)),name=text(p,'name',60,true),wechat=text(p,'wechat',60,true);checkPassword(p.password);
  const security=(await config()).security;if(!security.registration_open)bad('暂时停止注册，请联系商家',403);
  await rate('register',ip,6,60);await rate('register-day',ip,20,1440);
  if(text(p,'website',100))bad('注册校验失败');
  if(env.TURNSTILE_SITE_KEY||env.TURNSTILE_SECRET_KEY){
   if(!env.TURNSTILE_SITE_KEY||!env.TURNSTILE_SECRET_KEY)bad('注册验证尚未配置完成，请联系商家',503);
   const token=text(p,'turnstile_token',2048,true);let result;
   try{const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token,remoteip:ip}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error();result=await r.json()}catch{bad('安全验证服务暂时不可用，请重试',503)}
   if(!result.success||result.hostname!==url.hostname||result.action!=='register')bad('人机验证失败或过期，请重新验证');
  }
  const challenge=await one('SELECT * FROM challenges WHERE id=?',text(p,'challenge_id',100,true));
  if(!challenge||challenge.ip_hash!==await hash(ip)||challenge.expires<Date.now()||Date.now()-challenge.created_at<1500||challenge.answer_hash!==await hash(text(p,'answer',20,true)))bad('验证答案错误或已过期，请刷新验证题');
  const device=text(p,'device',100,true);if(!/^[a-f0-9]{32,100}$/.test(device))bad('请刷新后注册');await rate('register-device',device,3,60);
  if(security.invite_required&&(!security.invite_hash||await hash(text(p,'invite_code',100,true))!==security.invite_hash))bad('邀请码不正确，请联系商家');
  const consumed=await q('DELETE FROM challenges WHERE id=?',challenge.id).run();if(!consumed.meta.changes)bad('此验证题已使用，请刷新',409);
  await rate('register-global',nyParts().date,security.daily_registration_limit,1440);
  const recovery=random().slice(0,36),id=uuid(),pHash=await passwordHash(p.password);
  try{await q('INSERT INTO customers(id,phone,name,wechat,password_hash,recovery_hash,created_at) VALUES(?,?,?,?,?,?,?)',id,ph,name,wechat,pHash,await hash(recovery),now()).run()}catch(e){if(/UNIQUE/.test(String(e)))bad('该手机号已注册，请直接登录或使用恢复码重设密码',409);throw e}
  return json({id,name,phone:ph,wechat,recovery_code:recovery.match(/.{1,6}/g).join('-')},201,{'Set-Cookie':await newSession(id,'customer')});
 }
 if(method==='POST'&&['/api/customer/login','/api/admin/login'].includes(path)){
  const p=await body(request),isAdmin=path.includes('/admin/'),rawIdentity=isAdmin?text(p,'username',60,true):text(p,'phone',60,true),identity=/^[a-z][a-z0-9_.-]{2,39}$/i.test(rawIdentity)?rawIdentity.toLowerCase():phone(rawIdentity);
  const key=await rate('login',ip+':'+identity);await rate('login-ip',ip,30);
  const primaryAdmin=isAdmin&&identity==='admin';
  const c=primaryAdmin?null:await one("SELECT * FROM customers WHERE phone=? OR (login_name=? AND account_type='developer')",identity,identity);
  if(typeof p.password!=='string'||p.password.length>128||!(primaryAdmin?await passwordMatches(p.password,env.ADMIN_PASSWORD_HASH):c&&(!isAdmin||c.account_type==='developer')&&await passwordMatches(p.password,c.password_hash)))bad('账号或密码不正确',401);
  if(c?.disabled)bad('账号已暂停使用，请联系商家',403);
  await q('DELETE FROM attempts WHERE key=?',key).run();return json({ok:true,role:isAdmin?'admin':'customer'},200,{'Set-Cookie':await newSession(primaryAdmin?'admin':c.id,isAdmin?'admin':'customer')});
 }
 if(method==='POST'&&path==='/api/customer/reset'){
  const p=await body(request),ph=phone(text(p,'phone',32,true));checkPassword(p.password);await rate('reset',ip+ph,5);await rate('reset-ip',ip,30);
  const c=await one('SELECT * FROM customers WHERE phone=? AND recovery_hash=?',ph,await hash(text(p,'recovery_code',100,true).replace(/[-\s]/g,'')));
  if(!c)bad('手机号或恢复码不正确',400);const code=random().slice(0,36);
  await DB.batch([q('UPDATE customers SET password_hash=?,recovery_hash=? WHERE id=?',await passwordHash(p.password),await hash(code),c.id),q('DELETE FROM sessions WHERE user_id=?',c.id)]);
  return json({ok:true,recovery_code:code.match(/.{1,6}/g).join('-')});
 }
 if(method==='POST'&&['/api/admin/logout','/api/customer/logout'].includes(path)){
  const key=path.includes('/admin/')?'wz_admin':'wz_customer';if(cookies[key])await q('DELETE FROM sessions WHERE token_hash=?',await hash(cookies[key])).run();return json({ok:true},200,{'Set-Cookie':`${key}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`});
 }
 if(method==='GET'&&path==='/api/customer/orders'){
  const c=await requireCustomer(),before=Number(url.searchParams.get('before')||'9999999999999'),list=await rows('SELECT * FROM order_details WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 101',c.user_id,before);return json({orders:list.slice(0,100).map(o=>serialize(o)),next:list.length>100?list[99].id:null});
 }
 if(method==='POST'&&path==='/api/orders'){
  const p=await body(request),staff=!!(await adminSession())&&p.source==='staff',s=staff?{user_id:'staff'}:await requireCustomer();
  const key=text(p,'idempotency_key',100,true);if(!/^[A-Za-z0-9_-]{32,100}$/.test(key))bad('请刷新后重试');const idem=await hash(s.user_id+':'+key);
  const name=text(p,'name',60,true),ph=phone(text(p,'phone',32,true)),wechat=text(p,'wechat',60,true),note=text(p,'note',500);
  const content={name,phone:ph,wechat,note,pickup:p.pickup,pickup_other:p.pickup_other||'',other_confirmed:!!p.other_confirmed,batch:p.batch||'asap',items:p.items,slot:p.slot,date:p.date,expected_total:p.expected_total,source:staff?'staff':'customer'};
  const payloadHash=await hash(JSON.stringify(content));let existing=await one('SELECT * FROM order_details WHERE idem_hash=?',idem);
  if(existing){if(existing.payload_hash!==payloadHash)bad('这次提交已保存，请打开原订单或重新下单',409);return json(serialize(existing))}
  await requireUploadCapacity(env);const settings=await config(),menu=currentMenu(settings,p.slot);
  if(p.date!==menu.date)bad('用餐日期已更新，请刷新菜单后重新确认',409);
  if(!staff&&!menu.open)bad('该场次已截止或暂停接单');let pickup=settings.pickups.find(x=>x.id===p.pickup&&x.enabled);
  if(p.pickup==='other'&&settings.other_pickup_enabled){if(!p.other_confirmed)bad('其他地点请先联系商家确认');pickup={id:'other',name:'其他地点（已联系商家）',address:text(p,'pickup_other',200,true),hint:'顾客声明已联系商家，接单前请核对配送范围。',time:'与商家单独约定'}}
  if(!pickup)bad('请选择可用配送点');
  const batchId=p.batch||'asap',batch=batchId==='asap'?{id:'asap',name:'ASAP · 尽快安排',time:''}:menu.batches.find(x=>x.id===batchId&&x.open);if(!batch)bad('所选批次已过时或关闭，请重新选择',409);
  if(!Array.isArray(p.items)||!p.items.length||p.items.length>40)bad('请先选择餐品');
  const clean=[],seen=new Map();
  for(const i of p.items){if(!i||typeof i!=='object')bad('菜品格式不正确');const m=menu.menu.find(x=>x.id===i.id),opt=m?.options.find(x=>x.id===i.option);
   if(!m||m.sold_out||!opt)bad('部分菜品或规格已变更，请刷新菜单',409);const qty=integer(i.qty,1,50,'菜品数量'),k=m.id+':'+opt.id;
   if(seen.has(k)){seen.get(k).qty+=qty;if(seen.get(k).qty>50)bad('每个规格最多 50 份')}else{const row={id:m.id,name:m.name,option:opt.id,option_name:opt.name,price:opt.price,qty};seen.set(k,row);clean.push(row)}
  }
  if(clean.reduce((s,i)=>s+i.qty,0)>100)bad('每单最多 100 份');
  const subtotal=clean.reduce((s,i)=>s+i.price*i.qty,0),tax=Math.round(subtotal*settings.tax_bps/10000),fee=settings.fee_cents,total=subtotal+tax+fee;
  if(p.coupon_code)bad('优惠券暂未开放，当前订单按菜单原价计算',409);
  if(p.expected_total!==total)bad('价格或费用已更新，请刷新菜单后重新确认',409);
  if(!staff&&(await one("SELECT count(*) n FROM orders WHERE user_id=? AND phase='draft' AND date=?",s.user_id,menu.date)).n>=10)bad('今天已有 10 笔未提交草稿，请先完成或联系商家',429);
  await rate('new-order',s.user_id,20,10);const time=now(),phase=staff?'submitted':'draft';
  const snapshot={date:menu.date,session_name:menu.session_name,slot_id:menu.slot_id,cutoff:snapshotCutoff(menu),delivery:menu.delivery,batch_id:batch.id,batch_name:batch.name,departure:batch.time};
  await q(`INSERT OR IGNORE INTO orders(public_id,user_id,idem_hash,payload_hash,name,phone,wechat,pickup,pickup_info,note,session,date,slot,items,subtotal,tax,fee,total,phase,source,submitted_at,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,uuid(),s.user_id,idem,payloadHash,name,ph,wechat,pickup.id,JSON.stringify(pickup),note,JSON.stringify(snapshot),menu.date,menu.slot_id,JSON.stringify(clean),subtotal,tax,fee,total,phase,staff?'staff':'customer',staff?time:null,time,time,staff?(await adminSession()).user_id:s.user_id).run();
  const o=await one('SELECT * FROM order_details WHERE idem_hash=?',idem);if(o.payload_hash!==payloadHash)bad('重复请求的内容不同',409);
  await q("INSERT INTO events(order_id,actor,action,note,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM events WHERE order_id=? AND action='创建订单')",o.id,staff?'admin':'customer','创建订单',staff?'商家代客补录':'顾客草稿，尚未提交给商家',time,o.id).run();
  return json(serialize(o),201);
 }
 const match=path.match(/^\/api\/orders\/(\d+)(?:\/(receipt|receipt-meta|contact|submit|arrival-photo|events|confirm-received))?$/);
 if(match){const id=Number(match[1]),resource=match[2],o=await authorizedOrder(id);
  if(method==='GET'&&!resource){const d=serialize(o,!!(await adminSession()));if(await adminSession())d.events=await rows('SELECT actor,action,note,created_at FROM events WHERE order_id=? ORDER BY id DESC',id);return json(d)}
  if(method==='POST'&&resource==='confirm-received'){
   const s=await requireCustomer();if(o.user_id!==s.user_id)bad('订单不存在或无权访问',404);const p=await body(request);
   if(o.fulfillment==='collected')return json({ok:true,already_done:true});if(p.version!==o.version)bad('订单状态已更新，请刷新后重试',409);
   if(!await confirmReceipt(env,o,'customer'))bad('订单状态已更新，请刷新后重试',409);await purgeMedia(env);return json({ok:true});
  }
  if(method==='GET'&&['receipt','arrival-photo'].includes(resource)){
   const key=resource==='receipt'?o.receipt:o.arrival_photo;if(!key)bad('图片尚未上传',404);const obj=await env.BUCKET.get(key);if(!obj)bad('图片暂时无法读取',404);
   return new Response(obj.body,{headers:{'Content-Type':'image/jpeg','Content-Disposition':'inline','Cache-Control':'private, no-store'}});
  }
  if(method==='POST'&&resource==='receipt'){
   if(o.source!=='staff'&&o.user_id!==(await customerSession())?.user_id)bad('请在顾客账号中提交付款凭证',403);
   if(!['unpaid','review','exception'].includes(o.payment)||o.fulfillment==='cancelled')bad('当前状态不能修改付款凭证');
   await rate('receipt-upload',o.user_id,20,10);const form=await multipart(),p=Object.fromEntries(form),channel=text(p,'channel',20,true),payer=text(p,'payer',60),tid=text(p,'transaction_id',100),settings=await config();
   if(!settings.payments.some(x=>x.id===channel&&x.enabled))bad('付款渠道不正确');const imageKey=await storeImage(form.get('receipt'),'receipt');
   try{await guarded(o,[q('UPDATE orders SET receipt=?,channel=?,payer=?,transaction_id=?,payment=?,version=version+1,updated_at=? WHERE id=?',imageKey,channel,payer,tid,o.phase==='submitted'?'review':'unpaid',now(),id),...queueMedia(q,[o.receipt]),event(id,'customer','付款凭证已保存',o.phase==='draft'?'仍为顾客草稿，待正式提交':'重新提交人工核款')])}catch(e){await env.BUCKET.delete(imageKey);throw e}
   await purgeMedia(env);
   return json({ok:true,phase:o.phase});
  }
  if(method==='POST'&&resource==='receipt-meta'){
   const c=await requireCustomer();if(c.user_id!==o.user_id)bad('无权修改',403);if(!o.receipt||!['unpaid','review','exception'].includes(o.payment)||o.fulfillment==='cancelled')bad('当前状态不能修改付款信息');
   const p=await body(request),channel=text(p,'channel',20,true);if(!(await config()).payments.some(x=>x.id===channel&&x.enabled))bad('付款渠道不正确');
   await guarded(o,[q('UPDATE orders SET channel=?,payer=?,transaction_id=?,version=version+1,updated_at=? WHERE id=?',channel,text(p,'payer',60),text(p,'transaction_id',100),now(),o.id),event(o.id,'customer','更新付款说明','原付款截图保留')]);return json({ok:true});
  }
  if(method==='POST'&&resource==='contact'){
   const c=await requireCustomer();if(c.user_id!==o.user_id||o.phase!=='draft')bad('仅本人可补充草稿联系人',403);const p=await body(request),wechat=text(p,'wechat',60,true);
   await guarded(o,[q('UPDATE orders SET wechat=?,version=version+1,updated_at=? WHERE id=?',wechat,now(),o.id),event(o.id,'customer','补充微信号')]);return json({ok:true});
  }
  if(method==='POST'&&resource==='submit'){
   if(!o.wechat)bad('请联系商家补全微信号，或重新创建订单');
   const c=await requireCustomer();if(c.user_id!==o.user_id)bad('无权提交',403);if(o.phase==='submitted')return json({ok:true});if(!o.receipt)bad('请先上传付款凭证，再正式提交给商家');
   const late=now()>JSON.parse(o.session).cutoff;
   await guarded(o,[q("UPDATE orders SET phase='submitted',payment='review',submitted_at=?,version=version+1,updated_at=? WHERE id=?",now(),now(),id),event(id,'customer','正式提交给商家',late?'截止前已创建，截止后补交凭证；请商家确认配送安排':'付款凭证已提交，等待商家核实并接单')]);return json({ok:true});
  }
  if(method==='POST'&&resource==='arrival-photo'){
   await requireAdmin();if(!['dispatched','arrived'].includes(o.fulfillment))bad('请先发车，再上传送达照片');const form=await multipart(),key=await storeImage(form.get('photo'),'arrival');
   try{await guarded(o,[q("UPDATE orders SET arrival_photo=?,fulfillment='arrived',version=version+1,updated_at=?,arrived_at=?,auto_confirm_at=? WHERE id=?",key,now(),o.fulfillment==='arrived'&&o.arrived_at?o.arrived_at:now(),o.fulfillment==='arrived'&&o.auto_confirm_at?o.auto_confirm_at:new Date(Date.now()+900000).toISOString(),id),...queueMedia(q,[o.arrival_photo]),event(id,'admin','已到配送点并上传照片',text(Object.fromEntries(form),'note',500))])}catch(e){await env.BUCKET.delete(key);throw e}await purgeMedia(env);return json({ok:true});
  }
 }
 if(path.startsWith('/api/admin/')){
  await requireAdmin();
  if(method==='GET'&&path==='/api/admin/me')return json({username:(await adminSession()).user_id==='admin'?'admin':'developer',idle_exempt:true,idle_minutes:0,expires_at:(await adminSession()).expires});
  if(path==='/api/admin/coupons'&&method==='GET')return json({enabled:false,rules_configured:false,can_manage:true,can_issue:false,discount_applied:false,message:'优惠规则尚未配置。管理员与开发者拥有同等发放权限；配置并启用前不能发行或抵扣。'});
  if(path==='/api/admin/coupons/issue'&&method==='POST')bad('优惠券规则尚未配置，暂不能发行优惠券',409);
  if(method==='GET'&&path==='/api/admin/cost-guard')return json(await costStatus(env));
  if(method==='GET'&&path==='/api/admin/settings'){const s=await config();return json({...s,date:nyParts().date})}
  if(method==='POST'&&path==='/api/admin/settings'){
   const p=await body(request),old=await config();if(p.revision!==old.revision)bad('设置已被另一设备修改，请重新载入后编辑',409);
   let next;try{next=validateSettings(p,old)}catch(e){bad(e.message)}
   if(p.security?.new_invite_code){const code=text(p.security,'new_invite_code',100,true);if(code.length<6)bad('邀请码至少 6 个字符');next.security.invite_hash=await hash(code)}
   if(next.security.invite_required&&!next.security.invite_hash)bad('请先设置邀请码');
   const result=await q("INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE coalesce(json_extract(settings.value,'$.revision'),0)=?",JSON.stringify(next),old.revision).run();if(!result.meta.changes)bad('设置已被另一设备修改，请重新载入',409);return json({ok:true});
  }
  if(method==='POST'&&path==='/api/admin/duty'){
   // Compatibility for already-open older pages: merchant idle expiry is always off.
   await body(request);const s=await adminSession();await q('UPDATE sessions SET idle_exempt=1,last_active=? WHERE token_hash=?',now(),s.token_hash).run();return json({idle_exempt:true});
  }
  if(method==='GET'&&path==='/api/admin/customers'){
   const before=Number(url.searchParams.get('before')||'9999999999999'),list=await rows('SELECT rowid cursor,id,name,phone,wechat,disabled,account_type,login_name,created_at FROM customers WHERE rowid<? ORDER BY rowid DESC LIMIT 101',before);
   return json({customers:list.slice(0,100),next:list.length>100?list[99].cursor:null});
  }
  if(method==='POST'&&path==='/api/admin/developer-account'){
   const p=await body(request),login=text(p,'login_name',40,true).toLowerCase();if(!/^[a-z][a-z0-9_.-]{2,39}$/.test(login)||login==='admin')bad('开发者登录名格式不正确');checkPassword(p.password);
   const ph=phone(text(p,'phone',32,true)),name=text(p,'name',60,true),wechat=text(p,'wechat',60,true),id=uuid(),recovery=random().slice(0,36);
   try{await q("INSERT INTO customers(id,phone,name,wechat,password_hash,recovery_hash,created_at,account_type,login_name) VALUES(?,?,?,?,?,?,?,'developer',?)",id,ph,name,wechat,await passwordHash(p.password),await hash(recovery),now(),login).run()}catch(e){if(/UNIQUE/.test(String(e)))bad('该登录名或手机号已存在，未修改任何密码',409);throw e}
   return json({id,login_name:login,account_type:'developer',recovery_code:recovery.match(/.{1,6}/g).join('-')});
  }
  if(method==='POST'&&path==='/api/admin/customer-type'){
   const p=await body(request),id=text(p,'id',100,true);if(!['customer','super_customer','developer'].includes(p.account_type))bad('账号类型无效');
   const changed=await q('UPDATE customers SET account_type=? WHERE id=? AND account_type=?',p.account_type,id,p.expected_type).run();if(!changed.meta.changes)bad('账号已更新，请刷新后重试',409);
   return json({ok:true});
  }
  const kind=path.match(/^\/api\/admin\/orders\/(\d+)\/kind$/);
  if(method==='POST'&&kind){
   const p=await body(request),o=await one("SELECT * FROM order_details WHERE id=? AND phase='submitted'",Number(kind[1]));if(!o)bad('订单不存在',404);
   if(typeof p.is_test!=='boolean')bad('订单类型无效');if(o.test_only&&!p.is_test)bad('开发者创建的订单只能作为测试订单，不可计入真实营业');if(o.version!==p.version)bad('订单已更新，请刷新后重试',409);
   const reason=text(p,'note',500,true);await guarded(o,[q('UPDATE orders SET is_test=?,version=version+1,updated_at=? WHERE id=?',p.is_test?1:0,now(),o.id),event(o.id,'admin',p.is_test?'标记为测试订单':'恢复为真实订单',reason)]);return json({ok:true});
  }
  if(method==='POST'&&path==='/api/admin/customer-status'){
   const p=await body(request),id=text(p,'id',100,true);await DB.batch([q('UPDATE customers SET disabled=? WHERE id=?',p.disabled?1:0,id),q('DELETE FROM sessions WHERE user_id=?',id)]);return json({ok:true});
  }
  if(method==='GET'&&path==='/api/admin/updates'){
   const after=Number(url.searchParams.get('after')||0);const result=await one("SELECT count(*) n,coalesce(max(e.id),?) cursor FROM events e JOIN orders o ON e.order_id=o.id WHERE o.phase='submitted' AND o.is_test=0 AND e.id>? AND (e.action='正式提交给商家' OR (e.action='创建订单' AND o.source='staff'))",after,after);
   return json({new_count:result.n,cursor:result.cursor,server_time:now()});
  }
  if(method==='GET'&&path==='/api/admin/orders'){
   const date=url.searchParams.get('date'),before=Number(url.searchParams.get('before')||'9999999999999'),args=[before],kind=orderScope(url);let where="phase='submitted' AND id<? AND "+kind.sql;if(date){where+=' AND date=?';args.push(date)}
   const list=await rows('SELECT * FROM order_details WHERE '+where+' ORDER BY id DESC LIMIT 501',...args);
   const outstanding=await one("SELECT count(*) n FROM orders WHERE phase='submitted' AND is_test=? AND date<>? AND (payment IN ('review','exception','refund_pending') OR (payment='verified' AND fulfillment NOT IN ('collected','cancelled')))",kind.isTest,date||'');
   return json({scope:kind.scope,orders:list.slice(0,500).map(o=>serialize(o,true)),next:list.length>500?list[499].id:null,outstanding_other:outstanding.n,server_time:now()});
  }
  function planAction(o,p){
   if(o.phase!=='submitted')bad('订单尚未正式提交',404);if(p.version!==o.version)bad('订单已更新，请刷新重试',409);
   let payment=o.payment,fulfillment=o.fulfillment,label='',extra={};const action=p.action,note=text(p,'note',500);
   if(action==='verify'){
    if(!['review','exception'].includes(payment)||fulfillment==='cancelled')bad('当前状态不能核实到账');const amount=integer(p.received_amount,1,100000000,'实际到账金额');if(!['USD','CNY'].includes(p.received_currency))bad('币种不正确');
    const basis=text(p,'exchange_basis',200);if((p.received_currency!=='USD'||amount!==o.total)&&!basis)bad('非美元或金额不符时，请填写换算依据／差额说明');
    extra={received_amount:amount,received_currency:p.received_currency,exchange_basis:basis,verified_by:'admin',verified_at:now()};payment='verified';label='确认到账';
   }else if(action==='exception'){
    if(!['unpaid','review','exception'].includes(payment)||!note)bad('请填写异常原因，并核对当前付款状态');payment='exception';label='标记付款异常';
   }else if(action==='cancel'){
    if(['cancelled','collected'].includes(fulfillment)||!note)bad('请填写取消原因，并核对当前订单状态');fulfillment='cancelled';if(payment==='verified')payment='refund_pending';label='取消订单';
   }else if(action==='refund_pending'){
    if(fulfillment!=='cancelled'||!['review','exception'].includes(payment)||!note)bad('请核对已取消订单的实际到账情况，并记录退款原因');payment='refund_pending';label='转退款待处理';
   }else if(action==='refunded'){
    if(payment!=='refund_pending'||!note)bad('请填写退款渠道、金额和参考信息');payment='refunded';label='确认退款完成';
   }else if(action==='rollback'){
    if(!['dispatched','arrived'].includes(fulfillment)||!note)bad('仅已发车或已到配送点可退回，请填写纠正原因');
    const old=fulfillment;fulfillment=old==='arrived'?'dispatched':'preparing';if(old==='arrived')Object.assign(extra,{arrival_photo:null,arrived_at:null,auto_confirm_at:null});label='纠正配送状态：'+FUL[old]+' → '+FUL[fulfillment];
   }else if(['preparing','dispatched','arrived','collected'].includes(action)){
    const before={preparing:'pending',dispatched:'preparing',arrived:'dispatched',collected:'arrived'}[action];
    if(payment!=='verified'||fulfillment!==before)bad('请先核实到账，并按接单、发车、到达、领取顺序处理');if(action==='dispatched'&&!prepInfo(o).ready)bad('备餐尚未全部完成，请先在备餐清单确认完成数量');fulfillment=action;label=FUL[action];
   }else bad('不支持此操作');
   if(fulfillment==='arrived'&&o.fulfillment!=='arrived')Object.assign(extra,{arrived_at:now(),auto_confirm_at:new Date(Date.now()+15*60000).toISOString()});
   if(fulfillment==='collected'&&o.fulfillment!=='collected')Object.assign(extra,{confirmed_at:now(),confirmed_by:'admin'});
   const garbage=[];if(closed({payment,fulfillment})){extra={...extra,receipt:null,arrival_photo:null,media_removed_at:now(),closed_at:o.closed_at||now()};garbage.push(o.receipt,o.arrival_photo)}else if(extra.arrival_photo===null)garbage.push(o.arrival_photo);
   extra={...extra,payment,fulfillment,updated_at:now()};const keys=Object.keys(extra);
   return [q('UPDATE orders SET '+keys.map(k=>k+'=?').join(',')+',version=version+1 WHERE id=?',...Object.values(extra),o.id),...queueMedia(q,garbage),event(o.id,'admin',label,note),...(closed({payment,fulfillment})?[event(o.id,'system','完成后清理图片','订单文字保留，付款及送达图片移出云端；共享照片在最后一笔关联订单结束后删除')]:[])];
  }
  const act=path.match(/^\/api\/admin\/orders\/(\d+)\/action$/);
  if(method==='POST'&&act){const o=await one('SELECT * FROM order_details WHERE id=?',Number(act[1]));if(!o)bad('订单不存在',404);const p=await body(request);await guarded(o,planAction(o,p));return json({ok:true,media:await purgeMedia(env)})}
  if(method==='POST'&&path==='/api/admin/batch'){
   const p=await body(request);if(!['dispatched','arrived'].includes(p.action)||!Array.isArray(p.orders)||!p.orders.length||p.orders.length>100||new Set(p.orders.map(x=>x.id)).size!==p.orders.length)bad('请选择有效订单及操作');
   const before=p.action==='dispatched'?'preparing':'dispatched';const list=[];
   for(const item of p.orders){const o=await one('SELECT * FROM order_details WHERE id=?',item.id);if(!o||o.phase!=='submitted'||o.payment!=='verified'||o.fulfillment!==before||o.version!==item.version)bad('部分订单已更新或状态不符，请刷新后重试',409);list.push(o)}
   if(new Set(list.map(x=>x.pickup+':'+x.pickup_info+':'+x.date+':'+x.slot+':'+(JSON.parse(x.session).batch_id||'asap'))).size!==1)bad('批量操作必须属于同一天、同场次、同批次、同一配送点');
   let imageKey=null;if(p.photo_order_id){const source=list.find(x=>x.id===p.photo_order_id);imageKey=source?.arrival_photo||null}
   const guards=list.map(guard),statements=guards.map(g=>g[0]);
   for(const o of list){statements.push(...planAction(o,{action:p.action,version:o.version,note:'配送点批量更新'}));if(imageKey)statements.push(q('UPDATE orders SET arrival_photo=? WHERE id=?',imageKey,o.id))}statements.push(...guards.map(g=>g[1]));
   try{await DB.batch(statements)}catch(e){if(/must_match_version|CHECK constraint/.test(String(e)))bad('部分订单已更新，请刷新重试',409);throw e}return json({ok:true,count:list.length});
  }
  if(method==='POST'&&path==='/api/admin/arrival'){
   const form=await multipart();let selected;try{selected=JSON.parse(form.get('orders'))}catch{bad('请选择配送订单')}
   if(!Array.isArray(selected)||!selected.length||selected.length>100||new Set(selected.map(x=>x.id)).size!==selected.length)bad('请选择有效订单');
   const list=[];for(const item of selected){const o=await one("SELECT * FROM order_details WHERE id=? AND phase='submitted'",item.id);if(!o||o.payment!=='verified'||!['dispatched','arrived'].includes(o.fulfillment)||o.version!==item.version)bad('部分订单状态已变更，请刷新后重试',409);list.push(o)}
   if(new Set(list.map(x=>x.pickup+':'+x.pickup_info+':'+x.date+':'+x.slot+':'+(JSON.parse(x.session).batch_id||'asap'))).size!==1)bad('请选择同一天、同场次、同批次、同一配送点的订单');const key=await storeImage(form.get('photo'),'arrival');const pairs=list.map(guard),statements=pairs.map(g=>g[0]);
   for(const o of list)statements.push(q("UPDATE orders SET arrival_photo=?,fulfillment='arrived',version=version+1,updated_at=?,arrived_at=?,auto_confirm_at=? WHERE id=?",key,now(),o.fulfillment==='arrived'&&o.arrived_at?o.arrived_at:now(),o.fulfillment==='arrived'&&o.auto_confirm_at?o.auto_confirm_at:new Date(Date.now()+900000).toISOString(),o.id),...queueMedia(q,[o.arrival_photo]),event(o.id,'admin','已到配送点并上传照片',text(Object.fromEntries(form),'note',500)));statements.push(...pairs.map(g=>g[1]));
   try{await DB.batch(statements)}catch(e){await env.BUCKET.delete(key);if(/must_match_version|CHECK constraint/.test(String(e)))bad('订单已更新，请刷新重试',409);throw e}await purgeMedia(env);return json({ok:true,count:list.length});
  }
  if(method==='GET'&&path==='/api/admin/export'){
   const kind=orderScope(url);let all=await rows("SELECT * FROM order_details WHERE phase='submitted' AND "+kind.sql+" ORDER BY pickup,id");const date=url.searchParams.get('date'),slot=url.searchParams.get('slot');if(date)all=all.filter(o=>o.date===date);if(slot)all=all.filter(o=>o.slot===slot);const stamp=now();
   const sheets={'订单总表':[['订单号','姓名','电话','微信号','用餐日期','场次','配送点','应付 USD','税 USD','配送费 USD','渠道','实际付款人','交易编号','付款状态','履约状态','付款凭证','送达照片','实际到账金额','实际币种','换算或差额说明','核实人','核实时间','来源','备注','提交时间','导出时间','订单类型']],
    '菜品明细表':[['订单号','日期','场次','菜品编号','菜名','规格','数量','单价 USD','小计 USD','付款状态','履约状态','导出时间','订单类型']],
    '配送点交接单':[['配送点','具体位置','日期','场次','订单号','姓名','电话','菜品与规格','份数','状态','备注','导出时间','订单类型']]};
   for(const row of all){const o=serialize(row,true),number=o.number;
    sheets['订单总表'].push([number,o.name,o.phone,o.wechat,o.date,o.session.session_name+' / '+(o.session.batch_name||'ASAP')+(o.session.departure?' '+o.session.departure:''),o.pickup_info.name,o.total/100,o.tax/100,o.fee/100,o.channel,o.payer,o.transaction_id,PAY[o.payment],FUL[o.fulfillment],o.has_receipt?'已上传':'未上传',o.has_arrival_photo?'已上传':'未上传',o.received_amount==null?'':o.received_amount/100,o.received_currency,o.exchange_basis,o.verified_by,o.verified_at,o.source==='staff'?'商家补录':'顾客',o.note,o.submitted_at,stamp,o.is_test?'测试订单（不计营业）':'真实订单']);
    for(const i of o.items)sheets['菜品明细表'].push([number,o.date,o.session.session_name+' / '+(o.session.batch_name||'ASAP')+(o.session.departure?' '+o.session.departure:''),i.id,i.name,i.option_name,i.qty,i.price/100,i.qty*i.price/100,PAY[o.payment],FUL[o.fulfillment],stamp,o.is_test?'测试订单（不计营业）':'真实订单']);
    if([...ACTIVE,'collected'].includes(o.fulfillment))sheets['配送点交接单'].push([o.pickup_info.name,o.pickup_info.address,o.date,o.session.session_name+' / '+(o.session.batch_name||'ASAP')+(o.session.departure?' '+o.session.departure:''),number,o.name,o.phone,o.items.map(i=>`${i.name}/${i.option_name} × ${i.qty}`).join('；'),o.items.reduce((s,i)=>s+i.qty,0),FUL[o.fulfillment],o.note,stamp,o.is_test?'测试订单（不计营业）':'真实订单']);
   }
   return new Response(xlsx(sheets),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+(kind.isTest?'weizhuo-test-orders':'weizhuo-orders')+'.xlsx"'}});
  }
  if(method==='POST'&&path==='/api/admin/backup'){
   const date=url.searchParams.get('date'),snapshot=await DB.batch([q("SELECT * FROM order_details WHERE phase='submitted'"+(date?' AND date=?':''),...(date?[date]:[])),q('SELECT * FROM events'),q('SELECT * FROM customers'),q('SELECT value FROM settings WHERE id=1')]);
   const orders=snapshot[0].results,ids=new Set(orders.map(x=>x.id)),users=new Set(orders.map(x=>x.user_id)),ev=snapshot[1].results.filter(x=>ids.has(x.order_id));
   const keys=[...new Set(orders.flatMap(o=>[o.receipt,o.arrival_photo]).filter(Boolean))],files={};let size=0;
   for(const key of keys){const obj=await env.BUCKET.get(key);if(!obj)bad('有图片暂时无法读取，备份未完成，请稍后重试',503);size+=obj.size;if(size>25*1024*1024)bad('该批图片超过 25 MB，请按用餐日期分别备份');files['images/'+key]=new Uint8Array(await obj.arrayBuffer())}
   files['orders.json']=strToU8(JSON.stringify({exported_at:now(),orders,events:ev},null,2));files['customers.json']=strToU8(JSON.stringify(snapshot[2].results.filter(x=>users.has(x.id)),null,2));files['settings.json']=strToU8(snapshot[3].results[0]?.value||JSON.stringify(DEFAULT_CONFIG));
   return new Response(zipSync(files,{level:0}),{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="weizhuo-private-backup.zip"'}});
  }
 }
 bad('接口不存在',404);
}

export async function apiResponse(request,env){
 try{
  env=guardedStorage(env);
  if(!['GET','HEAD'].includes(request.method)){
   const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)bad('来源校验失败',403);
   if(request.headers.get('X-Requested-With')!=='Weizhuo')bad('请求校验失败',403);
  }
  // Cron is authoritative on Cloudflare. Reads also reconcile overdue states
  // for retained hosts without cron support, without trusting browser clocks.
  if(request.method==='GET'&&request.headers.has('Cookie')&&/^\/api\/(orders\/\d+$|customer\/orders|admin\/orders)/.test(new URL(request.url).pathname)){const settled=await settleDueOrders(env);if(settled.confirmed)await purgeMedia(env);}
  return await handleApi(request,env);
 }catch(e){if(e instanceof HttpError||e.name==='OrderKindError'||[409,503].includes(e.status))return json({error:e.message},e.status);if(/display_number_limit/.test(String(e)))return json({error:'今日订单编号已用尽，请联系商家'},429);console.error('Request failed:',e?.message);return json({error:'服务暂时无法处理，请稍后重试；已保存的订单会保留。'},503)}
}
