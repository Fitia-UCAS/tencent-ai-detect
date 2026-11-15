// Deliberately exposes regressions in native WebSocket compatibility.
// Creates no remote connection; runs the real shim under the existing test fake.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
class FakeWS extends EventTarget {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    static instances=[];
    constructor(url){super(); this.url=url;this.readyState=0;this.binaryType='blob';this.sent=[]; FakeWS.instances.push(this);}
    open(){this.readyState=1;this.onopen?.(new Event('open'));}
    send(x){if(this.readyState===0)throw new DOMException('connecting','InvalidStateError'); if(this.readyState===1)this.sent.push(x);}
    close(){this.readyState=3;}
}
const window={WebSocket:FakeWS,EventTarget,DOMException,URL,location:{href:'https://matrix.tencent.com/ai-detect/'}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','shim.js'),'utf8'),{window,EventTarget,Event,DOMException,URL,MessageEvent,setTimeout,clearTimeout,console});
const A=new window.WebSocket('wss://example.org/chat');const nativeA=FakeWS.instances.at(-1);nativeA.open();A.send('hello');A.send('hello');
console.log('case identical sends on open: expected 2; got '+nativeA.sent.length);
const B=new window.WebSocket('wss://example.org/chat'); const nativeB=FakeWS.instances.at(-1);let threw=false;
try{B.send('early')}catch(e){threw=e.name==='InvalidStateError'}
console.log('case non-target connecting send: native would throw InvalidStateError; shim threw='+threw);
nativeB.open();console.log('case non-target early data: native would send 0; shim sent '+nativeB.sent.length);
