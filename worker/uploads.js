// The browser decodes/resizes JPG, PNG and WebP to baseline JPEG before upload.
// Keep the encoded image data; do not allocate pixels or run a server-side codec.
// This is bounded structural validation, not full image decoding or malware scanning.
const MAX_BYTES=5*1024*1024,MAX_PIXELS=4_000_000;
const invalid=()=>{throw new Error('图片格式不完整，请在网页中重新选择 JPG、PNG、WebP 或手机截图后上传。')};
const u16=(b,i)=>(b[i]<<8)|b[i+1];

export function validateUploadJpeg(input){
 const b=input instanceof Uint8Array?input:new Uint8Array(input);
 if(b.length>MAX_BYTES)throw new Error('图片不能超过 5 MB');
 if(b.length<4||b[0]!==255||b[1]!==216)invalid();
 const parts=[b.subarray(0,2)];let p=2,segments=0,frame=null,quant=false,huffman=false;
 while(p<b.length){
  if(++segments>512||b[p]!==255)invalid();
  const start=p++;while(b[p]===255)p++;
  const marker=b[p++];
  if(p+2>b.length)invalid();
  const length=u16(b,p),end=p+length;
  if(length<2||end>b.length)invalid();
  if(marker===0xc0){
   if(frame||length<11||b[p+2]!==8)invalid();
   const height=u16(b,p+3),width=u16(b,p+5),channels=b[p+7];
   if(!width||!height||width*height>MAX_PIXELS||![1,3].includes(channels)||length!==8+3*channels)invalid();
   const ids=[];for(let i=0;i<channels;i++){
    const k=p+8+i*3,id=b[k],sampling=b[k+1];
    if(ids.includes(id)||!(sampling>>4)||!(sampling&15)||(sampling>>4)>4||(sampling&15)>4||b[k+2]>3)invalid();
    ids.push(id);
   }
   frame={channels,ids};
  }else if(marker===0xdb){
   // Validate table boundaries without decoding image pixels.
   let k=p+2;while(k<end){const info=b[k++];if((info>>4)>1||(info&15)>3)invalid();k+=64*((info>>4)+1)}
   if(k!==end||length===2)invalid();quant=true;
  }else if(marker===0xc4){
   let k=p+2;while(k<end){const info=b[k++];if((info>>4)>1||(info&15)>3||k+16>end)invalid();let count=0;for(let i=0;i<16;i++)count+=b[k++];if(count>256)invalid();k+=count}
   if(k!==end||length===2)invalid();huffman=true;
  }else if(marker===0xdd){
   if(length!==4)invalid();
  }else if(marker===0xda){
   if(!frame||!quant||!huffman||b[p+2]!==frame.channels||length!==6+2*frame.channels)invalid();
   const seen=[];for(let i=0;i<frame.channels;i++){
    const id=b[p+3+i*2],table=b[p+4+i*2];
    if(!frame.ids.includes(id)||seen.includes(id)||(table>>4)>3||(table&15)>3)invalid();seen.push(id);
   }
   if(b[end-3]!==0||b[end-2]!==63||b[end-1]!==0)invalid();
   parts.push(b.subarray(start,end));
   // Baseline single-scan JPEG from canvas. Check escaping, restarts, and exact EOI.
   let k=end,entropy=0;
   while(k<b.length){
    if(b[k++]!==255){entropy++;continue}
    while(b[k]===255)k++;
    const code=b[k++];
    if(code===0){entropy++;continue}
    if(code>=0xd0&&code<=0xd7)continue;
    if(code!==0xd9||k!==b.length||!entropy)invalid();
    parts.push(b.subarray(end,k));
    const total=parts.reduce((sum,part)=>sum+part.length,0),out=new Uint8Array(total);let offset=0;
    for(const part of parts){out.set(part,offset);offset+=part.length}
    return out;
   }
   invalid();
  }else if(!((marker>=0xe0&&marker<=0xef)||marker===0xfe))invalid();
  // Strip EXIF/GPS, comments and other application metadata, even for API clients.
  if(!((marker>=0xe0&&marker<=0xef)||marker===0xfe))parts.push(b.subarray(start,end));
  p=end;
 }
 invalid();
}
