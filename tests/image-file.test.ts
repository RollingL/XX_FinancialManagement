import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_IMAGE_BYTES,MAX_IMAGE_PIXELS,singleImage,validateImageFile} from '../prototype/src/image-file.ts';
const bitmapDescriptor=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async()=>{throw Error('decoder stub');}});
after(()=>{if(bitmapDescriptor)Object.defineProperty(globalThis,'createImageBitmap',bitmapDescriptor);else Reflect.deleteProperty(globalThis,'createImageBitmap');});
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
const jpeg=new Uint8Array([255,216,255,224]);
const file=(bytes=png,type='image/png')=>new File([bytes],'synthetic-image',{type});

test('点击和拖拽统一只接收单张非空 PNG/JPEG，拒绝其他类型及超限大小',()=>{
 const image=file();assert.equal(singleImage([image]),image);
 assert.equal(singleImage([file(jpeg,'image/jpeg')]).type,'image/jpeg');
 for(const files of [[],[image,image],[file(new Uint8Array())],[file(png,'image/svg+xml')],[file(png,'application/pdf')]])assert.throws(()=>singleImage(files));
 const large=file();Object.defineProperty(large,'size',{value:MAX_IMAGE_BYTES+1});assert.throws(()=>singleImage([large]),/20 MiB/);
 const boundary=file();Object.defineProperty(boundary,'size',{value:MAX_IMAGE_BYTES});assert.equal(singleImage([boundary]),boundary);
});

test('签名不符不能进入解码，损坏图片被拒绝',async t=>{
 let called=0;t.mock.method(globalThis,'createImageBitmap',async()=>{called++;throw Error('synthetic decode failure');});
 await assert.rejects(validateImageFile(file(new Uint8Array([1,2,3]))),/格式无效/);
 await assert.rejects(validateImageFile(file(png,'image/jpeg')),/格式无效/);
 assert.equal(called,0);
 await assert.rejects(validateImageFile(file()),/无法读取/);assert.equal(called,1);
});

test('解码后的像素上限及成功/失败都会释放 bitmap',async t=>{
 let width=5000,height=MAX_IMAGE_PIXELS/5000,closed=0;
 t.mock.method(globalThis,'createImageBitmap',async()=>({width,height,close(){closed++;}} as ImageBitmap));
 await validateImageFile(file());assert.equal(closed,1);
 height++;await assert.rejects(validateImageFile(file()),/2000 万像素/);assert.equal(closed,2);
 width=0;await assert.rejects(validateImageFile(file()),/无法读取/);assert.equal(closed,3);
});

test('取消使迟到解码结果失效，仍释放 bitmap',async t=>{
 let finish!:(value:ImageBitmap)=>void,started!:()=>void,closed=0;
 const decoding=new Promise<void>(resolve=>{started=resolve;});
 t.mock.method(globalThis,'createImageBitmap',()=>{started();return new Promise<ImageBitmap>(resolve=>{finish=resolve;});});
 const controller=new AbortController(),pending=validateImageFile(file(),controller.signal);
 await decoding;controller.abort();finish({width:100,height:100,close(){closed++;}} as ImageBitmap);
 await assert.rejects(pending,{name:'AbortError'});assert.equal(closed,1);
});
