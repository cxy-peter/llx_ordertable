import {build} from 'esbuild';
import {readFile,readdir,mkdir,cp,writeFile} from 'node:fs/promises';
import {resolve,relative,extname} from 'node:path';
import {Script} from 'node:vm';
import {createHash} from 'node:crypto';
const root=process.cwd(),dist=resolve(root,'dist');
const standalone=process.argv.includes('--standalone');
const manifest=standalone?{d1:'DB',r2:'BUCKET'}:JSON.parse(await readFile(resolve(root,'.openai/hosting.json'),'utf8'));
if((!standalone&&!manifest.project_id)||manifest.d1!=='DB'||manifest.r2!=='BUCKET')throw Error('Site identity or storage bindings missing');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'};
const assets={};async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=resolve(dir,e.name);if(e.isDirectory())await walk(p);else assets['/static/'+relative(resolve(root,'public'),p).replaceAll('\\','/')]={type:mime[extname(p)]||'application/octet-stream',data:(await readFile(p)).toString('base64')}}}
await walk(resolve(root,'public'));
// Browser JavaScript is embedded as data, so the Worker bundler cannot check its syntax.
for(const [path,asset] of Object.entries(assets))if(path.endsWith('.js'))new Script(Buffer.from(asset.data,'base64').toString('utf8'),{filename:path});
// Give each script/style a content version so a redeploy cannot reuse old browser
// resources under the same URL. The Worker routes by pathname, ignoring this query.
for(const [path,asset] of Object.entries(assets))if(path.endsWith('.html')){
 const html=Buffer.from(asset.data,'base64').toString('utf8').replace(/\b(src|href)="(\/static\/[^"?]+\.(?:js|css))"/g,(_,attr,url)=>{
  if(!assets[url])throw Error('Missing page resource: '+url);
  const version=createHash('sha256').update(Buffer.from(assets[url].data,'base64')).digest('hex').slice(0,12);
  return `${attr}="${url}?v=${version}"`;
 });asset.data=Buffer.from(html).toString('base64');
}
await mkdir(resolve(dist,'server'),{recursive:true});await mkdir(resolve(dist,'.openai'),{recursive:true});
await build({entryPoints:['worker/index.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:buffer'],minify:false,
 plugins:[{name:'embedded-assets',setup(b){b.onResolve({filter:/^virtual:assets$/},()=>({path:'assets',namespace:'embedded'}));b.onLoad({filter:/.*/,namespace:'embedded'},()=>({contents:'export default '+JSON.stringify(assets),loader:'js'}))}}]});
await writeFile(resolve(dist,'.openai/hosting.json'),JSON.stringify(manifest,null,2));
await cp(resolve(root,'drizzle'),resolve(dist,'.openai/drizzle'),{recursive:true});
const wrangler={name:'weizhuo-ordering',main:'index.js',compatibility_date:'2026-08-01',compatibility_flags:['nodejs_compat'],d1_databases:[{binding:'DB',database_name:'weizhuo-db',database_id:'00000000-0000-4000-8000-000000000000'}],r2_buckets:[{binding:'BUCKET',bucket_name:'weizhuo-private-images'}]};
await writeFile(resolve(dist,'server/wrangler.json'),JSON.stringify(wrangler,null,2));
console.log(`Built Worker with ${Object.keys(assets).length} embedded assets, D1 migrations and private R2 binding.`);
