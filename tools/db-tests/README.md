# SQL regression tests

Run from the canonical repository root:

```powershell
npm ci --prefix tools/db-tests --ignore-scripts --no-audit --no-fund
npm test --prefix tools/db-tests
```

PGlite executes the production migration as PostgreSQL SQL in a fresh in-memory database. The suite first reproduces the old startup false alarm, then checks startup grace, established connection thresholds, recovery ordering, retries, suppression, unrelated alerts and role privileges.

`net.http_post` is a local capture table stub; no Discord message, live database connection, credential or user record is involved. Real Discord delivery and multi-session concurrency are not established by this suite. The same tests run in the GitHub verification workflow.
