import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Official SDK stays unchanged and uncommitted; no production credentials.
const directory=new URL('../../.local/soop-browserless-lab/',import.meta.url);
const expected='4d6974d882013e4cae2797010668855d3c2aeb0d2a8f711b08f65578c118a016';
const response=await fetch('https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js',{redirect:'error',signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error(`SDK download returned ${response.status}`);
const bytes=Buffer.from(await response.arrayBuffer());
if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('SDK version changed; review fixtures before updating the pinned checksum.');
await fs.mkdir(directory,{recursive:true});
await fs.writeFile(new URL('sdk.js',directory),bytes);
console.log(JSON.stringify({sdkSha256:expected,bytes:bytes.length}));
