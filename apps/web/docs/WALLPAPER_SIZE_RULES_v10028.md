# Wallpaper size-rule release 1.0.0.28

## Deploy result

- URL: https://byeollog.com/
- Target: production; status: READY
- Deployment: dpl_4w1qcZBSfnTmfXQRzirsNceZA8Ns
- Source identity: dirty shared working tree, not a clean commit release. Source digest: `1e267f7e39ab7cf8a76f26a9a28d29d266b531df8e63d74c2ff5d60fb8442dae`.
- Framework: existing Node/Vercel functions and static HTML; remote Linux build, 5 seconds.
- Agent version / UI cache directory / signed update sequence: 1.0.0.28 / v1.0.0.28 / 10028.
- Edge: agent-runtime-g3a v28 ACTIVE, JWT verification retained. Compared with live v27: only `_shared/agent-wallpaper.ts` changed (additive sizeRanges forwarding).
- DB migration: local `20260905122827_wallpaper_snapshot_size_ranges.sql`, applied by hosted migration tool as `20260905123553_wallpaper_snapshot_size_ranges`.

## Defects and scope

An isolated 330 donation group configured for 360px previously calculated as 360px on the server, 240px in the automatic OBS renderer, and 180px in the initial editor draft. This is a code reproduction, not a capture from Hurogi's PC.

1. Snapshot SQL now forwards the existing size_ranges field. The deployed function body is patched at two exact anchors; auth, grants, session selection and recorded data are unchanged.
2. Agent mapper carries validated/bounded rules into its durable local state. Recovery transport carries the same field.
3. Automatic layouts consume the configured width; they do not scale it down merely because other groups occupy space. Existing explicit manual layouts remain authoritative.
4. Initial editor layout adds its reserved next-column space without halving the server-calculated card width. Bounds remain enforced.
5. Offline fallback retains size settings. Old caches request a full snapshot once through a separate sync cursor; acknowledged state and the cached display are preserved.
6. UI asset cache version is bumped so upgrades cannot reuse the old embedded editor.

No operating donation records or saved layouts were rewritten. No live user session or local production Agent was used for the tests. No polling interval, backup cadence, or image download concurrency changed. The bounded rule list adds bytes only to changed snapshots; upgraded old caches need one full snapshot.

## Verification

- 51 added JS scenarios: amounts 33/152/330; widths 80/240/360/480; counts 1/2/6/15; explicit manual override; next donation; crowded canvas; subscription/challenge/merged/legacy cases.
- Server suite: 489 passed.
- Agent contract suite: 211 passed.
- Agent store suite: 796 assertions passed (including size rule mapper, durable state, offline restart, and upgrade tests).
- Browser: isolated actual C# local overlay endpoint rendered three 330 cards at 360px by DOM measurement. Editor settings UI saved 360px with no console errors. Synthetic images/nicknames only.
- Final archived Windows EXE passed version-specific startup preflight; sealed ZIP and installer passed integrity gates. Public uploaded binaries downloaded and SHA-256 checked by the publisher.
- Production smoke: 14/14, p95 547.8ms, immediately after deployment. Production feed matches the signed local catalog byte-for-byte after whitespace normalization; `/agent/download` redirects to 1.0.0.28.

## Post-deploy observability

- Error scan: no entries returned for this Vercel deployment's error logs at verification time.
- Drains: not inspected or changed in this patch.
- Monitoring: immediate smoke/log scan only; no long-term monitor created.
- Supabase security advisor output unchanged before/after: existing private/RLS informational notices, direct authenticated SECURITY DEFINER notices, and disabled leaked-password protection warning. No new warning. Target snapshot remains service-role-only, with the existing device authentication call and 5s timeout.
- Advisor reference: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
- Password protection reference: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Artifacts

- ZIP: `byeollog_wallpaper_v10028_WIN_X64.zip`, 68,103,173 bytes, SHA-256 `9e8897bae2cad472e2a365a5f687e4ef559646fb284f37707e86540a3e03cb0b`.
- EXE SHA-256: `98a36d42279844b3cace83c653d6945fe1df787a57425f4f7a47c8addca222ec`.
- Installer: `Byeollog-Wallpaper-Setup-v1.0.0.28.exe`, 2,570,290 bytes, SHA-256 `4558789da5e8578c5f93252ba80248a429b11826a8c29d42555c168eeee26d4f`.
- Inner manifest SHA-256: `9dd02167baa819869b2f322399bf6cc75593146a59393a703ee6c009a523ec21`.
- GitHub: https://github.com/byellogDev/byeollog-releases/releases/tag/agent-v1.0.0.28

## Remaining verification / recovery

- Hurogi's actual PC is not verified remotely. Confirm displayed version 1.0.0.28. For a previously saved incorrect manual layout, press the existing **크기 규칙 저장·적용** once; the patch intentionally does not overwrite manual layouts on startup.
- A group whose requested fixed-size cards physically cannot fit 1920x1080 is still bounded by capacity constraints; the existing settings UI rejects impossible explicit applications. This patch does not promise unlimited fixed-size capacity.
- Previous Agent 1.0.0.27 packages and installer remain unchanged. Use the existing package rollback procedure (`ROLLBACK_LAST_VERSION.cmd`) if needed; do not erase local state.
- Previous web deployment: `dpl_Fjv6AngSVGyqvGoYUz27Q87BJmzm`. Rollback can repoint the alias to it. The additive DB/Edge field is backward compatible and may remain during client rollback.
- An unpublished initial 28 package was quarantined locally under `DIST/rejected-unpublished-v10028-ui-cache` before upload to correct UI cache identity. No published artifact was overwritten.
