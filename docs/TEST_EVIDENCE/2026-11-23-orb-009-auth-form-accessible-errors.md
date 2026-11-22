# ORB-009 — Accessible bootstrap, passkey and MFA field-error associations

**Date:** 2026-11-23  
**PR:** [#42](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/42)  
**Functional tested SHA:** `c169e199db4c57496b35485614c59b87d923bb28`

## Hosted verification

- [PR-head CI #45082301543](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45082301543) and [branch-head CI #45082287276](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45082287276): **success**.
- [Chromium WebAuthn/browser run #45082301534](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45082301534): **success**, Node `24.22.3`, Chromium `159.0.8154.6`. The exported runtime reports `authBootstrapTokenErrorAssociation:"passed"`, `passkeyMissingEmailErrorAssociation:"passed"`, and previous passkey/keyboard/two-tenant/503/retry/viewer/narrow viewport checks passed.
- [Browser evidence artifact #14778095693](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45082301534/artifacts/14778095693), ZIP digest `sha256:1328f1d748a15c9337de17570480091ec4bbd75e5c77ea8a634487552419d8ba`. Synthetic local fixtures only.

## Behavior

- Auth form errors expose one stable error element `id="auth-error"`, `role="alert"`. When a **known** input fails, the relevant field is marked `aria-invalid=true` and points to the visible message with `aria-describedby="auth-error"`.
- Invalid one-time bootstrap tokens are associated **only** with the token input. The browser verifies the unrelated email is not incorrectly flagged.
- A passkey sign-in attempt with blank email associates the instructional error to the email field; the browser later provides an address and passes the existing virtual-WebAuthn authentication flow.
- Bootstrap password policy errors associate to password, and failed MFA challenge input associates to the code field in the implementation. These two **specific paths have not been separately browser-verified**.
- Generic bad credential responses deliberately avoid identifying which of email/password was incorrect. Per-attempt invalid-field state resets on new submit, passkey start, or MFA restart.

## Limitations

- This is partial field-level accessibility with host Chromium assertions, **not** a manual screen-reader study, full WCAG conformance, full color-contrast/target-size certification, actual 200%/400% browser zoom or comprehensive forms audit.
- Production authentication and live hosting still require independent controls. ORB-009 remains `testing/browser_tested`.
- Final documentation-head and postmerge `main` CI should be checked separately.
