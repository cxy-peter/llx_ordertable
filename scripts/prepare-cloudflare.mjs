// Produce a portable deployment artifact; never create resources or start billing.
import {readFile,readdir,mkdir,cp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const target='outputs/cloudflare-migration';await mkdir(target,{recursive:true});
await cp('dist/server/index.js',target+'/index.js');await cp('drizzle',target+'/migrations',{recursive:true});await cp('docs/cloudflare-migration.md',target+'/迁移说明.md');
const databaseId=process.argv[2];if(databaseId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId))throw Error('参数必须是新 Cloudflare D1 返回的真实数据库 ID');
const config={name:'linglongxuan',main:'index.js',compatibility_date:'2026-08-01',compatibility_flags:['nodejs_compat'],workers_dev:true,d1_databases:[{binding:'DB',database_name:'linglongxuan',database_id:databaseId||'FILL_WITH_NEW_D1_DATABASE_ID',migrations_dir:'migrations'}],r2_buckets:[{binding:'BUCKET',bucket_name:'linglongxuan-private'}]};
await writeFile(target+'/'+(databaseId?'wrangler.json':'wrangler.example.json'),JSON.stringify(config,null,2));
const manifest=[];async function walk(path){for(const file of await readdir(path,{withFileTypes:true})){const p=path+'/'+file.name;if(file.isDirectory())await walk(p);else if(file.name!=='sha256.json'){const b=await readFile(p);manifest.push({path:p.slice(target.length+1),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')})}}}await walk(target);await writeFile(target+'/sha256.json',JSON.stringify(manifest,null,2));
console.log('Portable artifact prepared at '+target+'. No account resources, secrets, customer data, or paid services created.');
