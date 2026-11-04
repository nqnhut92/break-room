# Gameplay

English · [Tiếng Việt](GAMEPLAY.vi.md) · [Documentation](README.md)

## Playing together

The game has **two fixed servers**, **BR-1** and **BR-2**, with at most 20 players each. The join screen shows "x online" per server, coloured green (under 50% full), orange (from 50%) and red (from 80%), and preselects the busiest server that still has room. To play with colleagues, pick the same server; the "Copy server link" button produces `/?room=br-1` or `/?room=br-2`. There are no private rooms: an unknown room name in an old link falls back to the first server. Rename or add servers in the `ROOMS` list in `lib/world.js` (`id` lowercase ASCII, `name` is the display name).

The join screen also asks for a company role (accountant, HR, IT, dev, sale, marketing, designer, intern, security, cleaner or plain employee; shown under the name, with a hat or headphones for some, and role-specific shout-outs when smashing) and the character's look (male or female skin). The role list lives in `public/roles.js` and must match `ROLE_IDS` in `lib/world.js` (a test checks it). An optional company name (up to 20 characters, remembered in the browser) is shown next to the role under the player's name. Names are required, and a name that is already used by someone online on the same server (exact match, case-sensitive) is refused.

## Controls

| Action | How |
| --- | --- |
| Move | WASD / arrow keys, or the left joystick on touch screens |
| Smash | Space (hold to keep smashing; with nothing in reach it still swings the hammer, for free), or the SMASH! button |
| Skill | Keys 1, 2, 3 pick hammer, milk tea or electric (or use the Skill button); the chosen one is in your hand (a hammer, a bubble tea cup, a stun gun) and the others see it. The milk tea throw reaches twice as far but does **half the damage** of a hammer hit, on objects and on the boss |
| Call IT | I, or the Call IT button: replaces everything with new stuff (shared cooldown) |
| Emoji | Shift + keys 1 to 8 or the emoji buttons |
| Chat | Enter or `/`, or click the chat box next to the emoji bar (💬 button on touch screens); Enter sends and returns to the game, Esc cancels. The chat frame stays on screen on a computer; on a phone it fades after 3 seconds |
| Zoom | Mouse wheel, pinch with two fingers, or the + / − buttons on touch screens |
| Mini map | M to hide or show it (click it too) |

**Mana.** Every smash costs 5 mana out of 100 (the blue bar under your name). Mana comes back at 3/s at first and 12/s once you have gone 2 seconds without smashing (so the walk between two far-apart objects only gives a little back), so you can burst about 20 hits, then you need roughly 10 seconds to refill. Out of mana the hit is refused and the bar flashes. Damaged objects show a health bar: green while healthy, orange from half, red on the last hit. The numbers live in `MANA` in `lib/realtime.js`; the server enforces them (kept per connection, so reconnecting refills it) and the client mirrors the same formula.

On touch screens, use the left joystick to move and hold the action button on the right to attack. Tapping the floor or an object does not move or attack. Pinching on the game zooms the camera; it does not zoom the page. With a mouse, use the keyboard.

On phones, portrait shows a rotate prompt from the entry screen, including reloads and disconnects. Turn off orientation lock and rotate to landscape to enter. The entry form uses two columns in landscape, and typing follows the browser's native orientation. In Safari, use Share → Add to Home Screen (enable Open as Web App if offered) to launch without browser toolbars. Existing Home Screen shortcuts may need to be removed and added again to pick up the app settings.

Mobile layout, gesture handling and performance validation are documented in [MOBILE.md](MOBILE.md).

The ✨ button switches between high and safe graphics. Safe mode retains player ground shadows and disables real-time shadows and screen halos to reduce rendering work. Phones default to safe mode, but a saved choice is preserved; switch back to safe if high was selected earlier.

## Bosses and moles

VKL guards the server room and attacks intruders. TML and DMM roam the map and retaliate only against their aggressors. Moles pose as ordinary players. Detailed rules and balance:

- [VKL, snakes, captured duels and New Process](BOSS.md)
- [TML and DMM](MINIBOSSES.md)
- [Moles](MOLES.md)

## The office

The 4800×3000 floor has the open workspace, four six-seat IT islands, town hall and toilets in the north. Reception/breakout is in the middle, with the server room to its east and the lounge beside it. Two meeting rooms, the director's office and the pantry occupy the south wing. Rooms connect through corridors and designated doors; shared walls leave no walkable slivers.

There are 359 breakable objects. Walls, glazing, rugs and floors remain intact; smashed solid furniture still blocks movement. The mini map shows you in yellow, other players in white and broken objects in red.

[View the current layout](../artifacts/map-overview.png).
