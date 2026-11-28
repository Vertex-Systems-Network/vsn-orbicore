# ORB-002 — UAPI response and capability profile validation batch

Base main 0eb4a25b1d3629074504537967dcf08faa17bc6d; PR #95 final standard, service, browser and ledger checks passed before merge. Hosted verification pending.

Two independent commits reject non-array/non-null UAPI error metadata even with numeric success status; preserve omitted/null/empty-array error compatibility; test direct and wrapped capability, inventory and health responses without network calls. Validate profile names against own properties only, reject explicitly invalid sandbox inputs before writes, preserve documented default for omitted input and mock adapter fallback. Persisted unknown profile fallback for account capability retrieval is empty; migration permission checks fail closed. Existing mock adapter fallback remains synthetic only.

No live provider credentials, DNS transport changes, production grant or lifecycle promotion. GitHub-only validation applies. 
