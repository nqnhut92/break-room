# 0011 — Phones and tablets join only from the Home Screen app

- Status: Accepted
- Recorded: 2026-11-06
- Supersedes / superseded by: none

## Context

In a browser tab the game shares the screen with browser bars, which cost height on landscape phones and get in the way of the joystick and buttons. A dismissible "Add to Home Screen" card shown after joining (commit `acea85c`) could be cancelled by office notices on iPhone and iPad. An in-game hint was also easy to miss or ignore. The product requirement is to require the Home Screen app rather than suggest it.

Constraints: web pages cannot tell whether the icon already exists, only whether the current launch came from it (iOS `navigator.standalone` or app `display-mode`). iOS has no install API in any browser. Device observations (November 2026): Edge on iPhone offers Add to Home Screen and its icon behaves like Safari's; Edge on iPad does not offer it.

## Decision

On touch devices (`pointer: coarse`, or iOS/iPadOS including iPads that report a Mac), a launch that is not standalone gets a full-screen prompt like the rotate prompt, with the install steps and no join form; nothing can join from the tab, including the reload auto-join. Android gets the browser's install dialog through `beforeinstallprompt` when offered, otherwise menu steps; iPads in another browser are sent to Safari with a copy-link button. Desktops are not gated. Automated browsers (`navigator.webdriver`) are exempt so the existing touch test suites can join.

The launch check is shared by the initial page and runtime gate. App modes include standalone, fullscreen, minimal-ui and window-controls-overlay; mode changes, page restoration and foregrounding re-evaluate it. Installation acceptance does not bypass the gate in the original browser tab.

The gate is client-side (`public/game.js`, plus an inline first-paint class in `public/index.html`); the server does not enforce it.

## Alternatives

- A dismissible card on the join screen or in the office: tried first; easy to miss or ignore.
- A permanent card that still allows playing in the tab: less friction, but does not meet the Home Screen-only product requirement.
- A gate with a small "play in the browser anyway" link: considered and rejected because it permits tab-based play.
- Server-side enforcement: the server cannot tell a Home Screen launch from a tab reliably; not attempted.

## Consequences

- Players whose browser cannot add a Home Screen icon (for example an iPad browser that will not hand over to Safari) cannot play on that device.
- If a platform's Home Screen launch reports neither the iOS standalone flag nor an app display mode, its players are locked out; this must be checked on physical devices (iPhone Safari and Edge, iPad Safari, Android Chrome).
- iOS keeps Home Screen app storage apart from Safari: guest identity and Google sign-in made in Safari do not carry over, and the Google sign-in round trip must be checked inside the Home Screen app.
- Revisit if players report being locked out, or if the Home Screen-only product requirement changes.

## References

- Code: `public/game.js` (Home Screen gate), `public/index.html`, `public/style.css`.
- Guide: [Mobile — Home Screen gate](../MOBILE.md#home-screen-gate).
- Tests: `npm run test:install` (Chromium emulation, not WebKit).
