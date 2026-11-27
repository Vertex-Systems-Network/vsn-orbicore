# ORB-002 — strict UAPI authorization and credential header boundary

Date: 2026-11-27 UTC. Base: main 36975f5b3b09645f05b9fdc58adab05716851f64 (PR #83 merged). Stage: branch implementation; hosted CI pending.

The adapter previously accepted truthy nonboolean authorization values and coerced credential fields into a header. Its denial reason also interpolated an untrusted host before host validation. This contradicts the explicit owner-authorization and redaction requirements in AGENTS.md.

- Require the boolean true and nonempty string credential fields with printable ASCII, no whitespace or controls, and no username colon (the credential separator).
- Use a static denial reason without host, username or token interpolation. Do not change mock profiles or enable the live adapter.
- Two injected-fetch tests assert nonboolean grants and malformed fields cause zero calls, no reflected input, and valid synthetic credentials preserve the existing path.

Limitations: this is an input-shape boundary, not proof of owner consent, a production credential policy, or live provider compatibility. The conservative header format may reject unusual provider credentials; validation against a real authorized sandbox is still required. No external requests or tokens used. ORB-002 testing/mock_tested, ORB-006 and ORB-019 blocked/none, ORB-010 in_progress/unit remain unchanged.

## Hosted PR #84 functional-head evidence

GitHub Actions on `8f9a14c2bab8b01233b3174fbd44f18d7475cbea` (2026-11-27 UTC):

- [Standard CI #45997879556](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997879556) and [push CI #45997851231](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997851231): 203/203 Node tests passed, zero failures/skips/cancellations; both new authorization regressions passed. Lint, plan alignment, security, SBOM/CycloneDX, audit, build, smoke and doctor succeeded.
- [Browser #45997879557](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997879557): Chromium, Firefox and WebKit 3/3 succeeded.
- [Trusted ledger #45997879319](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45997879319): succeeded; 20 tasks, 6 verified, 9 testing, 3 in progress, 2 blocked.
- PG16/Redis7 service workflow not triggered for this adapter-only change; no new service evidence claimed.

Final evidence-only head verification and merge pending. No live provider or authorization provenance proof; lifecycle unchanged.
