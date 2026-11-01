// Offline regression: error+close must trigger only one replacement upstream.
// The upstream is a local EventEmitter; this test makes no external requests.
const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const file=path.join(__dirname, 'relay.cjs');
const src=fs.readFileSync(file,'utf8');
const marker='function openUpstream(ip) {';
if(!src.includes(marker))throw Error('function absent');
const mock=`let attemptCounter=0;
function openUpstream(ip) {
  const n=++attemptCounter;
  process.stderr.write('MOCK_OPEN_'+n+'\\n');
  const secure=new (require('node:events').EventEmitter)();
  secure.write=()=>true;
  secure.pause=()=>{};
  secure.resume=()=>{};
  secure.destroy=()=>{};
  if(n===1) setTimeout(()=>{secure.emit('error', new Error('synthetic TLS reset')); secure.emit('close');},30);
  return Promise.resolve({secure,ip,initial:Buffer.alloc(0)});
}
function unusedOriginalOpenUpstream(ip) {`;
const code=src.replace(/^#![^\n]*\n/,'').replace(marker,mock);
(async()=>{
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{let p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});
  const child=spawn(process.execPath,['-e',code],{env:{...process.env,RELAY_PORT:String(port),RELAY_IDLE_MS:'0'},stdio:['ignore','pipe','pipe'],cwd:__dirname});
  let logs='';child.stderr.on('data',b=>logs+=b.toString());let ready=false;child.stdout.on('data',b=>{if(b.toString().includes('relay listening'))ready=true;});
  try {
    for(let i=0;i<50&&!ready;i++)await new Promise(r=>setTimeout(r,20));
    if(!ready) throw Error('no relay start');
    const socket=net.connect(port,'127.0.0.1');
    socket.on('error',()=>{});
    await new Promise(r=>socket.once('connect',r));
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nOrigin: https://matrix.tencent.com\r\n\r\n`);
    await new Promise(r=>setTimeout(r,400));
    socket.destroy();
    const opens = logs.split('\n').filter(x=>x.startsWith('MOCK_OPEN_'));
    if (opens.join(',') !== 'MOCK_OPEN_1,MOCK_OPEN_2') {
      throw new Error('duplicate retry: '+JSON.stringify(opens));
    }
    console.log('PASS: error+close causes exactly one retry');
  }finally{child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
