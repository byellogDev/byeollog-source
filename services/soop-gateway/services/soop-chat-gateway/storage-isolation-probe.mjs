import {
  closeSoopBrowserHost,
  probeSoopBrowserStorageIsolation
} from './browser-session.mjs';

let result=null;
try{
  result=await probeSoopBrowserStorageIsolation();
  if(result.isolated!==true||result.contextsDistinct!==true){
    throw Object.assign(new Error('SOOP browser storage isolation probe failed'),{
      code:'browser_storage_isolation_failed'
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}finally{
  await closeSoopBrowserHost();
}
