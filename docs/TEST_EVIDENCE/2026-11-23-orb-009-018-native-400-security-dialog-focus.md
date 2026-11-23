# ORB-009 / ORB-018 — Native Chromium 400% security-dialog focus and scrollport evidence

**Date:** 2026-11-23  
**PR:** [#48](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/48)  
**Functional SHA:** `d5103e72561982d272fa36544404fe005f03cf43`

## CI result and source

- [PR CI #45092426138](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092426138) and [branch CI #45092422244](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092422244): **success** at exact functional head. **113 Node tests, 113 passed, 0 failed**, lint/typecheck, build, smoke and doctor; tracked-text security scanner checked **250 eligible files** with zero high-confidence secret matches or unreviewed license metadata; official CycloneDX schema 1.5 verified 189 locked npm components; npm audit returned 0 findings on that run.
- [Hosted Chromium and WebAuthn CI #45092426123](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092426123): **success** at `d5103e72561982d272fa36544404fe005f03cf43`, Node 24.22.3 / Chromium 159.0.8154.6. Existing virtual authenticator, MFA negative/recovery, multi-tenant, keyboard, 320-768px viewport, dark/light sampled contrast, and actual Chrome 100/200/400% native page-zoom gates all passed.
- [Browser evidence artifact #14782260527](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092426123/artifacts/14782260527), SHA-256 `88b4c8794788f18b0f7e4b56c55ab8be7f74d8a796dbf0d8f2a561e91070a33f`. No security-dialog screenshot or typed credential is captured; JSON contains only measured coordinates, focus flags, viewport sizes and synthetic fixture metadata.

## What was actually tested

An isolated localhost SQLite synthetic owner logs in, then Chromium's `chrome.tabs.setZoom/getZoom` is set to **400%**. With the original physical browser viewport held at 1280×960 px, the measured effective CSS viewport is **320×240 px** (`devicePixelRatio:4`), with `documentWidth:320`.

Within the actual `role=dialog` **Authenticator setup** security UI, the script tests:

1. Focus automatically enters the close control; its computed rectangle is completely inside **both** the browser viewport and the independently scrollable MFA modal viewport.
2. Programmatic keyboard focus can fully expose all relevant controls at 400%: close, passkey toggle, current-password input, enabled **Start enrollment** button, expanded passkey password input, and enabled **Register passkey** button. Each checked element had `active:true`, `insidePanel:true` and `insideBrowser:true`. No global document-width overflow.
3. Real `Shift+Tab` from the first focusable modal control wraps inside the dialog, and real `Tab` returns to the close button without moving focus to background content.
4. Real `Escape` dismisses the dialog and returns focus to the **visible**, scrolled-to sidebar opener: `returned:true`, `inSidebarView:true`.
5. The security dialog's effective visible scrollport was **214 CSS px** with **388 CSS px** of initially scrollable content, increasing to **671 CSS px** after expanding passkey setup. All six focused controls were brought fully into the visible scrollport, despite the short effective viewport.

**Test-only correction:** The first browser check at SHA `6e0379a5`, [run #45092267476](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092267476), failed because the test attempted to focus a deliberately **disabled** Start enrollment button before filling the password. The browser correctly did not focus it; this was a test fixture sequencing error, **not an observed application accessibility failure**. The updated test first fills a synthetic password solely to enable that control; it never submits or logs the password, and [run #45092300079](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45092300079) passed. The final `d5103e72561982d272fa36544404fe005f03cf43` additionally asserts real Tab/Shift+Tab traversal and passed.

## Limitations

- **No user-facing production code changed** in PR #48. This is a *new regression gate* for an already implemented dialog and sidebar, extending PR #47 native zoom proof.
- Focus bounds and keyboard tab trapping were proven only for selected controls and scenarios in **GitHub-hosted Chromium** with a synthetic SQLite session. This is **not** a full WCAG 2.2 AA audit, full text-resize clipping inspection or a screen-reader test. No Firefox/WebKit, physical accessibility device, mobile touch size, complete UI state/contrast sweep, provider or production identity was tested.
- ORB-009 / ORB-018 remain `testing/browser_tested`; independent manual accessibility review and production cluster/provider prerequisites remain open. Final docs-head and postmerge `main` CI must still be checked.
