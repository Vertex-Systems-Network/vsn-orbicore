# Research checkpoint: WCAG 2.2 SC 1.4.12 automated text-spacing regression

**Date:** 2026-11-23  
**Applicable tasks:** ORB-009 and ORB-018

## Exact reference

W3C [WCAG 2.2 SC 1.4.12: Text Spacing](https://www.w3.org/TR/WCAG22/#text-spacing) requires that user overrides of specific text-spacing properties not lose content or functionality: **line height 1.5x, paragraph spacing 2x, letter spacing 0.12x and word spacing 0.16x of font size**. The official [Understanding page](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html) explains lost content and cropped/overlapped text failure mechanisms; these are not synonymous with merely measuring horizontal document width.

## Selected CI representation

Use the real native browser page-zoom fixture from [native zoom research](2026-11-23-native-chromium-zoom-automation.md). At 400% Chromium tab zoom and a measured 320px CSS viewport, temporarily apply `line-height:1.5 !important;letter-spacing:.12em!important;word-spacing:.16em!important` and `body p {margin-bottom:2em!important}`. Measure 12 core bootstrap/heading/subtitle text areas for computed thresholds and scroll/clipping; remove injected CSS before continuing. The app's production styles remain unchanged. In the follow-up checkpoint, the 11px bootstrap paragraph reported a 22px margin, measured but not independently asserted. This is **sampled machine evidence only**—no exhaustive content/focus overlap scan, manual WCAG determination, 200% text-only resizing, mobile assistive device or alternate browser evidence. See [functional CI report](../TEST_EVIDENCE/2026-11-23-orb-009-018-text-spacing-400-browser.md).
