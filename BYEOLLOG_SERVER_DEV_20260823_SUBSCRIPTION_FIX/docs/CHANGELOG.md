# Server changelog

## 2026-08-25 — Agent collection-health compatibility hotfix

- Accept explicitly idle Agent collection health when nullable timestamps are omitted by older/current JSON clients.
- Keep invalid timestamp values fail-closed.
- Prevent optional collection-health telemetry from blocking the primary automation heartbeat and execution claim loop.
- Add regression coverage for an idle, non-collecting Agent so raffle and other local actions remain claimable.
