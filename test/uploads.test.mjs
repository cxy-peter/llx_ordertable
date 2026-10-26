import {test} from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import {validateUploadJpeg} from '../worker/uploads.js';

function sample(width=20,height=14){
 const data=new Uint8Array(width*height*4);for(let i=0;i<data.length;i+=4){data[i]=i%256;data[i+1]=(i*7)%256;data[i+2]=(i*13)%256;data[i+3]=255}
 return new Uint8Array(jpeg.encode({data,width,height},84).data);
}
function segment(marker,text){const payload=new TextEncoder().encode(text),out=new Uint8Array(payload.length+4);out.set([255,marker,(payload.length+2)>>8,(payload.length+2)&255]);out.set(payload,4);return out}
function withMetadata(b){return new Uint8Array([...b.subarray(0,2),...segment(0xe1,'Exif\0\0GPS secret'),...segment(0xfe,'private comment <script>'),...b.subarray(2)])}

test('lightweight upload preserves encoded pixels, removes EXIF/comments and is idempotent',()=>{
 const source=withMetadata(sample()),out=validateUploadJpeg(source),decoded=jpeg.decode(out,{useTArray:true});
 assert.deepEqual(decoded.data,jpeg.decode(source,{useTArray:true}).data);
 assert.equal(decoded.width,20);assert.equal(decoded.height,14);
 assert.ok(out.length<source.length);assert.ok(!new TextDecoder().decode(out).includes('GPS secret'));
 assert.ok(!new TextDecoder().decode(out).includes('private comment'));
 assert.deepEqual(validateUploadJpeg(out),out);
 // Encoded scan bytes are copied exactly, not run through a lossy JPEG encoder.
 const scan=b=>b.findIndex((v,i)=>v===255&&b[i+1]===0xda);
 assert.deepEqual(out.subarray(scan(out)),source.subarray(scan(source)));
});

test('upload rejects spoofed signatures, truncated tables/scans, trailing payloads and size/pixel bombs',()=>{
 const b=sample(),oversized=sample();
 const sof=oversized.findIndex((v,i)=>v===255&&oversized[i+1]===0xc0);oversized[sof+5]=255;oversized[sof+6]=255;oversized[sof+7]=255;oversized[sof+8]=255;
 const brokenTable=b.slice(),dqt=brokenTable.findIndex((v,i)=>v===255&&brokenTable[i+1]===0xdb);brokenTable[dqt+2]=255;brokenTable[dqt+3]=255;
 const progressive=b.slice();progressive[sof+1]=0xc2;
 for(const raw of [new TextEncoder().encode('<svg onload="evil()"/>'),new Uint8Array([255,216,255,217]),b.subarray(0,30),b.subarray(0,b.length-2),new Uint8Array([...b,60,115,99,114,105,112,116,62]),oversized,brokenTable,progressive,new Uint8Array(5*1024*1024+1)])assert.throws(()=>validateUploadJpeg(raw));
});

test('bounded parser handles randomized malformed inputs without hanging',()=>{
 const seed=sample();let state=12345;
 for(let n=0;n<200;n++){
  state=(Math.imul(state,1664525)+1013904223)>>>0;
  const raw=seed.slice(0,state%seed.length);if(raw.length>8)raw[4+(state%(raw.length-4))]=255;
  assert.throws(()=>validateUploadJpeg(raw));
 }
});
