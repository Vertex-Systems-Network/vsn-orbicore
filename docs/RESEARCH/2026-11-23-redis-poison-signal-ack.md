# ORB-004 — Durable rejection-before-ACK for synthetic Redis Streams

**Date:** 2026-11-23

## Primary sources

- [Redis XREADGROUP documentation](https://redis.io/docs/latest/commands/xreadgroup/) — a delivered consumer-group message becomes part of the pending entries list (PEL).
- [Redis XACK documentation](https://redis.io/docs/latest/commands/xack/) — acknowledgment removes a stream entry from the group's PEL after processing; successful acknowledgment is not a database commit.
- [Redis XAUTOCLAIM documentation](https://redis.io/docs/latest/commands/xautoclaim/) — permits redelivery of stale PEL entries after worker loss.
- [Redis XPENDING documentation](https://redis.io/docs/latest/commands/xpending/) — inspects pending-entry counts and delivery state.

## Scope and decision

The previous synthetic Redis worker `XACK`ed foreign-tenant or malformed job notifications without a durable, independently inspectable reason. This is undesirable for forensic diagnosis and intermittent poison-signal storms. Migration 014 records a strict allowlisted rejection classification in PostgreSQL **before** acknowledgment; no raw external job fields, tenant names or credential payloads are written. A unique tenant+Redis-entry key gives crash-gap idempotency; a replay increments an occurrence counter. A database outage fails the notification closed: do not ACK until durable evidence is recorded. Actual hosted PG16/Redis7 tests exercise missing jobs, bad tenant/ID, forced write fault, forced ACK failure and `XAUTOCLAIM` replay. The table uses forced RLS and no reader-role policy.

A small bounded-jitter exponential delay prevents the opt-in standalone synthetic worker from tight polling during consecutive infrastructure failures, but does not implement a fleet supervisor or a distributed retry scheduler.

**Not proven:** signed publisher identity, trusted DB writer role, off-host/WORM retention, full dead-letter payload custody, operator redrive, replay rate controls under a hostile Redis server, Redis AOF fsync/power-loss, live provider permissions or production authentication. Real operational alerting and authorization are separate gates.
