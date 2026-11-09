# Feasibility and permission matrix (initial)

`Unknown` means not established by the current fixture or public docs alone. Every connection must discover actual provider capabilities at runtime.

| Connection mode | Read inventory | Site-level files/DB | Full account transfer | Remote DB | Primary risk/constraint |
|---|---|---|---|---|---|
| cPanel username/password | Provider/API configuration dependent | Only permitted UAPI/UI features | No inference of WHM/root | Host setting required | High credential exposure; avoid as default |
| cPanel API token | UAPI functions under account context | Function and provider policy dependent | Not equivalent to WHM root | Host setting required | Token lifetime/revocation and function authorization need testing |
| SFTP | Directory/list/read as granted | File transfer only; DB not implied | No | No, except separate endpoint | Host key verification, path and ownership semantics |
| SSH account | Command capability varies by shell and policy | Possible if explicitly enabled | Not unless `sudo`/`su` root privilege is granted | Connectivity still separate | Command injection, shell restrictions, host key and least privilege |
| WHM reseller | WHM functions allowed to reseller | Account features by privilege | Specific operation depends on source/destination and privilege | WHM configuration | Role/feature permissions vary by provider |
| WHM root / authorized sudo | Broad WHM operations | Provider-supported account/site actions | Transfer Tool requires root or sudo/su access | Can configure profiles/hosts | Highest impact; explicit scope and audit required |
| Provider API | Provider-defined | Provider-defined | Provider-defined | Provider-defined | No generic API or capability guarantee |
| DNS registrar/Cloudflare | DNS only by granted zone | Not site storage/DB | No | No | TTL, DNSSEC, MX and ownership; cutover requires separate approval |
| S3-compatible object storage | Object metadata as key permits | Object operations only | Not account migration | No | Bucket scope, egress costs, ACL/public exposure, versioning/restore |
| WordPress companion plugin/WP-CLI | WP capabilities granted by site | WP content/admin level explicitly granted | No server account control | WordPress DB indirectly | Plugin compromise, nonce/auth, update rollback and site-specific consent |

## Feasibility decisions

- cPanel UAPI provides API access to cPanel feature functions; API tokens are used with the cPanel username and UAPI endpoint. Exact function access and host configuration require live testing.
- WHM Transfer Tool's documented full account transfer path needs source-server root or `sudo`/`su` privilege. The product must label it unavailable without that privilege and offer site-level paths only where separately supported.
- cPanel Remote Database Access can be enabled or disabled by the hosting provider. An account on another server is not an automatic database host.
- A normal second shared-hosting account is not a pooled filesystem. Object storage or authorized dedicated infrastructure is the general target for offload.
- Live connector feasibility remains `unknown` until actual account capability discovery and sandbox test evidence exist.
