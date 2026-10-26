export const NAVIGATION_LIMIT=30, NAVIGATION_WINDOW=60000;

// This is a lightweight interaction check, not proof of identity or a substitute
// for registration rate limits / Turnstile. No customer identity is in the key.
export async function navigationGuard(c){
 const {path,method,request,one,q,rows,body,json,hash,random,rate,adminSession,customerSession,ip}=c;
 const navigation=path==='/api/navigation',verify=path==='/api/navigation/verify';
 const protectedRoute=/^\/api\/(orders(?:\/|$)|customer\/(orders|history|reorder|profile|password)$)/.test(path);
 if(!navigation&&!verify&&!protectedRoute)return null;
 if(await adminSession())return navigation||verify?json({ok:true,exempt:true}):null;
 const session=await customerSession();
 const customer=session?await one('SELECT account_type FROM customers WHERE id=?',session.user_id):null;
 if(['developer','super_customer'].includes(customer?.account_type))return navigation||verify?json({ok:true,exempt:true}):null;
 if(!navigation&&!verify&&!session)return null; // normal endpoint ownership checks apply
 const key=await hash('navigation:'+ (session?'user:'+session.user_id:'guest:'+ip)),now=Date.now();
 let state=await one('SELECT * FROM interaction_guards WHERE key=?',key);
 async function challenge(){
  const values=crypto.getRandomValues(new Uint8Array(2)),a=3+values[0]%17,b=2+values[1]%13;
  await q("UPDATE interaction_guards SET blocked=1,challenge_id=?,question=?,answer_hash=?,expires=? WHERE key=? AND (challenge_id='' OR expires<=?)",random(),a+' + '+b+' = ?',await hash(String(a+b)),now+300000,key,now).run();
  state=await one('SELECT * FROM interaction_guards WHERE key=?',key);
  return json({error:'切换页面过于频繁，请完成计算题后继续。购物车和订单不会丢失。',challenge:{id:state.challenge_id,question:state.question,expires:state.expires}},428);
 }
 if(verify&&method==='POST'){
  const p=await body(request);await rate('navigation-answer',key,8,10);
  const answer=typeof p.answer==='string'?p.answer.trim():'';
  if(!state?.blocked||typeof p.challenge_id!=='string'||!/^\d{1,4}$/.test(answer))return json({error:'验证信息无效，请重新验证'},400);
  const result=await q("UPDATE interaction_guards SET blocked=0,count=0,window_started=?,challenge_id='',question='',answer_hash='',expires=0,updated_at=? WHERE key=? AND blocked=1 AND challenge_id=? AND answer_hash=? AND expires>?",now,now,key,p.challenge_id,await hash(answer),now).run();
  if(!result.meta.changes)return challenge();
  return json({ok:true});
 }
 if(navigation&&method==='POST'){
  await q('DELETE FROM interaction_guards WHERE updated_at<?',now-86400000).run();
  await q(`INSERT INTO interaction_guards(key,window_started,count,updated_at) VALUES(?,?,1,?)
   ON CONFLICT(key) DO UPDATE SET count=CASE WHEN interaction_guards.window_started<=? THEN 1 ELSE interaction_guards.count+1 END,
   window_started=CASE WHEN interaction_guards.window_started<=? THEN excluded.window_started ELSE interaction_guards.window_started END,updated_at=excluded.updated_at`,key,now,now,now-NAVIGATION_WINDOW,now-NAVIGATION_WINDOW).run();
  state=await one('SELECT * FROM interaction_guards WHERE key=?',key);
  if(state.blocked||state.count>NAVIGATION_LIMIT)return challenge();
  return json({ok:true,remaining:NAVIGATION_LIMIT-state.count});
 }
 if(state?.blocked)return challenge();
 return null;
}
