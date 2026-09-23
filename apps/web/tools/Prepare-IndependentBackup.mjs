// Run only after approval to register a dedicated key and install the NCP job.
// Never retrieves or transfers CRON_SECRET. Secrets use stdin, not arguments/logs.
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const directory=resolve('.vercel/independent-backup-private');
await mkdir(directory,{recursive:true});
const acl=spawnSync('icacls',[directory,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`],{encoding:'utf8',windowsHide:true});
if(acl.status!==0)throw Error('Private key directory ACL setup failed');
try{await access(directory+'/restore-key.pem')}catch{
 const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 await writeFile(directory+'/restore-key.pem',keys.privateKey,{mode:0o600,flag:'wx'});
 await writeFile(directory+'/recipient.pem',keys.publicKey,{mode:0o600,flag:'wx'});
}
const secretPath=directory+'/runner-secret.txt';
try{await access(secretPath)}catch{await writeFile(secretPath,randomBytes(48).toString('base64url'),{mode:0o600,flag:'wx'})}
const secret=(await readFile(secretPath,'utf8')).trim();if(secret.length<48)throw Error('Dedicated backup credential invalid');
let registered=false;try{await access(directory+'/vercel-registered.json');registered=true}catch{}
if(!registered){
 const registeredResult=spawnSync(process.execPath,['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js','exec','--yes','--','vercel@59.5.0','env','add','BYEOLLOG_BACKUP_RUNNER_SECRET','production','--sensitive','--yes'],{input:secret+'\n',encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 if(registeredResult.status!==0)throw Error('Dedicated Vercel key registration failed; do not overwrite an existing key without checking');
 await writeFile(directory+'/vercel-registered.json',JSON.stringify({registeredAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
}
let recipientRegistered=false;try{await access(directory+'/vercel-recipient-registered.json');recipientRegistered=true}catch{}
if(!recipientRegistered){
 const result=spawnSync(process.execPath,['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js','exec','--yes','--','vercel@59.5.0','env','add','BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY','production','--no-sensitive','--yes'],{input:await readFile(directory+'/recipient.pem','utf8'),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 if(result.status!==0)throw Error('Vercel backup recipient registration failed; do not overwrite an existing value without checking');
 await writeFile(directory+'/vercel-recipient-registered.json',JSON.stringify({registeredAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
}
const files={};
for(const [source,destination] of [['ops/ncp/backup-runner.py','/usr/local/sbin/byeollog-independent-backup'],['ops/ncp/byeollog-independent-backup.service','/etc/systemd/system/byeollog-independent-backup.service'],['ops/ncp/byeollog-independent-backup.timer','/etc/systemd/system/byeollog-independent-backup.timer']])files[destination]=(await readFile(source,'utf8')).replaceAll('\r\n','\n');
const payload={config:{secret,publicKey:await readFile(directory+'/recipient.pem','utf8')},files};
const remote=`sudo -n python3 -c 'import sys,json,pathlib,os,subprocess; d=json.load(sys.stdin); allowed={"/usr/local/sbin/byeollog-independent-backup","/etc/systemd/system/byeollog-independent-backup.service","/etc/systemd/system/byeollog-independent-backup.timer"}; assert set(d["files"])==allowed; assert len(d["config"]["secret"])>=16; os.umask(0o077); root=pathlib.Path("/var/lib/byeollog-ops"); root.mkdir(exist_ok=True,mode=0o700); cfg=pathlib.Path("/etc/byeollog-backup-runner.json"); cfg.write_text(json.dumps(d["config"])); cfg.chmod(0o600); [(pathlib.Path(p).write_text(t),pathlib.Path(p).chmod(0o755 if p.startswith("/usr/local/sbin/") else 0o644)) for p,t in d["files"].items()]; subprocess.run(["python3","-m","py_compile","/usr/local/sbin/byeollog-independent-backup"],check=True); subprocess.run(["systemd-analyze","verify","/etc/systemd/system/byeollog-independent-backup.service","/etc/systemd/system/byeollog-independent-backup.timer"],check=True); subprocess.run(["systemctl","daemon-reload"],check=True); print("Backup runner installed and verified; timer not enabled yet")'`;
const result=spawnSync('pwsh',['-NoProfile','-File',resolve('ops/ncp/Invoke-ByeollogNcpSsh.ps1'),'-ForwardStandardInput','-RemoteCommand',remote],{input:JSON.stringify(payload),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
if(result.status!==0){
 const safe=String(result.stderr||'').replaceAll(secret,'[redacted]').replace(/-----BEGIN[\s\S]*?-----END[^\n]*-----/g,'[key]').split(/\r?\n/).filter(line=>/SyntaxError|NameError|Permission denied|sudo:|not found|Invalid|Error:|At line|Cannot|parameter|Missing/.test(line));
 console.error(JSON.stringify({installationError:safe.slice(0,8),status:result.status,spawnError:result.error?.code,signal:result.signal,stdoutLength:result.stdout?.length,stderrLength:result.stderr?.length}));
 throw Error('Backup runner installation failed (remaining output withheld to protect credentials)');
}
console.log(JSON.stringify({installed:true,timerEnabled:false,restoreKeyDirectory:directory}));
