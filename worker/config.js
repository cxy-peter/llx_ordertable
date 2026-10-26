import {normalizeSettings,dailySlots,publicSettings} from './settings.js';
// Every menu price is USD, as explicitly stated in the supplied restaurant screenshots.
// Crop coordinates refer to the untouched 588 x 1280 screenshots, rendered as SVG viewports.
const crop=(photo,x,y,w=157,h=157)=>({photo,x,y,w,h});
const dish=(id,name,price,category,subtitle,image,extra={})=>({id,name,price,category,subtitle,image,tag:category,available:true,sold_out:false,slots:['lunch','dinner'],options:[{id:'default',name:'原份',price}],...extra});
export const DEFAULT_CONFIG={
 title:'围桌 · Jersey City 每日点餐',timezone:'America/New_York',auto_daily:true,tax_bps:0,fee_cents:0,
 notice:'请填写姓名和联系电话，统一配送至下方固定楼宇；具体配送时间以商家通知为准。',
 slots:[{id:'lunch',name:'午餐',cutoff:'15:00',enabled:true,delivery:'配送时间以商家通知为准'},{id:'dinner',name:'晚餐',cutoff:'23:59',enabled:true,delivery:'配送时间以商家通知为准'}],
 payment_notice:'上传凭证后请点击「正式提交给商家」。截图仅作核款凭证，到账由商家核实。',
 payments:[{id:'Zelle',account:'DEMO ONLY - DO NOT PAY',recipient:'演示账户',currency:'USD',enabled:true},
 {id:'Venmo',account:'DEMO ONLY - DO NOT PAY',recipient:'演示账户',currency:'USD',enabled:true},
 {id:'支付宝',account:'仅演示，请勿付款',recipient:'演示账户',currency:'CNY',enabled:true},
 {id:'微信',account:'仅演示，请勿付款',recipient:'演示账户',currency:'CNY',enabled:true}],
 pickups:[
   {id:'summit626',short:'626/632',name:'626 / 632 Summit',address:'626/632 Summit 大厅沙发边',hint:'请核对楼号与订单号，配送到固定位置后领取。',time:'以商家通知为准'},
   {id:'jsq2',short:'JSQ2',name:'JSQ2',address:'Lobby 外卖架子，或电梯口对面小房间',hint:'送达后查看订单中的现场照片。',time:'以商家通知为准'},
   {id:'summit505',short:'505',name:'505 Summit',address:'Lobby 前台边架子',hint:'送达后查看订单中的现场照片。',time:'以商家通知为准'},
   {id:'journal36',short:'36',name:'36 The Journal Square',address:'Lobby 前台，或 18TJ 前台',hint:'具体放置位置以送达照片及商家通知为准。',time:'以商家通知为准'},
   {id:'cottage43',short:'43',name:'43 Cottage / Greysion',address:'前台',hint:'楼宇名称按商家截图录入，请核对地址。',time:'以商家通知为准'},
   {id:'urby',short:'Urby',name:'Urby',address:'前台',hint:'该点订单较少，需要耐心等待。',time:'以商家通知为准'},
   {id:'summit425',short:'425',name:'425 Summit',address:'Lobby',hint:'通常为最后配送的点，请留意送达通知。',time:'以商家通知为准'}],
 menu:[
   dish('xiaolongbao','小笼包（6个）',1100,'包点','手工猪肉馅蒸包，一笼 6 个',crop(3,35,333)),
   dish('shengjianbao','生煎包（6个）',1200,'包点','猪肉馅，煎制，一笼 6 个',crop(3,35,582)),
   dish('radish-beef','萝卜丝炒牛肉',2350,'家常菜','辣口，配米饭',crop(3,35,831)),
   dish('fried-noodles','夜市炒粉干',1450,'家常菜','酸豆角／酸萝卜／素菜，可选择加肉',crop(3,35,1080,157,112),{options:[{id:'veg',name:'素',price:1450},{id:'pork',name:'加猪肉',price:1650},{id:'beef',name:'加牛肉',price:1750},{id:'shrimp',name:'加虾',price:1750},{id:'chicken',name:'加鸡肉',price:1650}]}),
   dish('beans-pork','酸豆角肉末',1900,'家常菜','辣口，配米饭',crop(4,35,294)),
   dish('beans-gizzard','酸豆角鸡胗',1950,'家常菜','默认酸辣，配米饭',crop(4,35,543)),
   dish('cumin-lamb','孜然羊肉粒',2600,'家常菜','配一份米饭，可在备注说明不辣',crop(4,35,792)),
   dish('black-pepper-beef','黑椒牛肉片',2500,'家常菜','牛肉片、黑椒风味，配米饭',crop(4,35,1041,157,151)),
   dish('sour-fish','酸汤黑鱼片',2450,'家常菜','酸汤黑鱼片，配米饭',crop(5,35,330)),
   dish('mung-soup','绿豆汤',100,'汤饮','自制绿豆甜汤，小／中／大',crop(5,35,580),{options:[{id:'small',name:'小份',price:100},{id:'medium',name:'中份',price:300},{id:'large',name:'大份',price:500}]}),
   dish('pork-chop-rice','黑椒猪扒饭',1300,'午餐饭盒','仅午餐，含例汤；15:00 后不售',crop(5,35,829),{slots:['lunch']}),
   dish('braised-pork-rice','卤肉饭',1300,'午餐饭盒','仅午餐，含当日例汤',crop(6,35,293),{slots:['lunch']}),
   dish('tomato-beef-rice','番茄鸡蛋牛肉盖饭',1400,'午餐饭盒','仅午餐，含一份小例汤',crop(6,35,542),{slots:['lunch']}),
   dish('pepper-pork-rice','青椒里脊肉丝盖饭',1300,'午餐饭盒','仅午餐，含一份小例汤',crop(6,35,791),{slots:['lunch']}),
   dish('cumin-chicken-rice','孜然鸡片盒饭',1300,'午餐饭盒','仅午餐，配例汤；15:00 后不售',crop(6,35,1039,157,153),{slots:['lunch']}),
   dish('kungpao-rice','宫保鸡丁盒饭',1250,'午餐饭盒','仅午餐，含例汤',crop(7,35,283),{slots:['lunch']}),
   dish('mapo-rice','麻婆豆腐盒饭',1250,'午餐饭盒','仅午餐，配例汤',crop(7,35,532),{slots:['lunch']}),
   dish('tofu-pork-rice','小椒香干肉丝盒饭',1300,'午餐饭盒','仅午餐，小椒香干肉丝，配例汤',crop(7,35,781),{slots:['lunch']}),
   dish('twice-pork-rice','回锅肉盒饭（辣）',1300,'午餐饭盒','仅午餐，辣口，配例汤',crop(7,35,1030,157,162),{slots:['lunch']}),
   dish('chili-beef-rice','尖椒牛肉盒饭',1350,'午餐饭盒','仅午餐，配例汤',crop(8,35,290),{slots:['lunch']}),
   dish('mixed-beef-rice','杂菜牛盒饭',1350,'午餐饭盒','仅午餐，配米饭和一份汤',crop(8,35,539),{slots:['lunch']}),
   dish('broccoli-beef-rice','芥兰牛盒饭',1350,'午餐饭盒','仅午餐，配例汤',crop(8,35,788),{slots:['lunch']}),
   dish('chive-pie','韭菜盒子',600,'包点','煎好的韭菜盒子',crop(8,35,1037,157,155))
 ]
};

export function nyParts(date=new Date()){
 const f=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const p=Object.fromEntries(f.formatToParts(date).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
export function currentMenu(settings,slotId,date=new Date()){
 const s=normalizeSettings(settings),local=nyParts(date),slots=dailySlots(s,local.date).map(slot=>{
  // Use the whole day's enabled schedule, including earlier departures: this is
  // the service window, not a list of the batches still available to book.
  const times=slot.batches.filter(b=>b.enabled).map(b=>b.time).sort();
  return {...slot,delivery_window:times.length?{start:times[0],end:times.at(-1)}:null};
 });const slot=slots.find(s=>s.id===slotId)||slots.find(s=>s.id===(local.time<'15:00'?'lunch':'dinner'))||slots[0];
 return {...publicSettings(s),slots,date:local.date,session_name:slot.name,slot_id:slot.id,cutoff_time:slot.cutoff,open:slot.enabled&&local.time<slot.cutoff,delivery:slot.delivery,
  batches:slot.batches.filter(b=>b.enabled).map(b=>({...b,open:local.time<b.time&&local.time<slot.cutoff})),pickups:s.pickups.filter(p=>p.enabled),
  menu:s.menu.filter(m=>m.available&&m.slots.includes(slot.id)&&(!m.available_date||m.available_date===local.date)),server_time:date.toISOString()};
}
