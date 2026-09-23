-- Publish the same seven wheel-only animations with their artwork centered on
-- the 1920x1080 transparent canvas. Historical revision hashes stay immutable;
-- new activations pin the centered digest through the stable asset key.

do $migration$
declare
  v_ready integer;
begin
  with replacement(asset_key,old_sha256,old_bytes,new_sha256,new_bytes,new_path) as (values
    ('roulette_navy_gold_v1','11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d',5646192::bigint,'5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13',5686510::bigint,'assets/native-roulette/5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13.webp'),
    ('roulette_royal_purple_rose_gold_v1','9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a',5535112::bigint,'71ed5715e7f8b4fd0f6cfae92f6836533603828cf1a9359496faabf6f938cc07',5507452::bigint,'assets/native-roulette/71ed5715e7f8b4fd0f6cfae92f6836533603828cf1a9359496faabf6f938cc07.webp'),
    ('roulette_emerald_champagne_v1','0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498',5831094::bigint,'31448a0faf6ea8e9eb90cb934f02815ea565bb77969ac1e6c48752dc54e11966',5850766::bigint,'assets/native-roulette/31448a0faf6ea8e9eb90cb934f02815ea565bb77969ac1e6c48752dc54e11966.webp'),
    ('roulette_burgundy_pale_gold_v1','168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69',5555386::bigint,'653f7292678be46798154b521aa653c5e9ef373e124ff95dc8f1037162ae32cd',5615970::bigint,'assets/native-roulette/653f7292678be46798154b521aa653c5e9ef373e124ff95dc8f1037162ae32cd.webp'),
    ('roulette_graphite_cyan_v1','05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf',5564130::bigint,'09288f7192cb5a9e7fd3be42805d073efe6434662f1a53a31d6c9c01edce79b5',5594568::bigint,'assets/native-roulette/09288f7192cb5a9e7fd3be42805d073efe6434662f1a53a31d6c9c01edce79b5.webp'),
    ('roulette_pastel_powder_blue_peach_v1','8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf',5443906::bigint,'e0114be1f9bdf7a9ed0cee7022a6c067a7571ccd1998d1e8e4c74bd556642b75',5440068::bigint,'assets/native-roulette/e0114be1f9bdf7a9ed0cee7022a6c067a7571ccd1998d1e8e4c74bd556642b75.webp'),
    ('roulette_pastel_lavender_butter_v1','07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8',5275120::bigint,'221f44f05f2ab2e812cb0998e6d29d426b78522aea70dd433413a647d7d5742d',5288010::bigint,'assets/native-roulette/221f44f05f2ab2e812cb0998e6d29d426b78522aea70dd433413a647d7d5742d.webp')
  )
  update byeollog_automation.native_roulette_assets asset set
    content_sha256=replacement.new_sha256,
    byte_size=replacement.new_bytes,
    published_path=replacement.new_path,
    delivery_status='published'
  from replacement
  where asset.asset_key=replacement.asset_key
    and (
      (asset.content_sha256=replacement.old_sha256 and asset.byte_size=replacement.old_bytes)
      or
      (asset.content_sha256=replacement.new_sha256 and asset.byte_size=replacement.new_bytes)
    );

  with replacement(asset_key,new_sha256,new_bytes,new_path) as (values
    ('roulette_navy_gold_v1','5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13',5686510::bigint,'assets/native-roulette/5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13.webp'),
    ('roulette_royal_purple_rose_gold_v1','71ed5715e7f8b4fd0f6cfae92f6836533603828cf1a9359496faabf6f938cc07',5507452::bigint,'assets/native-roulette/71ed5715e7f8b4fd0f6cfae92f6836533603828cf1a9359496faabf6f938cc07.webp'),
    ('roulette_emerald_champagne_v1','31448a0faf6ea8e9eb90cb934f02815ea565bb77969ac1e6c48752dc54e11966',5850766::bigint,'assets/native-roulette/31448a0faf6ea8e9eb90cb934f02815ea565bb77969ac1e6c48752dc54e11966.webp'),
    ('roulette_burgundy_pale_gold_v1','653f7292678be46798154b521aa653c5e9ef373e124ff95dc8f1037162ae32cd',5615970::bigint,'assets/native-roulette/653f7292678be46798154b521aa653c5e9ef373e124ff95dc8f1037162ae32cd.webp'),
    ('roulette_graphite_cyan_v1','09288f7192cb5a9e7fd3be42805d073efe6434662f1a53a31d6c9c01edce79b5',5594568::bigint,'assets/native-roulette/09288f7192cb5a9e7fd3be42805d073efe6434662f1a53a31d6c9c01edce79b5.webp'),
    ('roulette_pastel_powder_blue_peach_v1','e0114be1f9bdf7a9ed0cee7022a6c067a7571ccd1998d1e8e4c74bd556642b75',5440068::bigint,'assets/native-roulette/e0114be1f9bdf7a9ed0cee7022a6c067a7571ccd1998d1e8e4c74bd556642b75.webp'),
    ('roulette_pastel_lavender_butter_v1','221f44f05f2ab2e812cb0998e6d29d426b78522aea70dd433413a647d7d5742d',5288010::bigint,'assets/native-roulette/221f44f05f2ab2e812cb0998e6d29d426b78522aea70dd433413a647d7d5742d.webp')
  )
  select count(*) into v_ready
  from byeollog_automation.native_roulette_assets asset
  join replacement on replacement.asset_key=asset.asset_key
  where asset.content_sha256=replacement.new_sha256
    and asset.byte_size=replacement.new_bytes
    and asset.published_path=replacement.new_path
    and asset.delivery_status='published';

  if v_ready<>7 then
    raise exception 'native roulette centered asset catalog mismatch' using errcode='55000';
  end if;
end
$migration$;
