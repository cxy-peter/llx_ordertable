const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>'$'+(c/100).toFixed(2);
const payLabels={unpaid:'未报付款',review:'待核实',verified:'已核实',exception:'付款异常',refund_pending:'退款待处理',refunded:'已退款'};
const fulLabels={pending:'待接单',preparing:'备餐中',dispatched:'已发车',arrived:'已到配送点',collected:'已领取',cancelled:'已取消'};
const badge=(v,map)=>`<span class="badge ${esc(v)}">${esc(map[v]||v)}</span>`;
const dateTime=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4500)}
async function api(path,opt={}){const headers={'X-Requested-With':'Weizhuo',...opt.headers};if(!document.hidden&&Date.now()-lastInteraction<60000&&Date.now()-lastActivitySent>30000){headers['X-WZ-Active']='1';lastActivitySent=Date.now()}if(opt.body&&!(opt.body instanceof FormData)){headers['Content-Type']='application/json';opt.body=JSON.stringify(opt.body)}let r;try{r=await fetch(path,{...opt,headers,cache:'no-store'})}catch(e){throw new Error('连接中断，数据可能不是最新。请检查网络后重试。')}const data=await r.json();if(!r.ok){const e=new Error(data.error||'请求失败，请重试');e.status=r.status;throw e}return data}
function randomToken(){const a=new Uint8Array(32);crypto.getRandomValues(a);return [...a].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function copyText(t){try{await navigator.clipboard.writeText(t);toast('已复制')}catch(e){const f=document.createElement('textarea');f.value=t;document.body.append(f);f.select();document.execCommand('copy');f.remove();toast('已复制')}}
const brand=`<a href="/" class="brand"><img src="/static/logo.svg" alt=""><span>围桌<small>WEIZHUO</small></span></a>`;
const demoNote=`<div class="demo-note"><span class="pulse"></span> 演示数据 · 请勿付款 · 菜单价格为美元 USD</div>`;
const batchText=o=>(o.session?.batch_name||'ASAP · 尽快安排')+(o.session?.departure?' · 约 '+o.session.departure+' 发车':'');
// Background polling must never extend a login. Only real interaction updates this clock.
let lastInteraction=Date.now(),lastActivitySent=0,idleMinutes=5,idleExempt=false,idleEnabled=false,idleCallback=null;
const idleRole=location.pathname.startsWith('/admin')?'admin':'customer';
for(const event of ['pointerdown','keydown','input','scroll'])document.addEventListener(event,e=>{if(e.isTrusted){lastInteraction=Date.now();try{localStorage.setItem('wz-active-'+idleRole,String(lastInteraction))}catch{}}},{passive:true});
window.addEventListener('storage',e=>{if(e.key==='wz-active-'+idleRole)lastInteraction=Math.max(lastInteraction,Number(e.newValue)||0)});
function sessionIdle(minutes,callback,exempt=false){idleMinutes=minutes||5;idleCallback=callback;idleExempt=exempt;idleEnabled=true;lastInteraction=Date.now()}
function stopIdle(){idleEnabled=false}
function pollingAllowed(){return !document.hidden&&idleEnabled&&(idleExempt||Date.now()-lastInteraction<idleMinutes*60000)}
setInterval(async()=>{if(!idleEnabled||idleExempt||Date.now()-lastInteraction<idleMinutes*60000)return;idleEnabled=false;await idleCallback?.()},5000);
function field(label,name,value='',extra=''){return `<label class="field">${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`}
function photoHTML(image,alt='',klass='dish-photo'){if(!image)return '<div class="photo-placeholder">围桌</div>';return `<svg class="${klass}" viewBox="${image.x} ${image.y} ${image.w} ${image.h}" role="img" aria-label="${esc(alt)}"><image href="/static/photos/${image.photo}.jpg" width="588" height="1280"/></svg>`}
async function prepareImage(file){
 if(!file||!file.size)throw new Error('请选择图片');if(file.size>20*1024*1024)throw new Error('原图片不能超过 20 MB，请选择截图或较小的图片');
 const url=URL.createObjectURL(file);try{const im=new Image();im.src=url;await im.decode();const scale=Math.min(1,1600/Math.max(im.naturalWidth,im.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.round(im.naturalWidth*scale);canvas.height=Math.round(im.naturalHeight*scale);const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(im,0,0,canvas.width,canvas.height);const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.84));if(!blob)throw new Error('encode');return new File([blob],'photo.jpg',{type:'image/jpeg'})}catch{throw new Error('无法读取这张图片，请使用 JPG、PNG、WebP 或手机截图。')}finally{URL.revokeObjectURL(url)}
}
