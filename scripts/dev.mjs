import {Miniflare} from 'miniflare';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,pbkdf2Sync,randomBytes} from 'node:crypto';
await mkdir('.local',{recursive:true});let secret;
try{secret=JSON.parse(await readFile('.local/secrets.json','utf8'))}catch{
 const password=randomBytes(18).toString('base64url');const salt=randomBytes(16).toString('hex');secret={ADMIN_PASSWORD_HASH:`pbkdf2$100000$${salt}$${pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex')}`};
 await writeFile('.local/secrets.json',JSON.stringify(secret));
 await writeFile('.local/admin-login.txt',`Local demo only\nUsername: admin\nPassword: ${password}\n`);
 console.log('本机管理员凭据已保存到 .local/admin-login.txt，请勿提交到 Git。');
}
const mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],port:Number(process.env.PORT||8790),host:'127.0.0.1',
 d1Databases:{DB:'weizhuo-preview'},r2Buckets:{BUCKET:'weizhuo-preview-private'},d1Persist:'.local/d1',r2Persist:'.local/r2',bindings:secret});
const db=await mf.getD1Database('DB');await db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
for(const file of (await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort()){
 if(await db.prepare('SELECT 1 FROM local_migrations WHERE name=?').bind(file).first())continue;
 const sql=await readFile(join('drizzle',file),'utf8');await db.batch(sql.split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));await db.prepare('INSERT INTO local_migrations(name) VALUES(?)').bind(file).run();
}
console.log('Weizhuo cloud preview ready: '+await mf.ready);
async function shutdown(){await mf.dispose();process.exit(0)}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
