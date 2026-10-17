# Composite device color scheme

## SPEC-COMPOSITE-DEVICE-THEME-001

Composite documents (`/composite/*`) and embedded Cernere documents follow
the browser's device color preference using `prefers-color-scheme`.
Light mode supplies light surfaces, dark text and contrast-safe semantic colors;
dark mode retains the existing dark palette. Native controls use the matching
`color-scheme`. Media query changes apply immediately without reload or listeners.

Embedded registration, recovery and consent documents keep the same policy after
navigation. No credential, login flow, rounded card geometry or host-page style changes.
Primary button foreground follows its palette. Other standalone Cernere documents
retain their existing styles. Verify light/dark and live preference changes in a browser.
