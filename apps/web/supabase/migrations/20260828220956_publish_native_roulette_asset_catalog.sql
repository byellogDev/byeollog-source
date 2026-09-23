do $migration$
declare v_updated integer;
begin
with published(asset_key,content_sha256,byte_size,published_path) as (values
  ('roulette_navy_gold_v1','8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',25698598::bigint,'assets/native-roulette/8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38.webp'),
  ('roulette_royal_purple_rose_gold_v1','7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b',22339256::bigint,'assets/native-roulette/7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b.webp'),
  ('roulette_emerald_champagne_v1','69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed',22276620::bigint,'assets/native-roulette/69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed.webp'),
  ('roulette_burgundy_pale_gold_v1','ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f',21504782::bigint,'assets/native-roulette/ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f.webp'),
  ('roulette_graphite_cyan_v1','68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77',21478638::bigint,'assets/native-roulette/68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77.webp'),
  ('roulette_pastel_powder_blue_peach_v1','466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7',22176726::bigint,'assets/native-roulette/466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7.webp'),
  ('roulette_pastel_lavender_butter_v1','844bbf142e2269c371a7c0bad202edf683b90e8393e6d23638558de1d85d7af5',21756766::bigint,'assets/native-roulette/844bbf142e2269c371a7c0bad202edf683b90e8393e6d23638558de1d85d7af5.webp')
)
update byeollog_automation.native_roulette_assets asset set
  delivery_status='published',published_path=published.published_path
from published
where asset.asset_key=published.asset_key
  and asset.content_sha256=published.content_sha256
  and asset.byte_size=published.byte_size;
get diagnostics v_updated=row_count;
if v_updated<>7 then
  raise exception 'immutable native roulette asset catalog mismatch' using errcode='55000';
end if;
end
$migration$;
