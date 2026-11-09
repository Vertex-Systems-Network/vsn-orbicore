# UX specification — initial operations dashboard

## Information architecture

Primary order: organization/client context -> hosting accounts -> websites -> operations. Global nav: Overview, Accounts, Websites, Migrations, Storage, Jobs, Settings. Global search/command palette and alerts are later slices. The first page emphasizes current account/site health, stale data, recent jobs and a safe refresh action.

## Design direction

Create an original infrastructure workspace: warm neutral canvas, deep ink navigation, restrained emerald/cyan state colors, crisp sans typography, clear numeric hierarchy and dense but readable tables. Avoid generic SaaS gradients and competitor screenshot copying. Define tokens/components in the Design Bank before scaling screens. Provide light/dark modes when the component system supports contrast parity.

## Screen states

Each key screen must specify populated, loading, empty, network error, stale data, permission restricted, and retry states. Tables need keyboard sort/filter, visible focus, proper headings, accessible labels, stable row identity and explicit last-updated timestamps. Destructive controls remain separate from routine refresh actions and need preview/reversal guidance.

## Accessibility and design gate

Target WCAG 2.2 AA. Check color contrast, keyboard-only use, focus order, reduced motion, screen-reader names, errors tied to fields, table semantics and minimum touch target on narrower screens. Current proof should be desktop-first; mobile design follows the user directive's later priority but must not break basic responsive access.
