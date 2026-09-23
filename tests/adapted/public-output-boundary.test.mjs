import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPublicAssets,PUBLIC_FILES} from '../../apps/web/scripts/build-public-assets.mjs';

test('public build emits only explicitly approved files and safe deployment metadata',async()=>{
  const root=await mkdtemp(join(tmpdir(),'byeollog-public-output-'));
  try{
    await writeFile(join(root,'release-manifest.json'),JSON.stringify({sourceDigest:'a'.repeat(64)}));
    for(const name of PUBLIC_FILES){
      const path=join(root,...name.split('/'));
      await mkdir(join(path,'..'),{recursive:true});
      await writeFile(path,`fixture:${name}`);
    }
    await mkdir(join(root,'lib'),{recursive:true});
    await writeFile(join(root,'lib','auth.js'),'private');
    await writeFile(join(root,'new-private-file.txt'),'private');

    const result=await buildPublicAssets({projectRoot:root});
    assert.equal(result.publicFileCount,PUBLIC_FILES.length);
    assert.deepEqual(result.files.sort(),[...PUBLIC_FILES,'deployment-metadata.json'].sort());
    const metadata=JSON.parse(await readFile(join(result.outputRoot,'deployment-metadata.json'),'utf8'));
    assert.deepEqual(Object.keys(metadata).sort(),['publicDigest','publicFileCount','schemaVersion','sourceDigest']);
    assert.equal(metadata.sourceDigest,'a'.repeat(64));
    await assert.rejects(readFile(join(result.outputRoot,'lib','auth.js')));
    await assert.rejects(readFile(join(result.outputRoot,'new-private-file.txt')));
    await assert.rejects(readFile(join(result.outputRoot,'release-manifest.json')));
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});
