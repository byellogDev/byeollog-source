import {randomBytes,createPublicKey,publicEncrypt,createCipheriv,createHash,constants} from 'node:crypto';
export function sealBackup(bytes,publicKey){
  const key=createPublicKey(publicKey);
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072)throw Error('Backup recipient requires RSA 3072 or stronger');
  const contentKey=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',contentKey,iv);
  cipher.setAAD(Buffer.from('byeollog-independent-backup-v1'));
  const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
  const result={format:'byeollog-independent-backup-v1',wrappedKey:publicEncrypt({key,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},contentKey).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length};
  contentKey.fill(0);return result;
}
