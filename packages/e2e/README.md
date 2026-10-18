# Local E2E harness

These tests exercise real PostgreSQL, MinIO, NextAuth, the web API, and the
desktop render worker. They refuse non-loopback API/DB/MinIO hosts and require
an explicit mutation opt-in.

Loopback alone cannot detect an SSH tunnel or local reverse proxy. Never point
these variables at forwarded production services; the `_e2e` database and
`-e2e` bucket must be genuinely disposable local resources.

Start an isolated local stack and a web server built from the current source,
then run from the repository root in PowerShell:

```powershell
$env:E2E_API_BASE = 'http://localhost:3000'
$env:E2E_DATABASE_URL = 'postgresql://postgres:...@localhost:5432/dramaforge_e2e'
$env:E2E_MINIO_BUCKET = 'dramaforge-e2e'
$env:E2E_ALLOW_MUTATION = '1'
pnpm test:e2e
```

After building `packages/web` and migrating the dedicated database, use
`pnpm test:e2e:local` to start that production build on `E2E_API_BASE`, run both
harnesses, and stop the temporary server automatically.

The web server at `E2E_API_BASE` must also use `E2E_DATABASE_URL`. The harness
requires a loopback PostgreSQL URL whose database ends in `_e2e` and a dedicated
MinIO bucket ending in `-e2e`; PostgreSQL query-string host overrides are refused.

`test:e2e:film` creates a unique temporary user, render job, and MinIO clip
objects, then removes them. `test:e2e:upgrade` briefly raises the global local
client-version manifest and restores the exact prior value before it can pass.
Do not run the upgrade test against a local stack used by a real desktop client:
the client lockout is terminal for that process even after the manifest is
restored.

The root scripts do not start PostgreSQL, Redis, MinIO, migrations, or the web
server. `E2E_API_BASE` must point at the current source under test.
