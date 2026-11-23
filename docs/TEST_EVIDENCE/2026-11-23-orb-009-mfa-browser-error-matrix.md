# ORB-009 — Browser MFA error semantics, recovery and non-attribution

**Date:** 2026-11-23  
**PR:** [#45](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/45)  
**Functional SHA:** `75337b13b7723e1f809ed1f092e1310823b458bd`

## GitHub-hosted results

- [PR CI #45088700533](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45088700533) and [branch CI #45088674901](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45088674901): **success** at the exact functional SHA.
- [Hosted Chromium/WebAuthn browser #45088700892](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45088700892): **success**. Node `v24.22.3`, Chromium `159.0.8154.6`. Evidence ZIP: [artifact #14780490786](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45088700892/artifacts/14780490786), SHA-256 `c8b8439d40097732ff07aa39ebaaa4fdcf182ed9a9b9d2f5149fe54e9c5604b6`.
- Chromium runtime verified `genericBadCredentialsFieldsUnattributed:passed`, `mfaRateLimitServiceChallengeErrorsUnattributed:passed`, `mfaRealWrongCodeFieldAssociation:passed` and `mfaBrowserRecoveryCodeConsumedOnce:passed`. Earlier WebAuthn virtual-authenticator, reduced-motion, keyboard/focus, narrow viewport, tenant isolation and account/site 503/retry browser coverage also passed.
- Standard CI: **113 Node tests passed, 0 failed**, lint/typecheck, scoped secret/license checks (243 recognized Git-tracked text files and zero pattern findings), official CycloneDX 1.5 schema of 189 npm-lockfile components, `npm audit` with **0 vulnerabilities reported at that time**, build/smoke/doctor gates all success.

## Specific UI and security checks

1. The `AuthGate` MFA input is now marked `aria-invalid` and linked to `#auth-error` **only** after a server `invalid_mfa_code`. A 429 response instead shows a retry-later message; 503 shows temporary service-unavailable guidance; `invalid_mfa_challenge` directs the user to restart the sign-in flow without blaming the code.
2. A separately authenticated Chromium context logs into the **second in-memory synthetic organization**, first with wrong credentials (generic denial; no email/password field blamed), then with correct credentials and opens the **actual MFA enrollment UI**.
3. A deterministic fixture-only TOTP clock permits real browser enrollment with a valid code and obtains single-use recovery codes solely in process memory. No codes/seeds are printed, put in screenshots, or included in artifact metadata.
4. After signout, the browser verifies password-only authentication yields a challenge but **no session**. Mocked 429, 503 and invalid/expired challenge responses each produce distinct actionable text and no code-specific error state. The restart action clears the previous alert.
5. A **real** API `invalid_mfa_code` response marks and associates the MFA field. A saved single-use recovery code completes the next challenge. Reusing the same recovery code after a subsequent sign-out fails without creating a session.

## Limitations

- In-memory SQLite fixture, local HTTP, synthetic users, TOTP fallback and a Chromium virtual-authenticator environment; **not** external identity, live provider MFA, production key custody, independent operator KMS, distributed rate limiting or complete multi-node session revocation.
- The 429, 503 and invalid challenge cases are **browser transport mocks** validating UI response handling, not actual backend rate-limit/outage fault injection. The wrong code and one-time recovery rejection use the real local API.
- This **does not certify WCAG**. Actual 200%/400% page zoom, manual screen-reader/contrast/touch testing, comprehensive form errors and physical passkeys remain open. ORB-009 stays `testing/browser_tested`.
- Check final documentation-head CI and postmerge `main` independently.
