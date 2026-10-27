import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {DEFAULT_CONFIG,currentMenu,serviceCutoff,nextServiceDate} from '../worker/config.js';
import {normalizeSettings} from '../worker/settings.js';

test('lunch and dinner roll independently at New York cutoffs without closing ordering',()=>{
 const s=normalizeSettings(DEFAULT_CONFIG);
 const before=currentMenu(s,'lunch',new Date('2026-10-26T18:59:59Z'));assert.equal(before.date,'2026-10-26');assert.equal(before.open,true);
 const lunch=currentMenu(s,'lunch',new Date('2026-10-26T19:00:00Z'));assert.equal(lunch.date,'2026-10-27');assert.equal(lunch.is_preorder,true);assert.equal(lunch.open,true);assert.ok(lunch.batches.every(b=>b.open));
 const dinner=currentMenu(s,'dinner',new Date('2026-10-26T19:00:00Z'));assert.equal(dinner.date,'2026-10-26');assert.equal(dinner.is_preorder,false);
 assert.equal(currentMenu(s,null,new Date('2026-10-27T01:29:59Z')).slot_id,'dinner');
 const after=currentMenu(s,null,new Date('2026-10-27T01:30:00Z'));assert.equal(after.slot_id,'lunch');assert.equal(after.date,'2026-10-27');assert.equal(after.open,true);assert.ok(after.slots.every(x=>x.is_preorder));
 assert.equal(currentMenu(s,'dinner',new Date('2026-10-27T01:30:00Z')).date,'2026-10-27');
 const midnight=currentMenu(s,'lunch',new Date('2026-10-27T04:00:00Z'));assert.equal(midnight.date,after.date);assert.equal(midnight.is_preorder,false);assert.equal(midnight.open,true);
});
test('tomorrow preorders use tomorrow overrides and temporary menu; explicit pauses remain honored',()=>{
 const s=normalizeSettings(DEFAULT_CONFIG),date=new Date('2026-10-27T01:45:00Z');
 s.day_overrides['2026-10-27']={slots:structuredClone(s.slots)};s.day_overrides['2026-10-27'].slots[1].batches=[{id:'tomorrow-only',name:'明日早鸟',time:'18:30',enabled:true}];
 const base=s.menu[0];s.menu.push({...base,id:'today-only',available_date:'2026-10-26'},{...base,id:'tomorrow-only',available_date:'2026-10-27'});
 let m=currentMenu(s,'dinner',date);assert.equal(m.batches[0].id,'tomorrow-only');assert.equal(m.batches[0].open,true);assert.equal(m.slots[1].delivery_window.start,'18:30');assert.ok(m.menu.some(x=>x.id==='tomorrow-only'));assert.ok(!m.menu.some(x=>x.id==='today-only'));
 s.day_overrides['2026-10-27'].slots[1].enabled=false;m=currentMenu(s,'dinner',date);assert.equal(m.open,false);assert.equal(m.batches[0].open,false);assert.equal(currentMenu(s,'lunch',date).open,true);
});
test('next service dates and cutoff timestamps stay correct over DST and year boundaries',()=>{
 assert.equal(nextServiceDate('2026-12-31'),'2027-01-01');assert.equal(nextServiceDate('2028-02-28'),'2028-02-29');
 assert.equal(serviceCutoff({date:'2026-11-01',cutoff_time:'15:00'}),'2026-11-01T20:00:00.000Z');
 assert.equal(serviceCutoff({date:'2026-03-08',cutoff_time:'21:30'}),'2026-03-09T01:30:00.000Z');
 const m=currentMenu(DEFAULT_CONFIG,'lunch',new Date('2026-11-01T01:30:00Z'));assert.equal(m.date,'2026-11-01');assert.equal(serviceCutoff(m),'2026-11-01T20:00:00.000Z');
});
test('customer rollover keeps valid basket lines, resets batch and renders the new date',async()=>{
 const context=createContext({localStorage:{getItem:()=>null,setItem(){}},document:{addEventListener(){},hidden:false},window:{addEventListener(){}},location:{hash:'#menu'},api:()=>new Promise(()=>{}),$:()=>null,setInterval(){},setTimeout,clearTimeout,Date});
 runInContext(await readFile('public/customer.js','utf8'),context);
 context.oldMenu=currentMenu(DEFAULT_CONFIG,'lunch',new Date('2026-10-26T18:59:00Z'));context.newMenu=currentMenu(DEFAULT_CONFIG,'lunch',new Date('2026-10-26T19:01:00Z'));
 runInContext("menu=oldMenu;cart=[{id:'xiaolongbao',option:'default',qty:2}];form.batch='lunch-1';renderMenu=()=>{globalThis.shownDate=menu.date};toast=()=>{}",context);
 context.api=async()=>context.newMenu;await runInContext('refreshCustomer()',context);
 assert.equal(context.shownDate,'2026-10-27');assert.equal(runInContext('cart[0].qty',context),2);assert.equal(runInContext('form.batch',context),'asap');
});
