import {orderReference} from './references.js';
import {currentMenu,nyParts} from './config.js';
import {zipSync,strToU8} from 'fflate';

export function prepInfo(o){
 const items=typeof o.items==='string'?JSON.parse(o.items):o.items,stored=typeof o.prep==='string'?JSON.parse(o.prep):o.prep||{};
 const released=['dispatched','arrived','collected'].includes(o.fulfillment);
 const lines=items.map((i,index)=>({...i,index,done:released?i.qty:Math.min(i.qty,Math.max(0,Number(stored[index])||0))}));
 const total=lines.reduce((s,i)=>s+i.qty,0),done=lines.reduce((s,i)=>s+i.done,0);return {lines,total,done,remaining:total-done,ready:total>0&&done===total};
}
export const closed=o=>(o.fulfillment==='collected'&&o.payment==='verified')||(o.fulfillment==='cancelled'&&['unpaid','refunded'].includes(o.payment));
const stamp=()=>new Date().toISOString();
export function queueMedia(q,keys){return [...new Set(keys.filter(Boolean))].map(key=>q('INSERT OR IGNORE INTO media_garbage(key,created_at) VALUES(?,?)',key,stamp()))}
export async function purgeMedia(env){
 const db=env.DB,items=(await db.prepare('SELECT key FROM media_garbage WHERE NOT EXISTS (SELECT 1 FROM orders WHERE receipt=media_garbage.key OR arrival_photo=media_garbage.key) ORDER BY created_at LIMIT ?').bind(env.COST_GUARD_ENABLED==='1'?5:50).all()).results;let deleted=0;
 for(const {key} of items){
  const reference=await db.prepare('SELECT 1 FROM orders WHERE receipt=? OR arrival_photo=? LIMIT 1').bind(key,key).first();if(reference)continue;
  try{await env.BUCKET.delete(key);await db.prepare('DELETE FROM media_garbage WHERE key=?').bind(key).run();deleted++}
  catch{await db.prepare("UPDATE media_garbage SET attempts=attempts+1,last_error='图片存储暂时不可用，请重试' WHERE key=?").bind(key).run()}
 }
 return {deleted,pending:(await db.prepare('SELECT count(*) n FROM media_garbage').first()).n};
}

export async function operations(c){
 const {path,method,url,env,DB,q,one,rows,body,text,integer,bad,json,hash,random,config,requireAdmin,requireCustomer,guard,guarded,event,serialize,passwordHash,passwordMatches,newSession,rate}=c;
 const route=(m,p)=>method===m&&path===p;
 if(route('POST','/api/customer/profile')){
  const s=await requireCustomer(),p=await body(c.request),name=text(p,'name',60,true),wechat=text(p,'wechat',60,true),settings=await config();
  const pickup=text(p,'pickup',64),contact=c.phone(text(p,'contact_phone',32,true)),note=text(p,'note',300),other=text(p,'pickup_other',200);
  if(pickup&&!settings.pickups.some(x=>x.id===pickup&&x.enabled)&&!(pickup==='other'&&settings.other_pickup_enabled))bad('默认配送点已停用，请重新选择');
  if(pickup==='other'&&!other)bad('请填写默认地点，实际配送仍需与老板确认');
  const profile={pickup,pickup_other:pickup==='other'?other:'',contact_phone:contact,note};
  const result=await q('UPDATE customers SET name=?,wechat=?,profile=?,profile_version=profile_version+1 WHERE id=? AND profile_version=?',name,wechat,JSON.stringify(profile),s.user_id,p.version).run();
  if(!result.meta.changes)bad('个人资料已在其他设备修改，请重新打开后编辑',409);return json({ok:true});
 }
 if(route('POST','/api/customer/password')){
  const s=await requireCustomer(),p=await body(c.request);await rate('change-password',s.user_id,5,15);c.checkPassword(p.password);
  const user=await one('SELECT password_hash FROM customers WHERE id=?',s.user_id);
  if(!await passwordMatches(text(p,'current_password',128,true),user.password_hash))bad('当前密码不正确');
  await DB.batch([q('UPDATE customers SET password_hash=? WHERE id=?',await passwordHash(p.password),s.user_id),q('DELETE FROM sessions WHERE user_id=?',s.user_id)]);
  return json({ok:true},200,{'Set-Cookie':await newSession(s.user_id,'customer')});
 }
 if(route('GET','/api/customer/history')){
  const s=await requireCustomer(),before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),list=await rows('SELECT h.id,h.date,h.slot,h.items,h.pickup,h.pickup_name,h.archived_at,h.is_test,r.customer_code,r.customer_sequence,r.day_sequence,r.order_created_at FROM order_history h LEFT JOIN order_references r ON r.order_id=h.id WHERE h.user_id=? AND h.id<? ORDER BY h.id DESC LIMIT 101',s.user_id,before);
  return json({history:list.slice(0,100).map(o=>({...o,items:JSON.parse(o.items),...orderReference(o)})),next:list.length>100?list[99].id:null});
 }
 if(route('POST','/api/customer/reorder')){
  const s=await requireCustomer(),p=await body(c.request),id=integer(p.id,1,Number.MAX_SAFE_INTEGER,'订单编号');
  const o=await one('SELECT items FROM orders WHERE id=? AND user_id=?',id,s.user_id)||await one('SELECT items FROM order_history WHERE id=? AND user_id=?',id,s.user_id);if(!o)bad('订单不存在或无权访问',404);
  const menu=currentMenu(await config(),p.slot),cart=[],warnings=[];
  for(const i of JSON.parse(o.items)){const m=menu.menu.find(x=>x.id===i.id),opt=m?.options.find(x=>x.id===i.option);if(!m||m.sold_out||!opt){warnings.push(i.name+' / '+i.option_name+'：本场次不可售，未加入');continue}cart.push({id:i.id,option:i.option,qty:Math.min(i.qty,50)});if(opt.price!==i.price)warnings.push(i.name+'：已按今日价格更新')}
  return json({menu,cart,warnings,notice:'已加入可编辑餐袋。请重新确认配送批次、价格和付款，不会自动提交订单。'});
 }
 if(!path.startsWith('/api/admin/'))return;
 if(!path.match(/^\/api\/admin\/(retention|media|orders\/\d+\/prep)/))return;
 const admin=await requireAdmin();
 const prep=path.match(/^\/api\/admin\/orders\/(\d+)\/prep$/);
 if(method==='POST'&&prep){
  const o=await one('SELECT * FROM order_details WHERE id=? AND phase=\'submitted\'',Number(prep[1]));if(!o)bad('订单不存在',404);
  const p=await body(c.request);if(o.version!==p.version)bad('备餐进度已更新，请刷新后重试',409);if(o.payment!=='verified'||o.fulfillment!=='preparing')bad('仅已核款接单、仍在备餐的订单可确认制作');
  const info=prepInfo(o),stored=JSON.parse(o.prep),lines=p.all===true?info.lines:[info.lines[integer(p.index,0,info.lines.length-1,'菜品')]];
  for(const i of lines)stored[i.index]=p.all===true?i.qty:integer(p.completed,0,i.qty,'已完成数量');
  await guarded(o,[q('UPDATE orders SET prep=?,version=version+1,updated_at=? WHERE id=?',JSON.stringify(stored),stamp(),o.id),event(o.id,'admin','更新备餐进度',lines.map(i=>i.name+'/'+i.option_name+'：完成 '+stored[i.index]+'/'+i.qty).join('；'))]);
  return json({ok:true});
 }
 const cutoff=new Date(Date.now()-7*86400000).toISOString();
 const terminal="phase='submitted' AND ((fulfillment='collected' AND payment='verified') OR (fulfillment='cancelled' AND payment IN ('unpaid','refunded')))";
 const eligible=terminal+" AND coalesce(closed_at,updated_at)<?";
 if(route('GET','/api/admin/retention')){
  const list=await rows('SELECT * FROM order_details WHERE '+eligible+' ORDER BY id LIMIT 50',cutoff),count=await one('SELECT count(*) n FROM orders WHERE '+eligible,cutoff);
  return json({cutoff,days:7,count:count.n,orders:list.map(o=>({id:o.id,number:orderReference(o,true).number,date:o.date,total:o.total,fulfillment:o.fulfillment,closed_at:o.closed_at||o.updated_at})),pending_files:(await one('SELECT count(*) n FROM media_garbage')).n,completed_with_images:(await one('SELECT count(*) n FROM orders WHERE '+terminal+' AND (receipt IS NOT NULL OR arrival_photo IS NOT NULL)')).n});
 }
 if(route('POST','/api/admin/media/cleanup')){
  // Legacy completed orders are handled only through the explicit merchant button.
  const list=await rows('SELECT * FROM order_details WHERE '+terminal+' AND (receipt IS NOT NULL OR arrival_photo IS NOT NULL) LIMIT 50');
  for(const o of list)await guarded(o,[...queueMedia(q,[o.receipt,o.arrival_photo]),q('UPDATE orders SET receipt=NULL,arrival_photo=NULL,media_removed_at=?,version=version+1 WHERE id=?',stamp(),o.id),event(o.id,'admin','清理已完成订单图片','付款及送达图片从云端移除，订单文字记录保留')]);
  return json({ok:true,orders:list.length,...await purgeMedia(env)});
 }
 if(route('POST','/api/admin/retention/prepare')){
  const p=await body(c.request);if(!Array.isArray(p.ids)||!p.ids.length||p.ids.length>50||new Set(p.ids).size!==p.ids.length||p.ids.some(id=>!Number.isSafeInteger(id)))bad('每次请选择 1–50 笔旧订单');
  const marks=p.ids.map(()=>'?').join(','),snapshot=await DB.batch([q('SELECT * FROM order_details WHERE '+eligible+' AND id IN ('+marks+')',cutoff,...p.ids),q('SELECT * FROM events WHERE order_id IN ('+marks+') ORDER BY id',...p.ids)]),list=snapshot[0].results;
  if(list.length!==p.ids.length)bad('部分订单未完成、存在退款待办、未满七天或已经清理，请刷新',409);
  const files={},keys=[...new Set(list.flatMap(o=>[o.receipt,o.arrival_photo]).filter(Boolean))];let size=0;
  for(const key of keys){const obj=await env.BUCKET.get(key);if(!obj)bad('图片备份不完整，请重试或先清理已完成订单图片',503);size+=obj.size;if(size>25*1024*1024)bad('图片超过 25 MB，请减少本批订单数量');files['images/'+key]=new Uint8Array(await obj.arrayBuffer())}
  const exported=stamp();files['orders.json']=strToU8(JSON.stringify({exported_at:exported,orders:list,events:snapshot[1].results},null,2));files['README.txt']=strToU8('这是清理前的完整订单备份。包含个人及付款信息，请妥善保管。已提前删除的图片无法包含在内。网站仅保留顾客的菜品、日期和配送点简要历史。恢复需管理员按技术文档处理，并非上传ZIP即可恢复。');
  const bytes=zipSync(files,{level:0}),digest=await hash(bytes),token=random(),hashToken=await hash(token),versions=list.map(o=>({id:o.id,version:o.version}));
  await DB.batch([q('DELETE FROM cleanup_plans WHERE expires<?',stamp()),q('INSERT INTO cleanup_plans(token_hash,session_hash,orders,archive_hash,created_at,expires) VALUES(?,?,?,?,?,?)',hashToken,admin.token_hash,JSON.stringify(versions),digest,exported,new Date(Date.now()+30*60000).toISOString())]);
  return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="orders-before-cleanup.zip"','X-Cleanup-Token':token,'X-Archive-SHA256':digest}});
 }
 if(route('POST','/api/admin/retention/confirm')){
  const p=await body(c.request),tokenHash=await hash(text(p,'token',100,true)),plan=await one('SELECT * FROM cleanup_plans WHERE token_hash=? AND session_hash=? AND expires>?',tokenHash,admin.token_hash,stamp());
  if(!plan)bad('请先下载本批备份；确认窗口有效期为 30 分钟，同一次商家登录内有效');
  const versions=JSON.parse(plan.orders);if(p.confirmation!=='删除 '+versions.length+' 笔旧订单'||p.download_confirmed!==true||p.archive_hash!==plan.archive_hash)bad('请确认备份已保存，并输入完整确认文字');if(plan.completed_at)return json({ok:true,count:versions.length,already_done:true});
  const list=[];for(const v of versions){const o=await one('SELECT * FROM order_details WHERE id=? AND '+eligible,v.id,cutoff);if(!o||o.version!==v.version)bad('备份后有订单发生变更，尚未删除任何订单，请重新下载备份',409);list.push(o)}
  const pairs=list.map(guard),statements=pairs.map(x=>x[0]),planGuard=random();
  statements.push(q('INSERT INTO tx_guards(id,ok) VALUES(?,coalesce((SELECT CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END FROM cleanup_plans WHERE token_hash=?),0))',planGuard,tokenHash));
  for(const o of list){const pickup=JSON.parse(o.pickup_info),items=JSON.parse(o.items).map(({id,name,option,option_name,price,qty})=>({id,name,option,option_name,price,qty}));
   if(o.user_id!=='staff')statements.push(q('INSERT OR IGNORE INTO order_history(id,user_id,date,slot,items,pickup,pickup_name,archived_at,is_test) VALUES(?,?,?,?,?,?,?,?,?)',o.id,o.user_id,o.date,o.slot,JSON.stringify(items),o.pickup,pickup.name,stamp(),o.is_test));
   statements.push(...queueMedia(q,[o.receipt,o.arrival_photo]),q('DELETE FROM events WHERE order_id=?',o.id),q('DELETE FROM orders WHERE id=?',o.id));
  }
  statements.push(q('UPDATE cleanup_plans SET completed_at=? WHERE token_hash=?',stamp(),tokenHash),q('DELETE FROM tx_guards WHERE id=?',planGuard),...pairs.map(x=>x[1]));
  try{await DB.batch(statements)}catch(e){if(/must_match_version|CHECK constraint/.test(String(e)))bad('订单已更新或本批已处理，请刷新确认',409);throw e}
  return json({ok:true,count:list.length,...await purgeMedia(env)});
 }
}
