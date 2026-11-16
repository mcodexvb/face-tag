# Face Tag

Live age estimate, face recognition and name tags in the browser. Everything runs on the device: video is never uploaded, and saved people stay in the browser's own storage.

Live page: https://mcodexvb.github.io/face-tag/ (turn on Pages: Settings → Pages → `main` / root)

## Features

- Live camera with age (smoothed per person, with a ± spread), gender, emotion and optional face mesh
- Name tags: tap a face to name it, or use the guided capture (front, both sides, tilt) for steadier matching
- Live-face check that refuses photos or screens when saving a person
- Open a photo and tag every face in it
- Snapshot to PNG, optional spoken greetings
- Encrypted backup and restore (AES-GCM with a passphrase)
- Installable on a phone and works offline after the first load

## Tech

[Human](https://github.com/vladmandic/human) by Vladimir Mandic (MIT) on TensorFlow.js: BlazeFace detector, FaceMesh, FaceRes descriptor/age/gender, emotion and anti-spoof models. The engine (`lib/human.js`) and models (`models/`) are included so the page works without any CDN.

## Privacy

Face signatures can identify people. Only save people who agree to it, and keep exported backups locked with a passphrase.
