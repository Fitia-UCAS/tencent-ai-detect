// Offline diagnostic: prove whether an application frame sent to a closed
// upstream is carried over to the next upstream while the page socket stays open.
// No access to production or third-party servers.
const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'relay.cjs'),'utf8');
const mock=`let nextUpstream=0;\nfunction openUpstream(ip) {\n const seq=++nextUpstream; const secure=new (require('node:events').EventEmitter)();\n secure.pause=()=>{};secure.resume=()=>{};secure.destroy=()=>{secure.emit('close')};\n secure.write=encoded=>{\n  const decoded=decodeFrames(encoded).frames.map(f=>f.payload.toString('utf8'));\n  process.stderr.write('UPSTREAM_'+seq+'_WRITE:'+JSON.stringify(decoded)+'\\n');\n  if(seq===1) setTimeout(()=>secure.emit('close'),20);\n  return true;\n };\n process.stderr.write('UPSTREAM_'+seq+'_OPEN\\n');\n return Promise.resolve({secure,ip,initial:Buffer.alloc(0)});\n}\nfunction retiredOpenUpstream(ip){`;
assert.equal(source.split('function openUpstream(ip) {').length,2);
const code=source.replace(/^#![^\n]*\n/,'').replace('function openUpstream(ip) {',mock);
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));})})}
function frame(text){const data=Buffer.from(text);const mask=crypto.randomBytes(4);return Buffer.concat([Buffer.from([0x81,0x80|data.length]),mask,Buffer.from(data.map((b,i)=>b^mask[i%4]))]);}
async function sleep(ms){await new Promise(r=>setTimeout(r,ms))}
(async()=>{const port=await freePort();const child=spawn(process.execPath,['-e',code],{env:{...process.env,RELAY_PORT:String(port),RELAY_IDLE_MS:'0'},stdio:['ignore','pipe','pipe'],cwd:__dirname});let err='';let out='';child.stderr.on('data',b=>err+=b.toString());child.stdout.on('data',b=>out+=b.toString());try{
 let ready=false;for(let i=0;i<50;i++){await sleep(40);if(out.includes('relay listening')){ready=true;break;}if(child.exitCode!==null)throw Error(err)}assert(ready,'relay started');
 const sock=net.connect(port,'127.0.0.1');sock.on('error',()=>{});await new Promise(r=>sock.once('connect',r));const key=crypto.randomBytes(16).toString('base64');sock.write(`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n`);
 let upgraded=false;let raw='';sock.on('data',b=>{raw+=b.toString('latin1');if(raw.includes('101 Switching Protocols'))upgraded=true});
 for(let i=0;i<40&&!upgraded;i++)await sleep(30);assert(upgraded);
 sock.write(frame('FIRST'));for(let i=0;i<60&&!err.includes('UPSTREAM_2_OPEN');i++)await sleep(30);assert(err.includes('UPSTREAM_2_OPEN'),'second upstream started');
 sock.write(frame('SECOND'));await sleep(100);
 const upstreamWrites=err.split('\n').filter(x=>x.startsWith('UPSTREAM_'));console.log(upstreamWrites.join('\n'));
 assert(upstreamWrites.some(x=>x.includes('UPSTREAM_1_WRITE:["FIRST"]')),'first delivered to original upstream');
 assert(upstreamWrites.some(x=>x.includes('UPSTREAM_2_WRITE:["SECOND"]')),'second delivered to replacement upstream');
 assert(!upstreamWrites.some(x=>x.includes('UPSTREAM_2_WRITE:["FIRST"]')),'original frame not replayed');
 console.log('DIAGNOSIS: Same page connection continued, but upstream changed and the second upstream had no first frame.');sock.destroy();
}finally{child.kill();}})().catch(e=>{console.error(e);process.exitCode=1});
