# Byeollog canonical source

This is the canonical development tree derived from the accepted 2026-09-23 operating baseline. Historical release folders outside this tree are not deployment inputs.

- Preserve independent frontend, admin, collector, public-read, backup and gateway permission boundaries.
- Preserve component package manifests and locks during initial migration. Do not hoist or merge dependencies while changing production behavior.
- Prepare a candidate without assigning operating domains. Record the previous deployment, verify the candidate, then promote the same deployment. A source change is not proof of deployed behavior.
- Record every release using docs/templates/release.md and update CHANGELOG.md. Distinguish automatic tests, direct observation, and user acceptance.
- Only approved test-workspace data may be mutated during verification.
- Never commit credentials, private user data, database dumps, local evidence, or platform access files. Run the publication scanner on the exact Git file list before pushing.
- Remote version cleanup must preserve current feeds, update compatibility, and rollback assets.
- No agents or scripts should deploy from a historical or temporary folder.

## GitHub publication cadence (user decision, 2026-09-24)

- At the end of each major task, record its purpose, changes, validation, remaining limitations and deployment state, then commit and push the reviewed changes to the existing GitHub repository. Do not leave completed work only on the local machine.
- Check for missing records at least daily; the daily thread automation runs at 23:00 Asia/Seoul. Keep a concise dated entry under `docs/work-log/`. No empty commits or repeated notifications when nothing changed.
- Use explicit file selection, inspect the actual staged diff, run the publication scanner on the Git file list, and verify the remote commit. Never include `.local`, credentials, personal data, raw logs, deployment connection files or private evidence.
- Preserve ongoing changes by other tasks. Use a `codex/` branch and PR; do not force-push, discard work, automatically merge, or deploy as part of the daily publication task.
- Clearly distinguish deployed fixes, unfinished work and research candidates. Publishing a research checkpoint does not certify it as production-ready.

## Minecraft integration ownership (user decision, 2026-09-24)

- Develop the Byeollog ↔ Minecraft integration components directly in this canonical repository: account linking, server authentication/authorization, donation-to-game mapping, delivery queues, retry/deduplication, and delivery acknowledgements. This project owns implementation, tests, builds, candidate deployment, and release verification for those components.
- The Minecraft project owns Minecraft server internals and gameplay (Paper/Velocity/DiaCore, seasons, world and game actions). Coordinate the API/event contract and test results at that boundary.
- The earlier workflow of implementing Byeollog integration in the Minecraft workspace and copying it back for deployment is superseded for future integration work. Historical handoffs remain evidence, not deployment sources.
- This ownership decision does not move files, activate an unfinished bridge, or authorize bypassing existing candidate verification and data-isolation rules.
