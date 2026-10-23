import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('signup stores exactly the consent version accepted and never rewrites old consent',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table byeollog_signup_consents(workspace_id uuid,user_id uuid,terms_version text,privacy_version text,collection_agreed boolean,age_14_confirmed boolean);
 create function byeollog_complete_oauth_signup_v1(uuid,text,text,text,text,text) returns table(application_id uuid,workspace_id uuid,workspace_slug text,soop_id text) language sql as $$select $1,$1,'fixture','fixture'$$;`);
 let sql=fs.readFileSync(new URL('../../supabase/migrations/20261011095823_refresh_legal_consent_versions.sql',import.meta.url),'utf8').split('-- Read-only management view.')[0]+'commit;';await db.exec(sql);
 const call=c=>db.query("select * from byeollog_complete_oauth_signup_v2('10000000-0000-4000-8000-000000000001','a@example.invalid','Fixture','fixture',$1)",[c]);
 for(const version of ['2026-09-14','2026-10-11'])await call({termsVersion:version,privacyVersion:version,termsAgreed:true,collectionAgreed:true,age14Confirmed:true});
 const r=await db.query('select terms_version,privacy_version from byeollog_signup_consents order by terms_version');assert.deepEqual(r.rows.map(x=>x.terms_version),['2026-09-14','2026-10-11']);
 for(const c of [{},{termsVersion:'bad',privacyVersion:'bad'},{termsVersion:'2026-10-11',privacyVersion:'2026-09-14',termsAgreed:true,collectionAgreed:true,age14Confirmed:true}])await assert.rejects(call(c),e=>e.code==='22023');
 assert.equal((await db.query('select count(*)::int n from byeollog_signup_consents')).rows[0].n,2);
 }finally{await db.close()}
});
