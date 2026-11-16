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

## Tech

[Human](https://github.com/vladmandic/human) by Vladimir Mandic (MIT) on TensorFlow.js: BlazeFace, FaceMesh, FaceRes, emotion and anti-spoof models. The engine (`lib/human.js`) and models (`models/`) are included, so the page needs no CDN.

## Privacy

Face signatures can identify people. Only save people who agree to it, and lock exported backups with a passphrase. Guests are held in memory only and vanish when the page closes.
