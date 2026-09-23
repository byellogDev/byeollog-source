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
