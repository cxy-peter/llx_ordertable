import {queueMedia} from './operations.js';

export async function confirmReceipt(env,o,actor='customer',at=new Date().toISOString()){
 if(o.fulfillment==='collected')return false;
 if(o.phase!=='submitted'||o.fulfillment!=='arrived'||o.payment!=='verified')throw Object.assign(new Error('请等待商家核款并标记送达后再确认收餐'),{status:409});
 const q=(sql,...args)=>env.DB.prepare(sql).bind(...args),guard=crypto.randomUUID();
 try{await env.DB.batch([
  q('INSERT INTO tx_guards(id,ok) VALUES(?,coalesce((SELECT CASE WHEN version=? AND fulfillment=\'arrived\' THEN 1 ELSE 0 END FROM orders WHERE id=?),0))',guard,o.version,o.id),
  q("UPDATE orders SET fulfillment='collected',confirmed_by=?,confirmed_at=?,closed_at=?,updated_at=?,receipt=NULL,arrival_photo=NULL,media_removed_at=?,version=version+1 WHERE id=?",actor,at,at,at,at,o.id),
  ...queueMedia(q,[o.receipt,o.arrival_photo]),
  q('INSERT INTO events(order_id,actor,action,note,created_at) VALUES(?,?,?,?,?)',o.id,actor,actor==='system'?'送达15分钟无操作，自动确认收餐':'顾客确认已收到餐品','自动确认是流程状态，不代表系统检测到实际领取；完成后清理付款与送达图片。',at),
  q('DELETE FROM tx_guards WHERE id=?',guard)
 ])}catch(e){if(/must_match_version|CHECK constraint/.test(String(e)))return false;throw e}
 return true;
}

export async function settleDueOrders(env,at=new Date().toISOString()){
 const where="phase='submitted' AND fulfillment='arrived' AND payment='verified' AND auto_confirm_at<=?",q=(s,...a)=>env.DB.prepare(s).bind(...a);
 if(!await q('SELECT 1 FROM orders WHERE '+where+' LIMIT 1',at).first())return {confirmed:0};
 // D1 batch is transactional: a concurrent manual confirmation/rollback either
 // happens before this snapshot or after it, never between its statements.
 const result=await env.DB.batch([
  q('INSERT OR IGNORE INTO media_garbage(key,created_at) SELECT receipt,? FROM orders WHERE '+where+' AND receipt IS NOT NULL',at,at),
  q('INSERT OR IGNORE INTO media_garbage(key,created_at) SELECT arrival_photo,? FROM orders WHERE '+where+' AND arrival_photo IS NOT NULL',at,at),
  q("INSERT INTO events(order_id,actor,action,note,created_at) SELECT id,'system','送达15分钟无操作，自动确认收餐','超时处理，不代表系统检测到实际领取；完成后清理图片。',? FROM orders WHERE "+where,at,at),
  q("UPDATE orders SET fulfillment='collected',confirmed_by='system',confirmed_at=?,closed_at=?,updated_at=?,receipt=NULL,arrival_photo=NULL,media_removed_at=?,version=version+1 WHERE "+where,at,at,at,at,at)
 ]);
 return {confirmed:result[3].meta.changes};
}
