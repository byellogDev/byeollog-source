-- Add the selected text-free square mic-off icon as three immutable placement
-- presets. The legacy microphone_off asset is intentionally left untouched so
-- existing rules and older Agents continue to resolve the exact SVG revision.

insert into public.overlay_assets (
  id,
  asset_key,
  version_number,
  display_name,
  mime_type,
  content_sha256,
  byte_size,
  width_px,
  height_px,
  delivery_mode,
  retired_at
)
values
  (
    'f7ae3370-5e3c-5061-958b-c7c402c590c6'::uuid,
    'mic_off_center',
    1,
    '마이크 OFF · 중앙 출력형',
    'image/png',
    '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464',
    335254,
    1254,
    1254,
    'builtin',
    null
  ),
  (
    'f831caee-6953-51f9-9eee-9cfb66e96fc4'::uuid,
    'mic_off_top_left',
    1,
    '마이크 OFF · 좌측 상단형',
    'image/png',
    '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464',
    335254,
    1254,
    1254,
    'builtin',
    null
  ),
  (
    'e745492e-4420-52e8-9a2b-36f53144c1c8'::uuid,
    'mic_off_top_right',
    1,
    '마이크 OFF · 우측 상단형',
    'image/png',
    '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464',
    335254,
    1254,
    1254,
    'builtin',
    null
  )
on conflict (id) do nothing;

do $migration$
begin
  if (
    select count(*)
    from public.overlay_assets
    where (id, asset_key, version_number, display_name, mime_type, content_sha256,
           byte_size, width_px, height_px, delivery_mode, retired_at is null) in (
      ('f7ae3370-5e3c-5061-958b-c7c402c590c6'::uuid, 'mic_off_center', 1, '마이크 OFF · 중앙 출력형', 'image/png', '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464', 335254, 1254, 1254, 'builtin', true),
      ('f831caee-6953-51f9-9eee-9cfb66e96fc4'::uuid, 'mic_off_top_left', 1, '마이크 OFF · 좌측 상단형', 'image/png', '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464', 335254, 1254, 1254, 'builtin', true),
      ('e745492e-4420-52e8-9a2b-36f53144c1c8'::uuid, 'mic_off_top_right', 1, '마이크 OFF · 우측 상단형', 'image/png', '70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464', 335254, 1254, 1254, 'builtin', true)
    )
  ) <> 3 then
    raise exception 'mic-off placement preset metadata does not match the Agent built-ins';
  end if;
end
$migration$;

insert into public.overlay_asset_durations (overlay_asset_id, duration_ms)
select asset.id, seconds.value * 1000
from public.overlay_assets asset
cross join generate_series(1, 240) as seconds(value)
where asset.id in (
    'f7ae3370-5e3c-5061-958b-c7c402c590c6'::uuid,
    'f831caee-6953-51f9-9eee-9cfb66e96fc4'::uuid,
    'e745492e-4420-52e8-9a2b-36f53144c1c8'::uuid
  )
  and asset.retired_at is null
on conflict (overlay_asset_id, duration_ms) do nothing;
