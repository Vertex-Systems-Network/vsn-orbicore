# UX specification — initial operations dashboard

## Authentication entry

First run uses a setup form with a one-time token, owner email, and new password. Later visits use the email/password sign-in form. Show generic authentication errors, announce errors accessibly, and never reflect a supplied password or token. The one-time token is read by the local operator from `.data/first-admin.token`; the application must not display or log it. This is an early local prototype flow, not a production-ready identity or recovery experience. Owner/admin settings provide a password-reauthenticated TOTP compatibility enrollment; the UI labels it as not phishing-resistant and displays one-time recovery codes once. Sign-in adds a second-factor challenge when enabled. Recovery notification is not delivered: the API records a blocked outbox status while no contact-verification/delivery adapter exists. WebAuthn/passkey setup, authenticator rebinding and accessible browser verification remain unimplemented.

## Information architecture

Primary order: organization/client context -> hosting accounts -> websites -> operations. Global nav: Overview, Accounts, Websites, Migrations, Storage, Jobs, Settings. Global search/command palette and alerts are later slices. The first page emphasizes current account/site health, stale data, recent jobs and a safe refresh action.

## Design direction

Create an original infrastructure workspace: warm neutral canvas, deep ink navigation, restrained emerald/cyan state colors, crisp sans typography, clear numeric hierarchy and dense but readable tables. Avoid generic SaaS gradients and competitor screenshot copying. Define tokens/components in the Design Bank before scaling screens. Provide light/dark modes when the component system supports contrast parity.

## Screen states

Each key screen must specify populated, loading, empty, network error, stale data, permission restricted, and retry states. Tables need keyboard sort/filter, visible focus, proper headings, accessible labels, stable row identity and explicit last-updated timestamps. Destructive controls remain separate from routine refresh actions and need preview/reversal guidance.

## Accessibility and design gate

Target WCAG 2.2 AA. Check color contrast, keyboard-only use, focus order, reduced motion, screen-reader names, errors tied to fields, table semantics and minimum touch target on narrower screens. Current proof should be desktop-first; mobile design follows the user directive's later priority but must not break basic responsive access.
