-- Replace the seven built-in roulette animations with wheel-only variants.
-- Historical revision hashes remain untouched for auditability. Runtime
-- presentation resolves the immutable object by the stable asset key, while
-- every new activation is pinned to the replacement digest below.

do $migration$
declare
  v_ready integer;
begin
  with replacement(asset_key,old_sha256,old_bytes,new_sha256,new_bytes,new_path) as (values
    ('roulette_navy_gold_v1','8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',25698598::bigint,'11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d',5646192::bigint,'assets/native-roulette/11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d.webp'),
    ('roulette_royal_purple_rose_gold_v1','7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b',22339256::bigint,'9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a',5535112::bigint,'assets/native-roulette/9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a.webp'),
    ('roulette_emerald_champagne_v1','69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed',22276620::bigint,'0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498',5831094::bigint,'assets/native-roulette/0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498.webp'),
    ('roulette_burgundy_pale_gold_v1','ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f',21504782::bigint,'168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69',5555386::bigint,'assets/native-roulette/168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69.webp'),
    ('roulette_graphite_cyan_v1','68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77',21478638::bigint,'05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf',5564130::bigint,'assets/native-roulette/05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf.webp'),
    ('roulette_pastel_powder_blue_peach_v1','466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7',22176726::bigint,'8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf',5443906::bigint,'assets/native-roulette/8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf.webp'),
    ('roulette_pastel_lavender_butter_v1','844bbf142e2269c371a7c0bad202edf683b90e8393e6d23638558de1d85d7af5',21756766::bigint,'07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8',5275120::bigint,'assets/native-roulette/07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8.webp')
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
    ('roulette_navy_gold_v1','11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d',5646192::bigint,'assets/native-roulette/11a05b234cb85db274019754cd076ef8a3a3052ff6ca5dd4423d97c2dcc7061d.webp'),
    ('roulette_royal_purple_rose_gold_v1','9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a',5535112::bigint,'assets/native-roulette/9a38028c43a5f85f1abd67ae3ff305ecb380411399b512059579f380639f2d4a.webp'),
    ('roulette_emerald_champagne_v1','0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498',5831094::bigint,'assets/native-roulette/0bc5364755661f0258fc1788e6beff6ab36553c4c56d95d0e8206f17a8952498.webp'),
    ('roulette_burgundy_pale_gold_v1','168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69',5555386::bigint,'assets/native-roulette/168ff63b43e97a7f7ac845e802287e85882f2f21f14052c0a264c2523e07cf69.webp'),
    ('roulette_graphite_cyan_v1','05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf',5564130::bigint,'assets/native-roulette/05261ec0bbc8dbd3c2d9beadeff60c3602242e959e9088906f92323d2f06cebf.webp'),
    ('roulette_pastel_powder_blue_peach_v1','8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf',5443906::bigint,'assets/native-roulette/8526c206a43d1ed23cba50444f3dd795a892cf07ce48600ade3f0c0f4c1815cf.webp'),
    ('roulette_pastel_lavender_butter_v1','07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8',5275120::bigint,'assets/native-roulette/07cd0ccdc7eb5046eb52d97bdc7406143e689d0d0635528129663293d4d13eb8.webp')
  )
  select count(*) into v_ready
  from byeollog_automation.native_roulette_assets asset
  join replacement on replacement.asset_key=asset.asset_key
  where asset.content_sha256=replacement.new_sha256
    and asset.byte_size=replacement.new_bytes
    and asset.published_path=replacement.new_path
    and asset.delivery_status='published';

  if v_ready<>7 then
    raise exception 'native roulette wheel-only asset catalog mismatch' using errcode='55000';
  end if;
end
$migration$;
