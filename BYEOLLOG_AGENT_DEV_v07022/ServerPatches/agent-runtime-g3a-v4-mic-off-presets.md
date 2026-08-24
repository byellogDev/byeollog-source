# agent-runtime-g3a v4 · mic-off position presets

Production deployment completed with `agent-runtime-g3a` v4. Version 3 was
immediately superseded because changing the runtime release identifier caused
the existing release gate to return HTTP 503.

In `agent-runtime/index.ts`:

1. Preserve the active runtime release identifier
   `offsl-agent-runtime-g3a-v1`; changing it without a matching release row
   makes the release gate return HTTP 503.
2. Replace the single `BUILT_IN_OVERLAY_ASSET` object with the array below.
3. Return `assets: BUILT_IN_OVERLAY_ASSETS` from `overlay_manifest`.
4. Keep `verify_jwt: true` and preserve every shared source file byte.

```ts
const BUILT_IN_OVERLAY_ASSETS = [
  {
    assetId: "27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc",
    assetKey: "mic_off",
    versionNumber: 1,
    displayName: "별록 마이크 OFF · 기존 화면(호환용)",
    mimeType: "image/svg+xml",
    contentSha256: "e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b",
    byteSize: 1926,
    widthPx: 1200,
    heightPx: 360,
    deliveryMode: "agent_builtin",
    required: true,
    downloadPath: null
  },
  {
    assetId: "f7ae3370-5e3c-5061-958b-c7c402c590c6",
    assetKey: "mic_off_center",
    versionNumber: 1,
    displayName: "마이크 OFF · 중앙 출력형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  },
  {
    assetId: "f831caee-6953-51f9-9eee-9cfb66e96fc4",
    assetKey: "mic_off_top_left",
    versionNumber: 1,
    displayName: "마이크 OFF · 좌측 상단형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  },
  {
    assetId: "e745492e-4420-52e8-9a2b-36f53144c1c8",
    assetKey: "mic_off_top_right",
    versionNumber: 1,
    displayName: "마이크 OFF · 우측 상단형",
    mimeType: "image/png",
    contentSha256: "70b19130e6807a364172eb129bfce03f5cae598cfde8242b762de7274476c464",
    byteSize: 335254,
    widthPx: 1254,
    heightPx: 1254,
    deliveryMode: "agent_builtin",
    required: false,
    downloadPath: null
  }
] as const;
```

`DatabaseMigrations/20260820_add_mic_off_position_presets.sql` was applied in
the same production change window. All four manifest entries and the three new
database rows were verified before distributing Agent 0.7.0.15.
