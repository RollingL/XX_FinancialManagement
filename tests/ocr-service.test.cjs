const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {PassThrough,Writable}=require('node:stream');
const {OcrService,imageSuffix,MAX_BYTES}=require('../spike/ocr-service.cjs');
const {ocrMiddleware}=require('../spike/ocr-http.cjs');
const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
async function setup(t,mode='normal',timeoutMs=2000){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'xx-ocr-test-'));
 const service=new OcrService({command:process.execPath,args:[path.join(__dirname,'fixtures/ocr-worker.cjs'),mode],tempRoot:folder,timeoutMs});
 t.after(async()=>{service.stop();await service.finished;await fs.rm(folder,{recursive:true,force:true});});
 return {folder,service};
}
test('边界：魔数、空文件、大小限制',()=>{assert.equal(imageSuffix(png),'.png');for(const b of [Buffer.from('<svg/>'),Buffer.alloc(0),Buffer.alloc(MAX_BYTES+1)])assert.throws(()=>imageSuffix(b));});
test('复用子进程，成功后清除临时图片',async t=>{
 const {folder,service}=await setup(t);
 const first=await service.recognize(png),second=await service.recognize(png);
 assert.equal(first.fileExists,true);assert.equal(first.calls,1);assert.equal(second.calls,2);assert.deepEqual(await fs.readdir(folder),[]);
});
test('取消、忙碌与超时均不留下临时文件',async t=>{
 const {folder,service}=await setup(t,'hang',150);
 const controller=new AbortController();
 const first=service.recognize(png,{signal:controller.signal});
 const cancelled=assert.rejects(first,/取消/);
 await assert.rejects(service.recognize(png),e=>e.status===409);
 controller.abort();await cancelled;
 assert.deepEqual(await fs.readdir(folder),[]);
 await assert.rejects(service.recognize(png),/超过/);
 assert.deepEqual(await fs.readdir(folder),[]);
});
test('子进程失败可恢复，临时图片清理',async t=>{
 const {folder,service}=await setup(t,'crash');
 await assert.rejects(service.recognize(png),/退出/);assert.deepEqual(await fs.readdir(folder),[]);
 service.args=[path.join(__dirname,'fixtures/ocr-worker.cjs')];assert.equal((await service.recognize(png)).fileExists,true);
});
async function request(headers={},method='POST',body=png){
 const req=new PassThrough();Object.assign(req,{url:'/api/ocr',method,headers:{host:'127.0.0.1:5173',origin:'http://127.0.0.1:5173','x-ocr-request':'1','content-type':'application/octet-stream',...headers}});
 let data='',calls=0;const res=new Writable({write(chunk,_encoding,done){data+=chunk;done();}});
 res.writeHead=(status,h)=>{res.status=status;res.headers=h;};
 const promise=ocrMiddleware({recognize:async bytes=>{calls++;assert.deepEqual(bytes,body);return{ok:true};}},'http://127.0.0.1:5173')(req,res,()=>assert.fail('unexpected route'));
 req.end(body);await promise;return {status:res.status,body:data,calls};
}
test('HTTP 只接受同源二进制请求，拒绝跨站/Host 伪造/超限',async()=>{
 assert.equal((await request()).status,200);
 for(const h of [{origin:'https://example.com'},{host:'attacker.example:5173'},{'x-ocr-request':undefined},{'content-type':'text/plain'}]){const r=await request(h);assert.equal(r.status,403);assert.equal(r.calls,0);}
 assert.equal((await request({'content-length':String(MAX_BYTES+1)})).status,413);
 assert.equal((await request({},'GET')).status,405);
});
