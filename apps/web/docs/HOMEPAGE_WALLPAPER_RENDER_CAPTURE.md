# Homepage wallpaper capture

The homepage uses `assets/wallpaper-showcase/overlay-rendered.png?v=21px`, a 960×540 excerpt captured at 1:1 pixels inside the actual 1920×1080 renderer, instead of CSS approximations of wallpaper cards. The 21px revision is deployed to https://byeollog.com (`dpl_Fjv6AngSVGyqvGoYUz27Q87BJmzm`, READY).

## Source and privacy

- `tools/Serve-HomepageWallpaperCapture.mjs` extracts the complete `OverlayHtml` raw string from the Agent's `ByeollogOverlayService.cs` without rewriting renderer CSS or JavaScript.
- The harness serves synthetic wallpaper state with only 별친구A/B/C and local registered signature artwork (33/152/330). No live cache, account, donation database, installed Agent, or OBS state is accessed.
- Only the transparent page backdrop is composed over navy and a transparent screenshot locator is added. This is an actual renderer output for a staged layout, not a screenshot of a live broadcast.
- The website serves only the static screenshot; it does not embed or poll the Agent renderer.

## Reproduce

1. Run `node tools/Serve-HomepageWallpaperCapture.mjs` from the web project.
2. Open `http://127.0.0.1:43917/overlay/wallpaper` in an isolated browser at exactly 1920×1080, device scale 1.
3. Wait until all six `.wallpaper-tile img` elements are complete with natural width 320.
4. Verify every card is 273×257 with a computed name font of 21px. Capture `#homepage-capture` to `assets/wallpaper-showcase/overlay-rendered.png`. This omits surrounding empty canvas but does not resize or separately alter the cards, images, or labels.
5. Record document, fixture, and screenshot hashes in `test/fixtures/homepage-wallpaper-capture.json` and rerun the homepage tests.
6. Close the browser and stop the harness.

## Verified 2026-09-05

- Six cards: 273×257; row step: 52; label track: 52.296875 pixels; computed name font: 21px. The original renderer and its font cap remain unchanged. Capture: 263,395 bytes.
- All image loads succeeded; only virtual nicknames were present.
- Homepage desktop and mobile retain the complete 16:9 screenshot, without a crop or overlay box covering it. Mobile: no horizontal overflow.
- No homepage API/polling requests; no browser JavaScript errors detected.
- Web test suite: 438/438 passed.

## Previous deployment (superseded by the local 21px revision)

Current 21px deployment verification: production HTML matches the local file; the resolution guide is removed; image SHA-256 matches `2870ff5119b75d9eb1134554c32dc8992de7d08f33baf832e5720cada390e4bf`; Agent feed unchanged. Read-only smoke 14/14 passed (p95 382.8 ms). Immediate error-log scan returned no entries. Rollback target is the previous deployment below. No runtime, database, or Agent changes were made.

- Deployed to https://byeollog.com on 2026-09-05; deployment `dpl_FJouocBdNpKKC4Lr1qzUMXAntpKy` is READY.
- Production HTML, CSP, and screenshot hash match the validated local files. Screenshot: 630,262 bytes. The signed Agent 1.0.0.27 feed is unchanged.
- Read-only production smoke: 14/14 passed, p95 447.9 ms. Production browser: image loaded at 1920×1080, displayed ratio approximately 16:9, no JavaScript errors detected. Immediate error-log scan returned no entries; this is not ongoing monitoring.
- Local runtime-config validation could not validate secret values because local environment credentials were absent. Production variable names were verified as present; no environment configuration was changed.
- Previous recoverable deployment: `dpl_FWGiozC7MP2QuMtjG8PGK3mXwRXF` (`https://observer_abangseladmin-fm9uvofuu-jminsu123-7345s-projects.vercel.app`). Use the existing Vercel rollback workflow if required; no database rollback is involved.
