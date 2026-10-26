// Local-only fictional fixtures. There is deliberately no remote switch.
import {Miniflare} from 'miniflare';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {DEFAULT_CONFIG,nyParts} from '../worker/config.js';
import {normalizeSettings} from '../worker/settings.js';
import {passwordHash,hash} from '../worker/core.js';
if(process.argv.length!==2)throw Error('此脚本仅支持本机空库，不接受远程或其他参数');
await mkdir('.local',{recursive:true});
const mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'weizhuo-preview'},r2Buckets:{BUCKET:'weizhuo-preview-private'},d1Persist:'.local/d1',r2Persist:'.local/r2'});
try{
 const db=await mf.getD1Database('DB');await db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
 for(const name of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort()){
  if(await db.prepare('SELECT 1 FROM local_migrations WHERE name=?').bind(name).first())continue;
  const sql=await readFile('drizzle/'+name,'utf8');await db.batch(sql.split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));
  await db.prepare('INSERT INTO local_migrations(name) VALUES(?)').bind(name).run();
 }
 const count=await db.prepare('SELECT (SELECT count(*) FROM customers)+(SELECT count(*) FROM orders) n').first();
 if(count.n)throw Error('本机已有账号或订单，已停止导入，未覆盖数据。请使用新的独立 checkout。');
 const config=normalizeSettings(DEFAULT_CONFIG),date=nyParts().date,now=new Date().toISOString();
 const {orders}=JSON.parse(await readFile('examples/orders.json','utf8'));const credentials=[],statements=[];
 if(!(await db.prepare('SELECT 1 FROM settings WHERE id=1').first()))statements.push(db.prepare('INSERT INTO settings(id,value) VALUES(1,?)').bind(JSON.stringify(config)));
 for(const item of orders){
  const userId=randomUUID(),password=randomBytes(18).toString('base64url'),pickup=config.pickups.find(p=>p.id===item.pickup);
  const lines=item.items.map(x=>{const m=config.menu.find(m=>m.id===x.id),o=m?.options.find(o=>o.id===x.option);if(!m||!o)throw Error('示例菜品已变更');return {...x,name:m.name,option_name:o.name,price:o.price}});
  if(!pickup)throw Error('示例配送点不存在');
  const total=lines.reduce((sum,x)=>sum+x.price*x.qty,0),session={date,session_name:'晚餐',slot_id:'dinner',cutoff:date+'T23:59:00Z',delivery:'虚构示例配送',batch_id:'asap',batch_name:'ASAP · 尽快安排',departure:''};
  statements.push(db.prepare('INSERT INTO customers(id,phone,name,wechat,password_hash,recovery_hash,created_at) VALUES(?,?,?,?,?,?,?)').bind(userId,item.phone,item.name,item.wechat,await passwordHash(password),await hash(randomBytes(32)),now));
  const fields={public_id:randomUUID(),user_id:userId,idem_hash:await hash(item.key),payload_hash:await hash(JSON.stringify(item)),name:item.name,phone:item.phone,wechat:item.wechat,pickup:item.pickup,pickup_info:JSON.stringify(pickup),note:item.note,session:JSON.stringify(session),date,slot:'dinner',items:JSON.stringify(lines),subtotal:total,tax:0,fee:0,total,phase:'submitted',payment:item.payment,fulfillment:item.fulfillment,channel:'Zelle',payer:'虚构付款人（未实际付款）',source:'customer',submitted_at:now,created_at:now,updated_at:now,prep:JSON.stringify(item.fulfillment==='preparing'?{0:1}:{}),closed_at:item.fulfillment==='collected'?now:null};
  statements.push(db.prepare(`INSERT INTO orders(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(()=>'?').join(',')})`).bind(...Object.values(fields)));
  credentials.push(`${item.name}\nPhone: ${item.phone}\nPassword: ${password}\n`);
 }
 await db.batch(statements);
 await writeFile('.local/example-logins.txt','LOCAL FICTIONAL DEMO ONLY - DO NOT PUBLISH\n\n'+credentials.join('\n'));
 console.log('已在本机空库导入 4 位虚构顾客和 4 笔示例订单；随机登录密码在 .local/example-logins.txt。');
 console.log('未连接远程数据库，未导入图片或真实付款记录。');
}finally{await mf.dispose()}
