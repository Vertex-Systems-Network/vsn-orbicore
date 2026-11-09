# Security policy

## Current security status

This repository is an early development project. It is not production-ready and does not yet implement authentication, tenant authorization, secret storage, provider connectivity, or a vulnerability intake process. Do not connect production hosting accounts or place real customer data in the current build.

## Reporting

Until a private security contact is configured, do not publish exploit details for a suspected vulnerability. Notify the repository maintainers through a private channel. Add a monitored security contact and response SLA before production use.

## Required controls before external connections

Follow `docs/SECURITY_THREAT_MODEL.md`: TLS validation, encrypted secret references, least privilege, connector egress allow-lists, SSRF/DNS-rebinding defenses, tenant scoping, audit redaction, rate limits, safe retries, backup/restore gates, and revocation procedures. See the master directive for the complete minimum security program.
