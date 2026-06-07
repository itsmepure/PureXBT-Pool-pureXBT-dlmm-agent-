// Unit tests for meteoraFetchWithCache (v2: 5 retries + throttle)
// Run: node deploy/test/test-meteora-cache.js

import { meteoraFetchWithCache, _resetMeteoraCache } from "../tools/screening.js";

let passed = 0; let failed = 0;
function asEq(n,a,e){const ok=JSON.stringify(a)===JSON.stringify(e);if(ok){console.log('  \u2713 '+n);passed++}else{console.log('  \u2717 '+n+'\n    '+JSON.stringify(e)+'\n    '+JSON.stringify(a));failed++}}
function asOk(n,c){if(c){console.log('  \u2713 '+n);passed++}else{console.log('  \u2717 '+n);failed++}}

let fc=0,rq=[];
function mock(re){fc=0;rq=[...re];globalThis.fetch=async(u)=>{fc++;const r=rq.shift();if(!r)throw new Error('empty mock');return{ok:r.status>=200&&r.status<300,status:r.status,statusText:r.statusText||'',headers:{get:k=>k.toLowerCase()==='retry-after'?r.ra:null},json:async()=>r.body}}}

console.log('meteoraFetchWithCache v2:\n');

// 1: cache hit within TTL
await _resetMeteoraCache();mock([{status:200,body:{data:['a']}}]);
const t1a=await meteoraFetchWithCache('https://t/1'),t1b=await meteoraFetchWithCache('https://t/1');
asEq('cache hit',t1b,{data:['a']});asOk('1 fetch',fc===1);

// 2: concurrent dedup
await _resetMeteoraCache();mock([{status:200,body:{data:['shared']}}]);
await Promise.all([meteoraFetchWithCache('https://t/2'),meteoraFetchWithCache('https://t/2'),meteoraFetchWithCache('https://t/2')]);
asOk('3 parallel = 1 fetch',fc===1);

// 3: retry on 429 succeeds
await _resetMeteoraCache();mock([{status:429},{status:200,body:{data:['ok']}}]);
asEq('retry wins',await meteoraFetchWithCache('https://t/3'),{data:['ok']});asOk('2 attempts',fc===2);

// 4: 6x 429 = throw (1 + 5 retries)
await _resetMeteoraCache();mock([{status:429},{status:429},{status:429},{status:429},{status:429},{status:429}]);
let th=false;try{await meteoraFetchWithCache('https://t/4')}catch(e){th=true;asOk('429 msg',e.message.includes('429'))}
asOk('6x429 throws',th);asOk('6 attempts',fc===6);

// 5: 500 no retry
await _resetMeteoraCache();mock([{status:500}]);
th=false;try{await meteoraFetchWithCache('https://t/5')}catch(e){th=true}
asOk('500 throws',th);asOk('1 attempt on 500',fc===1);

console.log('\n'+passed+'/'+(passed+failed)+' passed');
process.exit(failed>0?1:0);
