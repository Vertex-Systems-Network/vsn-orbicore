# Phase 0 feasibility research

**Checked:** 2026-11-09 (UTC). Sources below are primary vendor documentation unless noted. These references are entry points; validate target provider/version before implementing live operations.

## Provider constraints

- cPanel's UAPI accesses cPanel features/account data and supports function calls on its API endpoint. API token authentication uses the cPanel username and token in the Authorization header. Public docs do not establish that all UAPI functions are enabled on all shared hosts. Use the account-context adapter and discover actual capability; never imply cPanel token equals WHM root. Sources: [UAPI introduction](https://api.docs.cpanel.net/cpanel/introduction), [API token auth](https://api.docs.cpanel.net/cpanel/tokens).
- WHM's Transfer Tool copies accounts/configurations and documents a source-server requirement for root or `sudo`/`su` privileges; Live Transfer can affect DNS records/nameservers. Product must have separate authorization, preflight and rollback for this path. Sources: [Transfer Tool](https://docs.cpanel.net/whm/transfers/transfer-tool/), [Transfer process](https://docs.cpanel.net/whm/transfers/transfer-tool/the-transfer-process/), [Transfer or Restore Account](https://docs.cpanel.net/whm/transfers/transfer-or-restore-a-cpanel-account/).
- cPanel Remote Database Access can be enabled or disabled by a hosting provider. Remote database hosting is conditional, not a portable default. Source: [Remote MySQL / Remote Database Access](https://docs.cpanel.net/cpanel/databases/remote-mysql/).
- Restore interfaces and capabilities vary by archive/source and privilege. Do not equate a user-visible backup download with full account restore. Sources: [Backup Wizard](https://docs.cpanel.net/cpanel/files/backup-wizard/), [Transfer or Restore Account](https://docs.cpanel.net/whm/transfers/transfer-or-restore-a-cpanel-account/).

## Competitive capability map (official product pages/docs; not feature parity claims)

| Product | Observed public positioning/capability | ORBICORE implication |
|---|---|---|
| cPanel/WHM | Account panel and privileged server-level transfer/restore tools | Respect capability split between account UAPI and WHM/root; cPanel is initial adapter |
| Enhance | API-first multi-server control panel, server roles, hosting automation and cPanel migration messaging | Competes more directly as hosting control plane; ORBICORE's cross-provider management and truthful permission map must be differentiated |
| Plesk WP Toolkit | WordPress install/manage/migrate flows; API docs are surfaced from product UI | Treat WordPress lifecycle as separate connector and validate edition/extension/permission differences |
| RunCloud | Server/application management, backups, restore and API docs | Compare actual provider adapter contracts and restore behavior; avoid asserting shared-hosting compatibility |
| ManageWP | WordPress portfolio, backups, client assignment and migration | Strong WordPress workflow benchmark; not evidence of cPanel account-level orchestration |

Sources: [Enhance features](https://enhance.com/product/features), [Enhance migration](https://enhance.com/product/migrate-from-cpanel), [Plesk WP Toolkit](https://docs.plesk.com/en-US/obsidian/administrator-guide/website-management/wp-toolkit.73391), [Plesk API support note](https://support.plesk.com/hc/en-us/articles/12388332596631-Where-can-I-find-the-full-documentation-of-the-WP-Toolkit-API-in-Plesk), [RunCloud documentation](https://runcloud.io/docs), [ManageWP getting started](https://managewp.com/guide/getting-started/), [ManageWP backup](https://managewp.com/features/backup/).

## Stack and design options

- NestJS documentation describes database-agnostic integrations and a BullMQ integration backed by Redis; jobs are persisted in Redis and can resume after process restarts. This is a fit for the production worker path but adds Redis operations. Sources: [Nest database](https://docs.nestjs.com/techniques/database), [Nest queues](https://docs.nestjs.com/techniques/queues).
- Laravel offers queue drivers including database and Redis, and is a serious PHP alternative; it shares less application code with a React/TypeScript desktop/mobile client. Source: [Laravel 13 queues](https://laravel.com/framework/docs/queues).
- Node v24.22.1 docs classify built-in `node:sqlite` as experimental. If used for the local prototype, this limitation must remain explicit; use a stable database adapter for shipping. Source: [Node v24.22.1 SQLite API](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).
- Docker Compose can deploy services with a production override and remote Docker host, but Docker is not installed in this current environment. Source: [Docker Compose production](https://docs.docker.com/compose/how-tos/production/).
- shadcn/ui and Mantine publish MIT licensing; Headless UI is a primitive alternative. Stars/update counts are only one quality signal and exact UI dependency selection remains open pending screen/accessibility evaluation. Sources: [shadcn/ui](https://github.com/shadcn-ui/ui), [Mantine](https://github.com/mantinedev/mantine), [Headless UI](https://github.com/tailwindlabs/headlessui).

## Decisions, confidence, and unknowns

| Finding | Confidence | State |
|---|---|---|
| UAPI account-level access differs from privileged WHM transfer | High; official docs | Factored into adapter/permission boundary |
| Shared-host remote DB can be disabled by provider | High; official docs | Mark feature conditional/unknown until discovered |
| TS modular monolith is best initial API/client reuse fit | Medium; weighted engineering estimate | ADR-0001; validate against install/resource evidence |
| React design-system dependency | Low-medium | Pending first screen and a11y review |
| Real provider auth scopes, rate limits, UAPI version compatibility | Unknown | Requires authorized sandbox |
| VPS minimum CPU/RAM/disk, performance, S3 cost/egress | Unknown | Measure later; do not publish estimates as facts |
| Persistent background agent automation on target host | Unknown/provider-specific | Opt-in only; no claim from directive alone |
