# Saktah

**Practise Qur'an recitation one breath at a time.**

In tajwid you may only take a breath where a stop is allowed: at the end of an ayah, or at a pause mark. Taking a breath in the middle of a phrase breaks it, and teachers correct it constantly. A *saktah* (سَكْتَة) is the brief pause in recitation taken *without* a breath, so the name is the skill.

Saktah watches you recite through your webcam. It does not listen. It uses two live signals from the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs):

- **Talking detection**: are your lips moving, so a phrase has started or ended.
- **Chest and abdomen breathing traces**: did you breathe in.

A breath taken while a phrase is still going is marked. A pause with no breath is fine. The breath at the stop itself is never counted against you.

Built for the DEV x Presage SmartSpectra SDK Challenge, November 2026.

## How a session goes

1. **Consent.** The first screen says what the camera sees, what is processed where, and that nothing is kept. Nothing starts until you press the button.
2. **Setup.** Sit with your face and shoulders in view. The SDK's own guidance ("Come a little closer", "It is too dark") is shown under the picture. Then two guided slow breaths: the circle grows, you breathe in; it shrinks, you breathe out. That teaches Saktah which way the trace moves when *you* breathe in on *this* camera, and how big a real breath is.
3. **Practice.** Pick a surah and how phrases break:
   - **Ayah by ayah**: each whole ayah in one breath (phrases still break where a stop is compulsory).
   - **Every stop**: a phrase at every mark where stopping is allowed.

   The current phrase is shown large. Recite it, stop, breathe. When you go quiet for about 2 seconds (or press <kbd>Space</kbd>) the phrase is judged:
   - **One breath**: it turns green and the next phrase comes up.
   - **A breath before the stop**: it turns amber, the moment is marked on the breath strip ("a breath 2.1 seconds in"), and you try it again.
4. **Summary.** Phrases held in one breath on the first try, the longest phrase you held, and a list of phrases to practise again, with one button to drill only those.

Keys: <kbd>Space</kbd> done with the phrase, <kbd>R</kbd> try again, <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> next and previous (right-to-left).

## How the detection works

All of it is in [`src/shared/breath.js`](src/shared/breath.js), with tests in [`test/breath.test.js`](test/breath.test.js).

- The breathing trace arrives as timestamped samples. It is smoothed over 150 ms and turned the right way up using the calibration polarity.
- **Inhales** are found with a zigzag (hysteresis) detector: a rise from a trough to the next peak that is at least 30% of your calibrated breath size, lasting 0.2 to 4 seconds. Small wobbles and camera noise never reach that threshold.
- **Phrases** come from talking detection: the phrase runs from the first moment you start talking after it appears, to the last moment you were talking before going quiet.
- A phrase is **broken** if an inhale's midpoint falls inside that span, more than 250 ms from either end. Speech pauses without an inhale, the saktah itself, stay clean.
- Everything is aligned on the SDK's own capture timestamps, never on when an event happened to arrive, so processing lag cannot shift a breath into or out of a phrase.

The calibration step picks whichever trace (chest or abdomen) agrees best with the guided breaths.

## Consent and data handling

- **Camera consent** is asked on the first screen, in plain words, before the camera starts. Electron is only allowed to grant the camera (never the microphone) and only to the app's own local page.
- **Processing** happens on your computer, inside the SmartSpectra SDK. Per Presage's documentation, all metric computation runs on-device; the SDK only contacts Presage to check the API key.
- **SDK telemetry** is switched off (`enableTelemetry: false`). Presage documents that when it is off the SDK "transmits nothing" beyond that key check.
- **Storage**: none. No video, images or readings are written to disk. Results live in memory and are gone when the window closes.
- **Sharing**: none. Saktah has no server, no account and no analytics.
- **AI services**: none. SmartSpectra's optional LLM Insights feature is not used.
- **Stopping**: the Stop camera button releases the camera at once; closing the window ends everything.
- **Not a medical tool.** Saktah is a recitation aid. It shows no heart rate or breathing rate and makes no health claims.

There is one developer mode, off by default. Started with `SAKTAH_DEV=1`, the app writes each phrase's breathing trace and talking flags (numbers only, never images) to a local, git-ignored `recordings/` folder for tuning the detector, and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> adds the full last three minutes. Without that variable nothing is written anywhere.

## Run it

Requirements: Windows x64, macOS (Apple Silicon) or Linux x64, Node.js 20+ (24 recommended), a webcam, and a free SmartSpectra API key from [physiology.presagetech.com](https://physiology.presagetech.com/auth/register).

```bash
npm install
npm start
```

The app asks for the API key on its first screen. To skip that, put it in a `.env.local` file next to `package.json` (it is git-ignored):

```
SMARTSPECTRA_API_KEY=your-key-here
```

If you run from a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first (`env -u ELECTRON_RUN_AS_NODE npm start`).

Tests (text segmentation and breath detection, no camera needed):

```bash
npm test
```

## Qur'an text

The Uthmani text with pause marks is from the [Tanzil Project](https://tanzil.net) (Creative Commons Attribution 3.0), shown verbatim. Segmenting only decides where a practice phrase ends; a test joins every phrase back together and checks it equals the original ayah for all 6,236 ayat. Pause marks are read as follows:

| Mark | Meaning | Phrase break? |
| --- | --- | --- |
| ۘ (meem) | Compulsory stop | Always |
| ۗ (qala) | Stopping is better | In "Every stop" |
| ۚ (jeem) | Stopping is allowed | In "Every stop" |
| ۖ (sala) | Joining is better, stopping allowed | In "Every stop" |
| ۛ ... ۛ (pair) | Stop at one of the two | At the first, in "Every stop" |
| ۙ (la) | Do not stop | Never |

The basmalah at the start of a surah is its own phrase.

## Credits

- Built by d0t (team Off Hours).
- Breathing and talking signals: Presage SmartSpectra SDK.
- Qur'an text and surah names: Tanzil Project.
- Arabic font: [Amiri Quran](https://github.com/aliftype/amiri), SIL Open Font License 1.1 (`assets/fonts/OFL.txt`).

Code is MIT licensed. The Qur'an text, the font and the SmartSpectra SDK keep their own licenses.
