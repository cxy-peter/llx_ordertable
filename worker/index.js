import ASSETS from 'virtual:assets';
import {apiResponse} from './core.js';
import {settleDueOrders} from './fulfillment.js';
import {guardedStorage} from './cost-guard.js';
import {purgeMedia} from './operations.js';
import {deliverNotifications,receivePushCallback} from './notifications.js';
const secureHeaders={
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
export default {async scheduled(event,env,ctx){const guarded=guardedStorage(env);ctx.waitUntil(Promise.allSettled([(async()=>{await settleDueOrders(guarded);await purgeMedia(guarded)})(),deliverNotifications(env)]))},async fetch(request,env,ctx){
 const url=new URL(request.url);let response;
 if(url.pathname.startsWith('/api/push/callback/'))response=await receivePushCallback(request,env);
 else if(url.pathname.startsWith('/api/'))response=await apiResponse(request,env);
 else{
  const path=url.pathname==='/'||url.pathname==='/order'?'/static/index.html':url.pathname==='/admin'?'/static/admin.html':url.pathname;
  const asset=ASSETS[path];if(!asset)response=new Response('Not found',{status:404});else{const raw=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));response=new Response(raw,{headers:{'Content-Type':asset.type,'Cache-Control':asset.type.startsWith('text/')?'no-cache':'public, max-age=300'}})}
 }
 // Send after the order transaction commits; a push failure must never fail an order.
 if(response.ok&&request.method==='POST'&&(/^\/api\/orders(?:\/\d+\/submit)?$/.test(url.pathname)||url.pathname==='/api/admin/push/test')){
  const pending=deliverNotifications(env).catch(()=>console.error('Phone notification delivery deferred'));
  if(ctx?.waitUntil)ctx.waitUntil(pending);else await pending;
 }
 const headers=new Headers(response.headers);for(const [key,value] of Object.entries(secureHeaders))headers.set(key,value);if(url.pathname.startsWith('/api/'))headers.set('Cache-Control','no-store');return new Response(response.body,{status:response.status,headers});
}};
