export const MAX_IMAGE_BYTES=20*1024*1024;
export const MAX_IMAGE_PIXELS=20_000_000;
export function singleImage(files:readonly File[]){
 if(files.length!==1)throw Error('每次只支持一张图片，请选择或拖入单张 PNG / JPEG');
 const file=files[0];
 if(!['image/png','image/jpeg'].includes(file.type)||!file.size||file.size>MAX_IMAGE_BYTES)throw Error('请选择不超过 20 MiB 的 PNG 或 JPEG 图片，不支持 PDF、SVG 或其他附件');
 return file;
}
export async function validateImageFile(file:File,signal?:AbortSignal){
 singleImage([file]);signal?.throwIfAborted();
 const bytes=new Uint8Array(await file.slice(0,8).arrayBuffer());signal?.throwIfAborted();
 const png=[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value);
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(file.type==='image/png'?!png:!jpeg)throw Error('图片格式无效，请使用有效的 PNG / JPEG');
 let decoded:ImageBitmap;
 try{decoded=await createImageBitmap(file);}catch{signal?.throwIfAborted();throw Error('图片无法读取，请换一张有效的 PNG / JPEG');}
 try{
  signal?.throwIfAborted();
  if(!decoded.width||!decoded.height)throw Error('图片无法读取，请换一张有效的 PNG / JPEG');
  if(decoded.width*decoded.height>MAX_IMAGE_PIXELS)throw Error('图片超过 2000 万像素，请裁剪或缩小后重试');
 }finally{decoded.close();}
}
