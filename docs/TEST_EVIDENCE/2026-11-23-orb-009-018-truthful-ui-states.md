# ORB-009 / ORB-018 — Truthful workspace states, 320px reflow and viewer controls

**Date:** 2026-11-23  
**PR:** [#38](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/38)  
**Functional tested SHA:** `69dc14ce168707b0bff9eb193062a2fecea204b5`

## Hosted GitHub evidence

- [PR standard CI #45080158115](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080158115): **success** at functional SHA. Locked Node 24 install, unit tests, lint/typecheck, build, security/SBOM, audit and local smoke/doctor as defined by the workflow.
- [Branch CI #45080153068](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080153068): **success** at the same functional SHA.
- [Chromium E2E #45080158093](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080158093): **success**, Playwright and virtual CTAP2 on isolated synthetic SQLite/local API. Existing WebAuthn registration, authentication, replay and MFA focus checks remained green.
- [Synthetic browser artifact #14777235381](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45080158093/artifacts/14777235381), `orb-012-browser-evidence`: `runtime.json`, synthetic-only dashboard and responsive 320/390/640/768 screenshots; GitHub artifact digest `sha256:fb90343ddc99c23f41c66c94b03a02a93ecf0e31fcce4520687afa15d4be721b`. Screenshots are **not** a human accessibility/visual review.

## Implementation and exercised assertions

1. **Fail-closed UI state:** Both `/api/overview` and `/api/sites` must succeed before changing the combined workspace snapshot. On a failing secondary 503, the last successful snapshot remains visible with an explicitly stale warning and a retry. Browser tests inject failed refresh POST and secondary GET, verify rejection messaging and preserved metrics, then verify recovery.
2. **Refresh submission:** Every `/api/jobs/refresh` response status is checked; partial accepts are never called an unchanged inventory or all-success. Non-operator roles cannot queue refresh from the UI. The browser fixture downgrades the owner to a viewer, verifies the disabled refresh and absent account-creation control, then restores the fixture role.
3. **Account-specific state:** Previous account site rows are cleared when selection changes. A failed account-site request is a distinct alert with retry, not fabricated empty inventory. The account selection is reconciled to the current account set and cleared at logout to avoid stale cross-session selections. These latter code paths need further focused cross-tenant browser regression.
4. **Responsive and motion:** Real Chromium CSS viewport checks at 320, 390, 640 and 768 pixels confirm named collapsed navigation and absence of page-wide horizontal overflow. A `prefers-reduced-motion: reduce` assertion verifies spinner animation suppression. A filtered search with no matching accounts shows an empty state distinct from network failures.
5. **Truthful fixture labeling:** Removed hard-coded agency name and unconditional worker-ready claim from local-only workspace affordances.

## Boundaries and open gates

- ORB-009 and ORB-018 remain `testing/browser_tested`, not verified or WCAG 2.2 AA conformant.
- 320px CSS reflow is only a **layout proxy**, not direct 200%/400% zoom testing. Full manual keyboard/screen-reader review, color contrast, error field association, touch target measurements and broader device/browser/permission matrices remain open.
- No production credentials, provider actions, hosting sandbox, PostgreSQL authority switch, off-host backup or live customer data were accessed. Service-backed PostgreSQL/Redis matrix was not rerun for this UI-only change.
- Final docs-head CI and postmerge `main` CI must be separately checked.
