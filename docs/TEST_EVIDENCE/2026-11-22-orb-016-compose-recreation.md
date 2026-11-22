# ORB-016 — Disposable Docker Compose named-volume / Redis AOF persistence — 2026-11-22

## Actual hosted proof

- Repository: `Vertex-Systems-Network/vsn-orbicore`; PR [#15](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/15).
- **Tested implementation SHA:** `93b9b763c36bbb4082235fc403083f4b9d62922e`.
- [GitHub Actions Service Integration run #45002668539](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002668539): **success**, two independent jobs: existing hosted PostgreSQL/Redis parity and new **Disposable Compose volume and AOF persistence**.
- [GitHub Actions CI #45002668414](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002668414): **success**, retained default build/security/test checks (52 Node automated tests on the prior merged checkpoint).
- [Compose recovery evidence artifact ID 14746203719](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45002668539/artifacts/14746203719), ZIP SHA-256 `b6c467eb83076372d1005aa30d4998baba3c1a5bffe6cfe34383560eac052259`. It contains AOF preparation, opt-in worker output, and scoped JSON evidence.
- Runtime: disposable GitHub `ubuntu-latest` runner, `docker compose` using the existing `docker-compose.yml`, PostgreSQL `postgres:16-alpine`, Redis `redis:7-alpine` with `--appendonly yes`, Node 24 and locked runtime packages `pg@8.23.1`/`redis@6.3.1`. Unique per-run Compose project name; no operator stack or local storage accessed.

## What was exercised and asserted

1. Booted **actual Compose services** with health checks; PostgreSQL initialized `db/postgres-schema.sql`. Applied PostgreSQL migrations `001_postgres_job_leases.sql` and `002_postgres_job_outbox.sql` with fail-on-error checks.
2. Inserted disposable organization, operator, account, an `inventory_refresh` job `running` under a five-second lease, and its durable `job_outbox` record. All data was synthetic and had `source='mock_fixture'`.
3. On a **single Redis client connection**, created a per-tenant stream and worker group, published a matching job signal, consumed it without ACK, and invoked `WAITAOF 1 0 5000`. Verified Redis confirmed one local AOF fsync and the stream's pending count was one. `WAITAOF` is available from Redis 7.2 and confirms local AOF flush, not HA safety; see [Redis official command reference](https://redis.io/docs/latest/commands/waitaof/).
4. Recorded both original container IDs, `docker compose stop postgres redis`, `docker compose rm -f postgres redis`, and `docker compose up -d --wait` using the **same existing named volumes**. Verified both container IDs changed and the old PostgreSQL job, actor and outbox were still present.
5. Verified Redis reloaded AOF stream and the unacknowledged consumer-group pending entry after container recreation, with AOF still enabled.
6. Allowed **seven real seconds** to pass for the job's lease to expire naturally; no SQL timestamp updates. Started the **separate, explicitly synthetic-only** Node worker once. It reclaimed the Redis pending job and finished with persisted status `completed`, attempt count `2`, `processedBy='synthetic_redis_worker'` and Redis pending count `0`.
7. Workflow's `EXIT` cleanup executes `docker compose down --volumes --remove-orphans` for the unique disposable project; no persistent CI environment is left running.

## Limits and next gates

- This verifies **graceful service-container removal/recreation with named volumes retained** and local AOF fsync. It is NOT a real host-disk crash, forced SIGKILL of the database server, replicated/HA failover, off-host backup/restore, or production durability SLA; Redis AOF cannot guarantee exactly-once remote effects.
- This worker/PG identity proof **seeded a synthetic operator directly in PostgreSQL**. The full app HTTP identity and audit still use SQLite; full SQLite v7 -> PostgreSQL schema parity, migration/cutover, tenant-scoped database roles/RLS and atomic audit remain open.
- No real cPanel/WHM credentials, provider API calls, destructive commands, user production records or live network hosting actions. Real provider integration is separately blocked on authorization.
- Task `ORB-016` should remain `testing`/`integration_tested` because production installer, schema/role migration, backups, RLS, multitenancy and host-failure recovery are still unverified.
- This evidence file was created after the tested implementation head. Confirm the final PR SHA, service/CI workflows, squash merge and resulting `main` independently.
