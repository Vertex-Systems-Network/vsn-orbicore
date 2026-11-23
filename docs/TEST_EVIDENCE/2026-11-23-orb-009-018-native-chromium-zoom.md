# ORB-009 / ORB-018 — Real Chromium browser zoom 200%/400% and sidebar reflow

**Date:** 2026-11-23  
**PR:** [#47](https://github.com/Vertex-Systems-Network/vsn-orbicore/pull/47)  
**Functional head SHA:** `ce945a86c5739902051b3abb844b22af7543b21b`  
**Method:** Chromium **browser native** `chrome.tabs.setZoom/getZoom` through a temporary Manifest V3 extension, not CSS `zoom`, pinch scaling or merely shrinking the viewport.

## Hosted results

- [PR CI #45090538238](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45090538238) and [branch CI #45090534355](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45090534355): **success** at exact functional SHA; **113 Node tests passed, 0 failures**. Lint, TS, security/license gate (**248 eligible tracked text files**, no high-confidence findings or unknown licenses), official CycloneDX schema validation (**189 npm-lockfile components, 3 malformed fixtures denied**), `npm audit` (**0 vulnerabilities at run time**), build, smoke and doctor also passed.
- [Hosted browser CI #45090538186](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45090538186): **success**, Chromium `159.0.8154.6`, Node `v24.22.3`. Preexisting WebAuthn virtual device, MFA recovery, two-tenant isolation, viewport/keyboard/error and sampled contrast browser checks all passed *before* the native-zoom check.
- Browser evidence ZIP [artifact #14780887180](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45090538186/artifacts/14780887180), SHA-256 `d02932dac61b73506142604367f74ba5d2d1836cebd91320a2c07e9d06702853`. It includes `native-zoom-runtime.json` plus a screenshot of the *authenticated synthetic Websites view* at real 400% zoom. No bootstrap, password, TOTP or recovery-value UI screenshot taken.

## Native zoom measurements

The browser's physical viewport is held at **1280 × 960** throughout. Both `chrome.tabs.getZoom()` and the measured DOM viewport agree:

| Native zoom | Auth CSS viewport width | Dashboard CSS viewport width | devicePixelRatio | Document width on auth and dashboard |
| --- | ---: | ---: | ---: | ---: |
| 100% | 1280px | 1280px | 1 | 1280px |
| 200% | 640px | 640px | 2 | 640px |
| 400% | 320px | 320px | 4 | 320px |

At all three levels, the HTML document had exactly one `main` landmark and **zero measured page-wide horizontal overflow** in the tested auth and dashboard states. At each zoom level the script clicked and verified `aria-current=page` for Overview, Websites, Hosting accounts and Jobs & activity. At 200% and 400%, keyboard Tab from email reached the password input; a real synthetic first-owner bootstrap succeeded even at 400%.

## Regression discovery and fix

- **Baseline failing browser run:** [#45090329040](https://github.com/Vertex-Systems-Network/vsn-orbicore/actions/runs/45090329040) at SHA `53549e7136aa0c8d61c7c44532560b30d79a1381` exposed a genuine native-400% UI failure. Playwright could identify **Jobs & activity**, but its click failed because the collapsed fixed sidebar placed the navigation item **outside the visual viewport** and had no independently scrollable region.
- **Patch:** `apps/web/src/ui/styles.css` now allows `.sidebar` to scroll vertically below 960px, with `overscroll-behavior-y:contain`, a thin scrollbar, and nonshrinking nav/footer sections; no broad palette/layout refactor.
- **Measured fix:** at 400% the sidebar is **240 CSS px available height** but **651 CSS px content height**, `overflowY:auto`. Clicking the formerly inaccessible bottom link scrolls it within the sidebar and makes it fully visible; runtime field `bottomNavigationReachableAt400:passed`. Both the existing and native zoom browser checks passed the fixed head.

## Sources and limitations

- [W3C WCAG 2.2 SC 1.4.10 Understanding Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow) explains 1280 desktop width / 400% → ~320 CSS px and local tabular two-dimensional scrolling exceptions.
- [Official Playwright Chrome extensions guide](https://playwright.dev/docs/chrome-extensions) documents persistent-context headless `chromium` channel with a temporary extension.
- [Chrome tabs API reference](https://developer.chrome.com/docs/extensions/reference/api/tabs) documents native `setZoom/getZoom`.

**Scope:** one GitHub-hosted Chromium build, temporary local SQLite/auth/demo fixtures and four dashboard sections. Native page zoom and no **page-wide** horizontal overflow were measured, not full WCAG conformance: the test does not exhaustively evaluate all form copy, every dashboard panel, local tabular scrolling, text clipping, focus occlusion, 200% text resize behavior across breakpoints, other browsers, screen readers, physical touch targets, OS magnification, production identity or live hosting/provider access. No production readyness certification. ORB-009/018 stay `testing/browser_tested`. Verify final documentation-head and postmerge `main` CI separately.
