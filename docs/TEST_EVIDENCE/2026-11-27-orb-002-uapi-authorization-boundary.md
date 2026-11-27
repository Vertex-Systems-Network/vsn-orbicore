# ORB-002 — strict UAPI authorization and credential header boundary

Date: 2026-11-27 UTC. Base: main 36975f5b3b09645f05b9fdc58adab05716851f64 (PR #83 merged). Stage: branch implementation; hosted CI pending.

The adapter previously accepted truthy nonboolean authorization values and coerced credential fields into a header. Its denial reason also interpolated an untrusted host before host validation. This contradicts the explicit owner-authorization and redaction requirements in AGENTS.md.

- Require the boolean true and nonempty string credential fields with printable ASCII, no whitespace or controls, and no username colon (the credential separator).
- Use a static denial reason without host, username or token interpolation. Do not change mock profiles or enable the live adapter.
- Two injected-fetch tests assert nonboolean grants and malformed fields cause zero calls, no reflected input, and valid synthetic credentials preserve the existing path.

Limitations: this is an input-shape boundary, not proof of owner consent, a production credential policy, or live provider compatibility. The conservative header format may reject unusual provider credentials; validation against a real authorized sandbox is still required. No external requests or tokens used. ORB-002 testing/mock_tested, ORB-006 and ORB-019 blocked/none, ORB-010 in_progress/unit remain unchanged.
