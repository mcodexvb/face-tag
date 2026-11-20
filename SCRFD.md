# Optional SCRFD detector experiment

The default remains Human/BlazeFace. Open the branch build with `?detector=scrfd` to opt in for live camera detection without mesh effects. Photo analysis and live mesh/effects remain on Human; the recognition/analysis pipeline is unchanged.

## Local assets required

- Obtain a legally usable SCRFD 500M ONNX export with fixed NCHW 1x3x640x640 input, three strides (8, 16, 32), two anchors per cell, post-sigmoid scores and distance boxes (feature-last outputs). Save it as `models/scrfd_500m.onnx`. InsightFace pretrained models may have non-commercial restrictions; do not redistribute without permission.
- Install a pinned ONNX Runtime Web distribution (for example `npm install --save-exact onnxruntime-web@1.22.0`). Copy its dist files into `lib/`, including `ort.webgpu.min.mjs` and matching WASM/MJS companions. Keep version and license notices together. No CDN or remote inference is used.
- Serve the branch from localhost or HTTPS. For example, `python -m http.server 8000`, then navigate to `http://localhost:8000/?detector=scrfd`. Camera permissions are required.
- The adapter tries WebGPU, then WASM; if initialization or inference fails it logs a warning and reverts to BlazeFace for that page session. Reload to retry.

## Validation pending

Test the actual model's input/output layout, RGB normalization, anchor ordering and coordinate mapping. Compare identical recorded frames using both modes, for face recall, false positives, small faces, detector latency and overall FPS. Check mesh effects and photo mode remain unchanged. No benchmark result is claimed yet.

All inference is local. A first-time load still requires static assets, and offline reload caching has not yet been implemented by this experiment. Do not merge as a production-ready feature until assets and browser testing are complete.
