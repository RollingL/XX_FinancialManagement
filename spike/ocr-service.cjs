const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const MAX_BYTES=20*1024*1024;
function error(message,status=422){return Object.assign(new Error(message),{status});}
function imageSuffix(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw error('请选择不超过 20 MiB 的 PNG 或 JPEG 图片',413);
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return '.png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return '.jpg';
 throw error('只支持有效的 PNG 或 JPEG 图片，不支持 PDF、SVG 或其他文件');
}
class OcrService{
 constructor({command,args,timeoutMs=90000,tempRoot=os.tmpdir()}){Object.assign(this,{command,args,timeoutMs,tempRoot});this.child=null;this.pending=null;this.busy=false;this.finished=Promise.resolve();}
 stop(message='识别已取消，可手动填写或重试'){
  const child=this.child;this.child=null;
  if(child)child.kill('SIGKILL');
  this.pending?.reject(error(message));
 }
 worker(){
  if(this.child)return this.child;
  const child=spawn(this.command,this.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  this.child=child;let output='';
  child.stderr.resume(); // OCR diagnostics may contain source text; never persist them.
  child.stdin.on('error',()=>{if(this.child===child)this.stop('识别进程不可用，请重试');});
  child.on('error',()=>{if(this.child===child)this.stop('无法启动本地 OCR，请检查本机运行环境');});
  child.on('close',()=>{if(this.child===child){this.child=null;this.pending?.reject(error('本地 OCR 已退出，请重试或手动核对'));}});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
   if(this.child!==child)return;
   output+=chunk;
   if(Buffer.byteLength(output)>2*1024*1024){this.stop('识别内容过多，请裁剪截图后重试');return;}
   let end;
   while((end=output.indexOf('\n'))>=0){
    const line=output.slice(0,end);output=output.slice(end+1);
    try{
     const reply=JSON.parse(line),pending=this.pending;
     if(!pending||reply.id!==pending.id)throw Error('Unexpected OCR reply');
     if(!reply.ok){pending.reject(error('图片解码或识别失败，请换一张截图，也可以手动填写'));continue;}
     const result=reply.result;
     if(pending.validateOnly?result?.validated!==true:(!result||!Array.isArray(result.texts)||!result.extraction||result.extraction.auto_bookkeeping!==false))throw Error('Invalid OCR result');
     pending.resolve(result);
    }catch{this.stop('识别结果格式异常，请重试或手动核对');}
   }
  });
  return child;
 }
 async recognize(bytes,{signal,validateOnly=false}={}){
  const suffix=imageSuffix(bytes);
  if(this.busy)throw error('已有图片正在识别，请稍后重试',409);
  if(signal?.aborted)throw error('识别已取消');
  this.busy=true;let folder;
  this.finished=new Promise(resolve=>{this.finish=resolve;});
  try{
   folder=await fs.mkdtemp(path.join(this.tempRoot,'xx-finance-ocr-'));
   const imagePath=path.join(folder,'input'+suffix);
   await fs.writeFile(imagePath,bytes,{flag:'wx',mode:0o600});
   if(signal?.aborted)throw error('识别已取消');
   const child=this.worker();const id=randomUUID();
   return await new Promise((resolve,reject)=>{
    const finish=(callback,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending=null;callback(value);};
    const abort=()=>this.stop();
    const timer=setTimeout(()=>this.stop('识别超过 90 秒，已停止；请裁剪图片或手动核对'),this.timeoutMs);
    this.pending={id,validateOnly,resolve:value=>finish(resolve,value),reject:value=>finish(reject,value)};
    signal?.addEventListener('abort',abort,{once:true});
    child.stdin.write(JSON.stringify({id,image_path:imagePath,validate_only:validateOnly})+'\n');
   });
  }finally{try{if(folder)await fs.rm(folder,{recursive:true,force:true});}finally{this.busy=false;this.finish();}}
 }
}
function createOcrService(resourcesPath){
 const command=resourcesPath?path.join(resourcesPath,'ocr-probe',process.platform==='win32'?'ocr-probe.exe':'ocr-probe'):path.join(__dirname,'..','.venv-ocr',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const args=resourcesPath?['--serve']:[path.join(__dirname,'ocr_probe.py'),'--serve'];
 // The OCR child reads images/models only; Windows process isolation still needs validation.
 return new OcrService(process.platform==='darwin'?{command:'/usr/bin/sandbox-exec',args:['-p','(version 1)(allow default)(deny network*)(deny file-write*)',command,...args]}:{command,args});
}
module.exports={createOcrService,OcrService,imageSuffix,MAX_BYTES};
