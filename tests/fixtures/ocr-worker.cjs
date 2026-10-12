// Deterministic transport double; real OCR is exercised separately with image fixtures.
const readline=require('node:readline');
const fs=require('node:fs');
let calls=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(process.argv[2]==='hang')return;
 if(process.argv[2]==='crash')process.exit(1);
 console.log(JSON.stringify({id:request.id,ok:true,result:{texts:[],extraction:{auto_bookkeeping:false},calls:++calls,fileExists:fs.existsSync(request.image_path)}}));
});
