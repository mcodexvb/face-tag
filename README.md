# Face Tag

Live age estimate, face recognition and name tags in the browser, built for several faces at once. Everything runs on the device: video and photos are never uploaded, and saved people stay in the browser's own storage.

Live page: https://mcodexvb.github.io/face-tag/ (Settings → Pages → `main` / root)

## How it works

Two engine instances share the work. A light detector runs on every frame and feeds a multi-face tracker. A full analyser (signature, age, emotion, spoof check) then reads a zoomed crop of one tracked face at a time, scheduled by need, so tracking speed does not fall as faces are added and small faces are read at higher detail. Each track keeps its own evidence, and names are assigned across all faces together, so one saved person can never label two faces in the same frame.

## Features

- Multi-face tracking with steady labels, labels placed so they do not overlap
- Age (smoothed per person, with a spread), gender, emotion, optional face mesh and match percentage
- Guests: every stranger gets a steady "Guest" label for the session and can be named later in one tap
- Tap a face to name it, guided capture for steadier matching, duplicate-person warning and merge
- "Not this person" corrections that the matcher remembers, and optional learning of new angles over time
- Blur strangers: pixelates everyone who is not a saved person, live and in snapshots
- Tag many photos at once and see who appears in which
- Session log with time in view, CSV export, snapshot to PNG, optional spoken greetings
- Encrypted backup and restore, installable on a phone, works offline after the first load

## Air Instruments

`air-guitar.html` (the "Air instruments" button in the app). Besides the strings and guitar below:

- **Keys:** bend a finger to press the key it points at, as on a real keyboard; several fingers make a chord and a closed fist is silent. Piano uses recorded Steinway samples (public domain); harmonium is a synthesised free-reed model.
- **Drums:** a recorded jazz kit (Virtuosity Drums, CC0). A hit lands when the fingertip strikes down and stops, like a stick; sideways, upward or slow movement is silent.
- **Tabla:** strokes rendered from the instrument's modes (harmonic for the dayan, as C. V. Raman showed; membrane modes for the bayan). Dayan tuned to Sa (Na on the rim, Tin in the centre, Te beside it) and bayan (Ge, Ke); Na or Tin with Ge give Dha or Dhin, and lifting the hand after a Ge bends the bayan's pitch (meend).
- **Theremin:** one hand sets the pitch, the other the volume; glides along a chosen scale or raag, or fully continuous.

### Air Guitar

`air-guitar.html` (the "Air guitar" button in the app) turns the camera into an instrument.

- **Make strings:** pinch thumb and index finger on both hands and pull apart to stretch a string, with a ruler showing the note. Open your fingers to leave it in the air, then sweep a fingertip through it to pluck. Pitch follows the physics of a real string (f ∝ 1/L), optionally snapped to a scale, including Raag Yaman, Bhairav and Bhupali. Pinch one string and hold to delete it.
- **Strum guitar:** point at a chord with one hand and strum six strings with the other. Strings sound in the order your fingers cross them, like a real strum. Choose pop, folk or power-chord sets, and switch to left-handed.
- Sounds: acoustic, electric with overdrive, harp and sitar-like, synthesised in the browser by Karplus-Strong with exact tuning and pick-position timbre.
- Hand tracking: Google MediaPipe Hands (Apache-2.0), bundled in `lib/mediapipe-hands` so it needs no CDN. It runs on the phone's GPU and follows each hand from frame to frame. Human's hand models are the fallback if MediaPipe cannot start.
- Hand skeleton overlay, sparks and vibrating strings, Western or sargam note names, touch play (two fingers stretch a string, one finger plucks) and video recording with sound.

## Tech

Sample credits are in `samples/README.md`.


[Human](https://github.com/vladmandic/human) by Vladimir Mandic (MIT) on TensorFlow.js: BlazeFace, FaceMesh, FaceRes, emotion and anti-spoof models. The engine (`lib/human.js`) and models (`models/`) are included, so the page needs no CDN.

## Privacy

Face signatures can identify people. Only save people who agree to it, and lock exported backups with a passphrase. Guests are held in memory only and vanish when the page closes.
