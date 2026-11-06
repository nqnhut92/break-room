# Impact samples

Creator: Kenney (Kenney Vleugels), **Impact Sounds 1.0**, CC0.
Official pack: https://kenney.nl/assets/impact-sounds
Original notice: [License.txt](License.txt)

The official download returned HTTP 403 during this update. The Ogg originals and
original notice were retrieved from this redistribution, pinned to commit
`9662dc1bed3b06ae753045915f9accfac044c7ce`:
https://github.com/GeorgeQLe/assets-sfx-combat/tree/9662dc1bed3b06ae753045915f9accfac044c7ce/assets/kenney/impact-sounds

Included: `impact{Wood,Metal,Glass,Punch,Soft,Plate}_{medium,heavy}_{000,001}`.
Converted from Ogg to 22,050 Hz mono 16-bit PCM WAV for Safari compatibility;
leading/trailing silence trimmed, with short margins, and peak normalized to 0.85.
The original material/weight/variant filenames are preserved. No other assets from
the redistribution are included. Weapon accents and mix processing are code in
`public/audio.js`.


## Destruction and heavy slam recordings

Each author page was checked directly for CC0 on 2026-11-06. The public HQ MP3
previews were decoded, downmixed to mono, trimmed with short margins and peak
normalized to 0.8, then saved as 44.1 kHz 16-bit PCM WAV. Their natural debris tails
are retained. See [Freesound-License.txt](Freesound-License.txt).

| Local file | Creator / original page | Public HQ preview |
| --- | --- | --- |
| shatter-glass.wav | [Greg_Surr — Glass Shatter 2.wav](https://freesound.org/people/Greg_Surr/sounds/554564/) | https://cdn.freesound.org/previews/554/554564_8198141-hq.mp3 |
| splinter-wood.wav | [Saladsounds — Wooden Door breaks](https://freesound.org/people/Saladsounds/sounds/723974/) | https://cdn.freesound.org/previews/723/723974_15244025-hq.mp3 |
| slam-metal.wav | [magnuswaker — Heavy Metal Impact 2](https://freesound.org/people/magnuswaker/sounds/614063/) | https://cdn.freesound.org/previews/614/614063_11537497-hq.mp3 |

Design references (reference only; no game audio copied):
- [God of War sound team interview](https://www.asoundeffect.com/god-of-war-sound/): distinguish enemy scale and briefly lower less important sounds around major attacks.
- [Rovio sound team interview](https://www.asoundeffect.com/angry-birds-journey-game-audio/): choose a consistent destruction character, retain detailed tails, vary layers with impact size. This game's harder crashes are a different aesthetic choice from Journey's softer tone.

The earlier sample envelope exponentially faded the entire file to 0.0001, losing
about 40 dB halfway through playback. The new PCM path preserves the recording's
own envelope and only fades its last 12 ms; synthesized accents still decay.
