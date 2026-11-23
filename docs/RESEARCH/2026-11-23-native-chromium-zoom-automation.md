# Research checkpoint — Native Chromium page zoom vs viewport emulation

**Date:** 2026-11-23  
**Use case:** ORB-009 / ORB-018 authenticating 200% / 400% native browser page zoom in GitHub CI.

## Authoritative reference check

- W3C [WCAG 2.2 Understanding SC 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow): a 1280 CSS px desktop layout zoomed to 400% commonly yields a **320 CSS px effective viewport**; two-dimensional scrolling is acceptable only for genuinely two-dimensional content (tables/graphics), not arbitrary page text and navigation.
- Microsoft [Playwright official Chrome extensions documentation](https://playwright.dev/docs/chrome-extensions): Chrome Manifest V3 test extension requires Chromium with a persistent browser context; full `chromium` channel supports headless extension testing; the legacy headless shell does not provide this mechanism.
- Google [Chrome Extensions tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs): `tabs.setZoom(tabId, zoomFactor)` sets actual browser tab zoom; `tabs.getZoom(tabId)` reads the factor back.
- Playwright [emulation guide](https://playwright.dev/docs/emulation): changing viewport size or device scale is device/viewport emulation and must be labeled as such; it is not by itself proof of browser-native page zoom.

## Selected approach

Use a throwaway local-only MV3 extension with `tabs` permission, no content scripts and no host network permission, loaded into an isolated persistent `chromium` profile during CI. From Playwright's extension service-worker context invoke native `chrome.tabs.setZoom/getZoom` and measure effective CSS viewport width and DPR on the page. Require both the native API and the measured page geometry to agree; reject no-ops. Existing 320px responsive viewport tests remain valuable **but are not relabeled as native zoom**. No external provider calls or credentials. Full observed results in [the CI evidence](../TEST_EVIDENCE/2026-11-23-orb-009-018-native-chromium-zoom.md).
