import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

async function screen(){
 const ctx=createContext({localStorage:{getItem:()=>null},document:{addEventListener(){}},$:()=>null,$$:()=>[],api:()=>new Promise(()=>{}),esc:String,batchText:()=>'',URLSearchParams,setInterval,clearInterval,setTimeout,clearTimeout});
 for(const file of ['admin-ops.js','admin.js'])runInContext(await readFile('public/'+file,'utf8'),ctx,{filename:file});
 return ctx;
}
function order(id,fulfillment,is_test=false){return {id,is_test,payment:'verified',fulfillment,date:'2026-10-26',slot:'dinner',number:'TEST-'+id,name:'Fixture',pickup_info:{name:'Test building'},note:'',kitchen:{total:3,done:1,remaining:2,ready:false,lines:[{id:'dish',option:'one',name:'Fixture dish',option_name:'One',index:0,qty:3,done:1}]}}}
test('kitchen shows only current work, isolates test orders, and returns to zero',async()=>{
 const ctx=await screen();ctx.fixtures=[order(1,'preparing'),order(2,'preparing',true),...['dispatched','arrived','collected','cancelled','pending'].map((s,i)=>order(i+3,s))];
 runInContext("orders=fixtures;day='2026-10-26';orderKind='real'",ctx);
 const html=runInContext('kitchenProgressView()',ctx);
 assert.match(html,/<strong>3<small>/);assert.match(html,/<strong>1<small>/);assert.match(html,/<strong class="accent">2<small>/);
 assert.equal((html.match(/class="card prep-order"/g)||[]).length,1);
 assert.doesNotMatch(html,/TEST-[2-7]/);
 runInContext('orders=fixtures.filter(o=>o.fulfillment!=="preparing")',ctx);
 const empty=runInContext('kitchenProgressView()',ctx);assert.equal((empty.match(/<strong(?: class="accent")?>0<small>/g)||[]).length,3);assert.doesNotMatch(empty,/class="kitchen-card"/);
});
test('silent kitchen refresh clears stale counts with no selected delivery checkboxes',async()=>{
 const ctx=await screen();ctx.previous=[order(1,'preparing')];
 runInContext("orders=previous;view='kitchen';day='2026-10-26';settingsData={};render=()=>{globalThis.rendered=kitchenProgressView()};pollNewOrders=async()=>{}",ctx);
 ctx.api=async()=>({orders:[],next:null,outstanding_other:0,server_time:'2026-10-26T22:00:00Z'});
 await runInContext('refresh(true)',ctx);
 assert.equal((ctx.rendered.match(/<strong(?: class="accent")?>0<small>/g)||[]).length,3);
 assert.doesNotMatch(ctx.rendered,/TEST-1/);
});
