/* Air Guitar — strings you stretch in the air with your hands and pluck with a fingertip.
   Part of Face Tag. Hand tracking: Human by Vladimir Mandic (MIT). Sound: Karplus-Strong
   plucked-string synthesis with Web Audio, all generated in the browser. */
(function () {
  'use strict';

  /* ================= settings ================= */
  var $ = function (id) { return document.getElementById(id); };
  var CDN_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/human-models@3.0.4/models/';
  var MODELS = location.protocol === 'file:' ? CDN_MODELS : './models/';
  var Q = new URLSearchParams(location.search), FORCE_BACKEND = Q.get('backend'), WASM_PATH = Q.get('wasm');   // for testing
  var MP_PATH = 'lib/mediapipe-hands/', VERSION = '9';

  var DEFAULTS = { mode: 'strings', tone: 'acoustic', scale: 'minpent', key: 9, names: 'western', chords: 'pop',
                   snap: true, skeleton: true, reverb: true, lefty: false, quality: 'full', keys: 'piano', octave: 48, sustain: false };
  var S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem('airguitar-v1') || '{}')); } catch (e) {}
  function saveS() { try { localStorage.setItem('airguitar-v1', JSON.stringify(S)); } catch (e) {} }

  var WEST = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var SARGAM = ['Sa', 'Re♭', 'Re', 'Ga♭', 'Ga', 'Ma', 'Ma♯', 'Pa', 'Dha♭', 'Dha', 'Ni♭', 'Ni'];
  var SCALES = {
    minpent: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    majpent: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    blues: { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
    major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
    yaman: { name: 'Raag Yaman', steps: [0, 2, 4, 6, 7, 9, 11] },
    bhairav: { name: 'Raag Bhairav', steps: [0, 1, 4, 5, 7, 8, 11] },
    bhupali: { name: 'Raag Bhupali', steps: [0, 2, 4, 7, 9] },
    chromatic: { name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  };
  var TUNING = [40, 45, 50, 55, 59, 64];          // E2 A2 D3 G3 B3 E4, low string first
  var CHORDS = {
    G: [3, 2, 0, 0, 0, 3], D: [null, null, 0, 2, 3, 2], Em: [0, 2, 2, 0, 0, 0], C: [null, 3, 2, 0, 1, 0], Am: [null, 0, 2, 2, 1, 0],
    F: [1, 3, 3, 2, 1, 1], Dm: [null, null, 0, 2, 3, 1], E: [0, 2, 2, 1, 0, 0],
    E5: [0, 2, 2, null, null, null], A5: [null, 0, 2, 2, null, null], D5: [null, null, 0, 2, 3, null],
    G5: [3, 5, 5, null, null, null], C5: [null, 3, 5, 5, null, null], B5: [null, 2, 4, 4, null, null]
  };
  var CHORD_SETS = { pop: ['G', 'D', 'Em', 'C', 'Am', 'F'], folk: ['C', 'Am', 'F', 'G', 'Dm', 'E'], rock: ['E5', 'G5', 'A5', 'C5', 'D5', 'B5'] };
  var TONES = {   // t60: seconds to fade by 60 dB; bright: excitation brightness; lp: output filter
    acoustic: { t60: 2.6, bright: 0.62, lp: 9000, drive: 0, body: 3 },
    electric: { t60: 4.2, bright: 0.8, lp: 3600, drive: 7, body: 0 },
    harp: { t60: 3.2, bright: 0.32, lp: 6500, drive: 0, body: 1 },
    sitar: { t60: 3.8, bright: 0.9, lp: 7000, drive: 1.6, body: 2, buzz: true }
  };
  var BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  var MAX_STRINGS = 8;

  /* ================= state ================= */
  var video = $('video'), canvas = $('cv'), ctx = canvas.getContext('2d');
  var W = 1280, H = 720, DIAG = Math.hypot(W, H);
  canvas.width = W; canvas.height = H;
  var human = null, mpHands = null, mpResult = null, engine = null, ready = false, running = false, gen = 0, stream = null, facing = 'user', wakeLock = null;
  var hands = [], handSeq = 0;
  var strings = [], live = null, holdDel = null, strSeq = 0;
  var strum = [], chordIdx = 0, zones = [];
  var particles = [], labels = [];
  var pointers = {}, plive = null;
  var fps = 0, lastDet = 0, testHold = false;
  var stats = { plays: 0, plucks: 0, made: 0 };

  function status(m, cls) { var s = $('status'); if (s.textContent !== m) s.textContent = m; s.className = cls || ''; }
  var toastT; function toast(m) { var t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, 3000); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function noteName(m) {
    var r = Math.round(m), pc = ((r % 12) + 12) % 12;
    if (S.names === 'sargam') return SARGAM[(pc - S.key + 12) % 12];
    return WEST[pc] + (Math.floor(r / 12) - 1);
  }
  function hueOf(m) { return Math.round((((Math.round(m) % 12) + 12) % 12) * 30 + 160) % 360; }
  function setSize(w, h) { if (w === W && h === H) return; W = w; H = h; DIAG = Math.hypot(W, H); canvas.width = W; canvas.height = H; $('stage').style.aspectRatio = W + ' / ' + H; layoutAll(); }

  /* ================= pitch from string length ================= */
  /* A real string's pitch is inversely proportional to its length: f ∝ 1/L. The longest
     string you can stretch (85% of the frame diagonal) plays the key's root in octave 2. */
  function lengthToMidi(len) {
    var L = Math.max(len, 0.1 * DIAG), semis = 12 * Math.log2(0.85 * DIAG / L);
    var root = 40 + ((S.key - 4 + 12) % 12);
    var m = root + Math.max(0, semis);
    return S.snap ? snap(m, root) : m;
  }
  function snap(m, root) {
    var steps = SCALES[S.scale].steps, best = root, bd = 1e9, oct = Math.floor((m - root) / 12);
    for (var o = oct - 1; o <= oct + 1; o++) steps.concat([12]).forEach(function (s) { var c = root + 12 * o + s, d = Math.abs(c - m); if (d < bd) { bd = d; best = c; } });
    return best;
  }

  /* ================= sound: Karplus-Strong plucked string ================= */
  var ac = null, toneIn, shaper, lp, body, master, comp, wet, recDest, bufCache = {}, cacheKeys = [], voices = [];
  function initAudio() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) { toast('This browser has no Web Audio.'); return; }
    ac = new AC({ latencyHint: 'interactive' });
    toneIn = ac.createGain(); shaper = ac.createWaveShaper(); shaper.oversample = '2x';
    body = ac.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 120; body.Q.value = 1.1;
    lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    master = ac.createGain(); master.gain.value = 0.85;
    comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
    var conv = ac.createConvolver(); conv.buffer = impulse(2.4); wet = ac.createGain();
    toneIn.connect(shaper); shaper.connect(body); body.connect(lp); lp.connect(master);
    master.connect(comp); master.connect(conv); conv.connect(wet); wet.connect(comp); comp.connect(ac.destination);
    try { recDest = ac.createMediaStreamDestination(); comp.connect(recDest); } catch (e) { recDest = null; }
    applyTone();
    if (ac.state === 'suspended') ac.resume();
    prewarm(); preloadDrums(); preloadPiano(); Object.keys(TABLA).forEach(tablaBuffer);
  }
  function impulse(sec) {
    var sr = ac.sampleRate, n = Math.floor(sr * sec), b = ac.createBuffer(2, n, sr);
    for (var c = 0; c < 2; c++) { var d = b.getChannelData(c); for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2); }
    return b;
  }
  function driveCurve(k) {
    var n = 2048, c = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = i * 2 / n - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }
  function applyTone() {
    if (!ac) return; var T = TONES[S.tone];
    shaper.curve = T.drive ? driveCurve(T.drive) : null;
    lp.frequency.value = T.lp; body.gain.value = T.body;
    toneIn.gain.value = T.drive > 3 ? 0.55 : 1;
    wet.gain.value = S.reverb ? (S.tone === 'electric' ? 0.16 : 0.24) : 0;
  }
  /* One plucked note. The string is a delay line one period long with a two-point averager
     (the loss filter) and an all-pass for the fractional part of the period, so tuning is
     exact. The pick position u shapes the first wave with a comb, as on a real string. */
  function ksBuffer(freq, u, vel) {
    var T = TONES[S.tone], key = [Math.round(freq * 4), S.tone, Math.round(u * 8), Math.round(vel * 4)].join('|');
    if (bufCache[key]) return bufCache[key];
    var sr = ac.sampleRate, dur = Math.min(5, T.t60 * 1.05), n = Math.floor(sr * dur), out = new Float32Array(n);
    var P = sr / freq, D = Math.max(2, Math.floor(P - 0.5)), frac = P - 0.5 - D;
    if (frac < 0.1) { D -= 1; frac += 1; }                                // keep the all-pass in its well-behaved range
    var C = (1 - frac) / (1 + frac), g = Math.pow(10, -3 / (T.t60 * sr));
    var line = new Float32Array(D), bright = clamp(T.bright * (0.55 + 0.6 * vel), 0.08, 1), y = 0, i, mean = 0, peak = 0;
    for (i = 0; i < D; i++) { y = bright * (Math.random() * 2 - 1) + (1 - bright) * y; line[i] = y; }
    var pick = clamp(Math.round(clamp(u, 0.06, 0.5) * D), 1, D - 1), ex = new Float32Array(D);
    for (i = 0; i < D; i++) ex[i] = line[i] - (i >= pick ? line[i - pick] : 0);
    for (i = 0; i < D; i++) mean += ex[i]; mean /= D;
    for (i = 0; i < D; i++) { ex[i] -= mean; peak = Math.max(peak, Math.abs(ex[i])); }
    for (i = 0; i < D; i++) line[i] = ex[i] / (peak || 1);
    var idx = 0, prev = 0, apX = 0, apY = 0;
    for (i = 0; i < n; i++) {
      var x = line[idx]; out[i] = x;
      var avg = 0.5 * (x + prev); prev = x;
      var v = C * avg + apX - C * apY; apX = avg; apY = v;
      if (T.buzz && v > 0.12) v = 0.12 + (v - 0.12) * 0.35;           // the sitar's bridge (jawari) clips one side: the buzz
      line[idx] = g * v; idx = idx + 1 === D ? 0 : idx + 1;
    }
    var fade = Math.floor(sr * 0.04); for (i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    var b = ac.createBuffer(1, n, sr); b.getChannelData(0).set(out);
    bufCache[key] = b; cacheKeys.push(key); if (cacheKeys.length > 160) delete bufCache[cacheKeys.shift()];
    return b;
  }
  function playNote(midi, vel, u, x, muted) {
    if (!ac) return;
    var src = ac.createBufferSource(), gn = ac.createGain(), now = ac.currentTime;
    src.buffer = ksBuffer(mtof(midi), u, vel);
    var level = (0.18 + 0.82 * vel * vel) * (midi > 76 ? 0.75 : 1);
    if (muted) { gn.gain.setValueAtTime(level * 0.5, now); gn.gain.exponentialRampToValueAtTime(0.001, now + 0.07); }
    else gn.gain.value = level;
    src.connect(gn);
    var dest = gn;
    if (ac.createStereoPanner) { var p = ac.createStereoPanner(); p.pan.value = clamp((x / W) * 2 - 1, -1, 1) * 0.6; gn.connect(p); dest = p; }
    dest.connect(toneIn); src.start(now); if (muted) src.stop(now + 0.09);
    voices.push(src); src.onended = function () { var k = voices.indexOf(src); if (k >= 0) voices.splice(k, 1); };
    while (voices.length > 28) { try { voices.shift().stop(); } catch (e) {} }
    stats.plays++;
  }

  /* ================= hand tracking ================= */
  function LowPass() { this.y = null; }
  LowPass.prototype.f = function (x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; };
  function alpha(cut, dt) { var tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  /* One Euro filter (Casiez et al., 2012): smooth when still, quick when moving. */
  function OneEuro(minCut, beta) { this.mc = minCut; this.b = beta; this.x = new LowPass(); this.dx = new LowPass(); this.t = null; }
  OneEuro.prototype.f = function (v, t) {
    if (this.t === null) { this.t = t; this.dx.y = 0; return this.x.f(v, 1); }
    var dt = Math.max(0.004, (t - this.t) / 1000); this.t = t;
    var d = (v - this.x.y) / dt, ed = this.dx.f(d, alpha(1, dt));
    return this.x.f(v, alpha(this.mc + this.b * Math.abs(ed), dt));
  };
  function cfg() {
    var c = { modelBasePath: MODELS, backend: 'webgl', debug: false, cacheSensitivity: 0.7, filter: { enabled: true, equalization: false, flip: false },
      face: { enabled: false }, body: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false },
      hand: { enabled: true, rotation: true, skipFrames: 0, skipTime: 0, minConfidence: 0.2, iouThreshold: 0.2, maxDetected: 2, landmarks: true,
        detector: { modelPath: 'handtrack.json' }, skeleton: { modelPath: S.quality === 'lite' ? 'handlandmark-lite.json' : 'handlandmark-full.json' } } };
    if (WASM_PATH) c.wasmPath = WASM_PATH;
    return c;
  }
  /* Primary engine: Google MediaPipe Hands (Apache-2.0), bundled in lib/mediapipe-hands.
     It tracks each hand from frame to frame on the GPU, so it is fast and steady on phones.
     Fallback: Human's hand models, used only if MediaPipe cannot start. */
  async function initMP() {
    var mp = new window.Hands({ locateFile: function (f) { return MP_PATH + f; } });
    mp.setOptions({ maxNumHands: 2, modelComplexity: S.quality === 'lite' ? 0 : 1, minDetectionConfidence: 0.55, minTrackingConfidence: 0.5, selfieMode: false });
    mp.onResults(function (r) { mpResult = r; });
    await mp.initialize();
    var c = document.createElement('canvas'); c.width = c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64);
    await mp.send({ image: c });                                          // compiles the GPU programs before the camera starts
    return mp;
  }
  function loadScript(src) {
    return new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(sc); });
  }
  async function initEngine() {
    if (Q.get('engine') !== 'human' && window.Hands) {
      try { mpHands = await initMP(); engine = 'mp'; ready = true; pill(); showVersion(); return; }
      catch (e) { console.warn('MediaPipe could not start, using the fallback engine', e); mpHands = null; }
    }
    if (!window.Human) await loadScript('lib/human.js');
    var Hm = window.Human && (window.Human.Human || window.Human);
    human = new Hm(cfg());
    var order = ['webgl', 'wasm', 'cpu'], ok = false;
    if (FORCE_BACKEND) order = [FORCE_BACKEND].concat(order.filter(function (b) { return b !== FORCE_BACKEND; }));
    for (var i = 0; i < order.length && !ok; i++) { try { human.config.backend = order[i]; await human.init(); ok = human.tf.getBackend() === order[i]; } catch (e) { ok = false; } }
    await human.load();
    try { await human.warmup(); } catch (e) {}
    engine = 'human'; ready = true; pill(); showVersion();
  }
  function showVersion() { var v = $('ver'); if (v) v.textContent = 'Version ' + VERSION + ' · hand tracking: ' + (engine === 'mp' ? 'MediaPipe' : 'Human (fallback)'); }
  async function detectNow(mirror) {
    if (engine === 'mp') {
      mpResult = null; await mpHands.send({ image: video });
      var r = mpResult || {};
      return (r.multiHandLandmarks || []).map(function (lm) { return lm.map(function (q) { var x = q.x * W; return [mirror ? W - x : x, q.y * H]; }); });
    }
    var res = await human.detect(video);
    // the detector's box score is often low for real hands; the finger model's own score is the reliable signal
    return (res.hand || []).filter(function (h) { return h.keypoints && h.keypoints.length === 21 && (h.fingerScore || 0) + 0.5 * (h.score || 0) >= 0.7; })
      .map(function (h) { return h.keypoints.map(function (q) { return [mirror ? W - q[0] : q[0], q[1]]; }); });
  }
  function palm(p) { var x = 0, y = 0; [0, 5, 9, 13, 17].forEach(function (i) { x += p[i][0]; y += p[i][1]; }); return [x / 5, y / 5]; }
  /* dets: arrays of 21 [x, y] points already in screen (mirrored) coordinates. */
  function processHands(dets, now) {
    var info = dets.map(function (p) { return { p: p, c: palm(p), s: Math.max(8, dist(p[0], p[9])) }; });
    var uniq = [];
    info.forEach(function (d) { if (!uniq.some(function (u) { return dist(u.c, d.c) < 0.6 * Math.max(u.s, d.s); })) uniq.push(d); });
    var pairs = [];
    hands.forEach(function (h, hi) { uniq.forEach(function (d, di) { var dd = dist(h.c, d.c); if (dd < 3.2 * Math.max(h.s, d.s)) pairs.push({ hi: hi, di: di, d: dd }); }); });   // generous: a drum strike can move a hand far between frames; closest pairs are matched first
    pairs.sort(function (a, b) { return a.d - b.d; });
    var usedH = {}, usedD = {};
    pairs.forEach(function (q) { if (usedH[q.hi] || usedD[q.di]) return; usedH[q.hi] = usedD[q.di] = true; updateHand(hands[q.hi], uniq[q.di], now); });
    uniq.forEach(function (d, di) {
      if (usedD[di]) return;
      var beta = 5 / DIAG, h = { id: ++handSeq, filt: [], pts: null, prev: null, pinch: false, seen: now, releasedAt: 0, born: now, hits: 0 };
      var mc = engine === 'mp' ? 3.5 : 1.6; beta = (engine === 'mp' ? 14 : 5) / DIAG;      // MediaPipe is steadier, so it needs less smoothing (less lag)
      for (var i = 0; i < 21; i++) h.filt.push([new OneEuro(mc, beta), new OneEuro(mc, beta)]);
      updateHand(h, d, now); h.prev = null; hands.push(h);
    });
    hands.forEach(function (h) { if (now - h.seen >= 300) releaseHand(h); });       // a hand that left lets go of its keys
    hands = hands.filter(function (h) { return now - h.seen < 300; });
    var all = hands; hands = all.filter(function (h) { return h.hits >= 2; });
    interact(now); hands = all;
  }
  function updateHand(h, d, now) {
    var gap = now - h.seen;
    var maxGap = Math.max(260, Math.min(700, 2.5 * 1000 / Math.max(fps, 1)));   // slower devices get a longer allowance
    h.prev = h.pts && gap < maxGap ? h.pts : null;                      // only compare with a recent reading: no phantom sweeps
    h.rawPrev = h.raw && gap < maxGap ? h.raw : null; h.raw = d.p;     // unsmoothed points: strikes need the true moment the finger stops
    h.dt = Math.max(1, gap);
    h.pts = d.p.map(function (k, i) { return [h.filt[i][0].f(k[0], now), h.filt[i][1].f(k[1], now)]; });
    h.c = palm(h.pts); h.s = Math.max(8, dist(h.pts[0], h.pts[9])); h.seen = now; h.hits = (h.hits || 0) + 1;
    var r = dist(h.pts[4], h.pts[8]) / h.s, was = h.pinch;
    h.pinch = was ? r < 0.48 : r < 0.32;                                 // hysteresis: no flicker at the edge
    if (was && !h.pinch) h.releasedAt = now;
    h.pp = mid(h.pts[4], h.pts[8]);
  }

  /* ================= geometry ================= */
  /* Where the moving fingertip p0→p1 crosses the string a→b: returns u along the string, or null. */
  function crossing(p0, p1, a, b) {
    var rx = p1[0] - p0[0], ry = p1[1] - p0[1], sx = b[0] - a[0], sy = b[1] - a[1];
    var den = rx * sy - ry * sx; if (Math.abs(den) < 1e-6) return null;
    var qx = a[0] - p0[0], qy = a[1] - p0[1];
    var t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { u: u, t: t } : null;
  }
  function segDist(p, a, b) {
    var sx = b[0] - a[0], sy = b[1] - a[1], l2 = sx * sx + sy * sy || 1;
    var u = clamp(((p[0] - a[0]) * sx + (p[1] - a[1]) * sy) / l2, 0, 1);
    return { d: Math.hypot(p[0] - a[0] - u * sx, p[1] - a[1] - u * sy), u: u };
  }
  function speedVel(p0, p1, dtMs) { return clamp(dist(p0, p1) / (dtMs / 1000) / (1.3 * DIAG), 0.12, 1); }

  /* ================= strings mode ================= */
  function makeLive(a, b, now, src) {
    var len = dist(a, b), m = lengthToMidi(len);
    if (!src.live) src.live = { born: now };
    var L = src.live;
    if (L.midi !== undefined && Math.round(L.midi) !== Math.round(m) && now - (L.tickAt || 0) > 60) { L.tickAt = now; playNote(m, 0.12, 0.3, (a[0] + b[0]) / 2, true); }
    L.a = a.slice(); L.b = b.slice(); L.len = len; L.midi = m;
  }
  function commit(L, now) {
    if (!L || L.len < 0.1 * DIAG || now - L.born < 280) return null;     // a brief accidental double pinch makes no string
    var s = { id: ++strSeq, a: L.a, b: L.b, len: L.len, midi: L.midi, vib: [], last: 0, quietUntil: now + 350, born: now };
    strings.push(s); stats.made++;
    while (strings.length > MAX_STRINGS) { burst(strings[0], 18); strings.shift(); }
    pluck(s, 0.5, 0.55, now, true);
    return s;
  }
  function pluck(s, u, vel, now, force) {
    if (!force && (now < s.quietUntil || now - s.last < 90)) return false;
    s.last = now; s.vib.push({ t0: now, amp: vel, p: u }); if (s.vib.length > 3) s.vib.shift();
    var x = s.a[0] + (s.b[0] - s.a[0]) * u, y = s.a[1] + (s.b[1] - s.a[1]) * u;
    var muted = s.midi === null;
    if (!muted) playNote(s.midi, vel, Math.min(u, 1 - u), x, false); else playNote(s.mutedMidi || 40, vel, 0.3, x, true);
    sparks(s, x, y, vel, muted);
    if (!muted && !s.strum) labels.push({ x: x, y: y, text: noteName(s.midi), t0: now, hue: hueOf(s.midi) });
    stats.plucks++; return true;
  }
  function interactStrings(now) {
    var pin = hands.filter(function (h) { return h.pinch; }).sort(function (a, b) { return a.pp[0] - b.pp[0]; });
    var src = { live: live };
    if (pin.length >= 2) { makeLive(pin[0].pp, pin[pin.length - 1].pp, now, src); live = src.live; holdDel = null; }
    else {
      if (live) { commit(live, now); live = null; }
      if (pin.length === 1) {
        var p = pin[0].pp, best = null;
        strings.forEach(function (s) { var r = segDist(p, s.a, s.b); if (r.u > 0.08 && r.u < 0.92 && r.d < 0.035 * DIAG && (!best || r.d < best.d)) best = { s: s, d: r.d }; });
        if (best) {
          if (!holdDel || holdDel.s !== best.s) holdDel = { s: best.s, t0: now };
          holdDel.p = p;
          if (now - holdDel.t0 > 800) { removeString(holdDel.s); holdDel = null; }
        } else holdDel = null;
      } else holdDel = null;
    }
  }
  function removeString(s) { var i = strings.indexOf(s); if (i < 0) return; burst(s, 40); strings.splice(i, 1); }

  /* ================= strum mode ================= */
  function lx(x) { return S.lefty ? W - x : x; }
  function layoutStrum() {
    var x0 = lx(0.5 * W), x1 = lx(0.97 * W), top = 0.36 * H, bot = 0.64 * H, old = strum;
    strum = TUNING.map(function (t, i) {
      var y = top + (bot - top) * i / 5, s = old[i] || { id: 'g' + i, vib: [], last: 0, quietUntil: 0, strum: true };
      s.a = [Math.min(x0, x1), y]; s.b = [Math.max(x0, x1), y]; s.len = Math.abs(x1 - x0); s.gauge = 3.2 - i * 0.4; s.i = i; return s;
    });
    var zx0 = lx(0.03 * W), zx1 = lx(0.33 * W), set = CHORD_SETS[S.chords], zt = 0.1 * H, zh = (0.8 * H) / set.length;
    zones = set.map(function (name, i) { return { name: name, x: Math.min(zx0, zx1), y: zt + i * zh, w: Math.abs(zx1 - zx0), h: zh - 6 }; });
    tuneStrum();
  }
  function tuneStrum() {
    var frets = CHORDS[CHORD_SETS[S.chords][chordIdx]] || CHORDS.G;
    strum.forEach(function (s, i) { s.midi = frets[i] === null ? null : TUNING[i] + frets[i]; s.mutedMidi = TUNING[i] + 5; });
  }
  function interactStrum(now) {
    hands.forEach(function (h) {
      var onFretSide = S.lefty ? h.c[0] > 0.55 * W : h.c[0] < 0.45 * W;
      if (!onFretSide) return;
      var tip = h.pts[8];
      zones.forEach(function (z, i) {
        if (tip[0] > z.x - 0.05 * W && tip[0] < z.x + z.w + 0.05 * W && tip[1] >= z.y && tip[1] < z.y + z.h + 6 && chordIdx !== i) { chordIdx = i; tuneStrum(); }
      });
    });
  }

  /* ================= plucking, for every mode and input ================= */
  function sweep(p0, p1, dtMs, now) {
    var list = S.mode === 'strum' ? strum : strings, vel = speedVel(p0, p1, dtMs), hits = [];
    list.forEach(function (s) { var c = crossing(p0, p1, s.a, s.b); if (c && (s.strum || (c.u > 0.05 && c.u < 0.95))) hits.push({ s: s, c: c }); });
    hits.sort(function (a, b) { return a.c.t - b.c.t; });                 // in the order the finger met them: a real strum
    hits.forEach(function (h) { pluck(h.s, h.s.strum ? 0.18 + 0.1 * h.s.i / 5 : h.c.u, vel, now, false); });
  }
  function interact(now) {
    if (S.mode === 'keys') return interactKeys(now);
    if (S.mode === 'drums') return interactDrums(now);
    if (S.mode === 'tabla') return interactTabla(now);
    if (S.mode === 'theremin') return interactTheremin(now);
    if (S.mode === 'strings') interactStrings(now); else interactStrum(now);
    hands.forEach(function (h) {
      if (!h.prev || h.pinch || now - h.releasedAt < 250) return;
      (S.mode === 'strum' ? [8] : [8, 12]).forEach(function (k) { sweep(h.prev[k], h.pts[k], h.dt, now); });   // strumming: one fingertip, like a pick
    });
  }

  /* ================= more instruments: keys, drums, tabla, theremin ================= */
  var TIPS = [4, 8, 12, 16, 20];
  var keys = [], keySurf = 0, pads = [], tpads = [], ther = null, therTrail = [], geVoice = null, lastBol = {}, noiseBuf = null;
  var therState = { tip: null, m: null, vol: 0, vtip: null };
  var pianoCache = {}, pianoKeys = [], warmQ = [];
  var PAD_NAMES = { kick: 'Kick', snare: 'Snare', hihat: 'Hi-hat', crash: 'Crash', tom1: 'Tom', tom2: 'Floor tom', ride: 'Ride' };
  var PAD_HUE = { kick: 0, snare: 210, hihat: 45, crash: 48, ride: 40, tom1: 20, tom2: 28 };
  function layoutAll() { layoutStrum(); layoutKeys(); layoutPads(); layoutTabla(); }
  function isBlack(m) { return [1, 3, 6, 8, 10].indexOf(((m % 12) + 12) % 12) >= 0; }

  /* ---------- recorded samples (piano: Splendid Grand Piano, public domain; drums: Virtuosity Drums, CC0) ---------- */
  var smpCache = {}, smpLoading = {}, pianoIndex = null;
  function loadSample(url) {
    if (smpCache[url]) return Promise.resolve(smpCache[url]);
    if (smpLoading[url]) return smpLoading[url];
    return (smpLoading[url] = fetch(url).then(function (r) { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
      .then(function (b) { return new Promise(function (res, rej) { ac.decodeAudioData(b, res, rej); }); })
      .then(function (buf) { smpCache[url] = buf; stats.samples = (stats.samples || 0) + 1; return buf; })
      .catch(function () { delete smpLoading[url]; return null; }));
  }
  var DRUM_IDS = ['kick', 'snare', 'hihat', 'crash', 'ride', 'tom1', 'tom2'];
  function drumUrl(id, layer) { return 'samples/drums/' + id + '-' + layer + '.m4a'; }
  function preloadDrums() { if (!ac) return; DRUM_IDS.forEach(function (id) { loadSample(drumUrl(id, 1)); loadSample(drumUrl(id, 2)); }); }
  function loadPianoIndex() {
    if (pianoIndex || !ac) return Promise.resolve(pianoIndex);
    return fetch('samples/piano/index.json').then(function (r) { return r.json(); }).then(function (j) { pianoIndex = j; return j; }).catch(function () { return null; });
  }
  function pianoSample(midi, loud) {
    if (!pianoIndex) return null;
    var list = pianoIndex[loud ? 'loud' : 'soft'], best = null;
    list.forEach(function (m) { if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m; });
    return best === null ? null : { midi: best, url: 'samples/piano/' + (loud ? 'loud' : 'soft') + '-' + best + '.m4a' };
  }
  function preloadPiano() {
    if (!ac || S.keys !== 'piano') return;
    loadPianoIndex().then(function () { keys.forEach(function (k) { [false, true].forEach(function (l) { var s = pianoSample(k.midi, l); if (s) loadSample(s.url); }); }); });
  }

  /* ---------- keys ---------- */
  function layoutKeys() {
    var land = W >= H, nWhite = land ? 15 : 10, y0 = H * (land ? 0.6 : 0.68), y1 = H * 0.975, kw = W / nWhite, m = S.octave, wi = 0, whites = [], blacks = [];
    while (isBlack(m)) m++;
    while (wi < nWhite) {
      if (isBlack(m)) blacks.push({ midi: m, black: true, x: wi * kw - kw * 0.31, y: y0, w: kw * 0.62, h: (y1 - y0) * 0.6 });
      else { whites.push({ midi: m, black: false, x: wi * kw + 1, y: y0, w: kw - 2, h: y1 - y0 }); wi++; }
      m++;
    }
    var old = {}; keys.forEach(function (k) { old[k.midi] = k; });
    keys = blacks.concat(whites).map(function (k) { var o = old[k.midi]; k.on = o ? o.on : 0; k.t = o ? o.t : 0; return k; });
    keySurf = y0;
  }
  function keyAt(p) { for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (p[0] >= k.x && p[0] <= k.x + k.w && p[1] >= k.y && p[1] <= k.y + k.h) return k; } return null; }
  /* Piano: additive synthesis. Each overtone is slightly sharp (string stiffness, B grows with pitch),
     each note has two strings a hair apart (the slow beating of a real piano), and decay is two-stage. */
  function pianoBuffer(midi) {
    if (pianoCache[midi]) return pianoCache[midi];
    var sr = ac.sampleRate, f = mtof(midi), dur = clamp(4.2 - (midi - 40) * 0.05, 1.2, 3.6), n = Math.floor(sr * dur), out = new Float32Array(n);
    var Bc = 0.00008 * Math.pow(2, (midi - 40) / 12), N = Math.min(14, Math.floor(sr / 2.2 / f)), i, k, u;
    for (k = 1; k <= N; k++) {
      var fk = f * k * Math.sqrt(1 + Bc * k * k); if (fk > sr / 2.2) break;
      var ak = Math.pow(k, -1.15) * Math.exp(-(k - 1) * 0.2), tau = dur * 0.5 / (1 + 0.4 * (k - 1)), t1 = tau * 0.18;
      for (u = 0; u < 2; u++) {
        var w = 2 * Math.PI * fk * (u ? 1.0006 : 0.9997) / sr, c = Math.cos(w), s = Math.sin(w), ph = Math.random() * 6.283, re = Math.cos(ph), im = Math.sin(ph);
        var d1 = Math.exp(-1 / (t1 * sr)), d2 = Math.exp(-1 / (tau * sr)), e1 = 0.32 * ak, e2 = 0.18 * ak;
        for (i = 0; i < n; i++) { out[i] += (e1 + e2) * im; var nr = re * c - im * s; im = re * s + im * c; re = nr; e1 *= d1; e2 *= d2; }
      }
    }
    var lpY = 0, hn = Math.floor(sr * 0.012);                                // felt hammer thump
    for (i = 0; i < hn; i++) { lpY = 0.25 * (Math.random() * 2 - 1) + 0.75 * lpY; out[i] += 0.25 * lpY * Math.exp(-i / (0.003 * sr)); }
    var peak = 0, att = Math.floor(sr * 0.002), fade = Math.floor(sr * 0.05);
    for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (i = 0; i < n; i++) { out[i] *= 0.8 / (peak || 1); if (i < att) out[i] *= i / att; if (i > n - fade) out[i] *= (n - i) / fade; }
    var b = ac.createBuffer(1, n, sr); b.getChannelData(0).set(out);
    pianoCache[midi] = b; pianoKeys.push(midi); if (pianoKeys.length > 40) delete pianoCache[pianoKeys.shift()];
    return b;
  }
  function prewarm() {
    if (!ac || S.mode !== 'keys' || S.keys !== 'piano') return;
    warmQ = keys.map(function (k) { return k.midi; }).filter(function (m) { return !pianoCache[m]; });
    (function step() { if (!warmQ.length || S.mode !== 'keys' || S.keys !== 'piano') return; pianoBuffer(warmQ.shift()); setTimeout(step, 40); })();
  }
  function mkPan(x) {
    if (ac.createStereoPanner) { var p = ac.createStereoPanner(); p.pan.value = clamp((x / W) * 2 - 1, -1, 1) * 0.5; p.connect(master); return p; }
    var g = ac.createGain(); g.connect(master); return g;
  }
  var reedWaves = {};
  function reedWave(midi) {                                                // free-reed spectrum: rich harmonics, a resonance near 1.3 kHz
    var key = Math.round(midi); if (reedWaves[key]) return reedWaves[key];
    var f = mtof(midi), N = 40, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (var n = 1; n <= N; n++) { var fn = f * n; if (fn > 12000) break; var form = 1 + 1.6 * Math.exp(-Math.pow(Math.log(fn / 1300), 2) / 0.35) + 0.6 * Math.exp(-Math.pow(Math.log(fn / 2800), 2) / 0.25); im[n] = Math.pow(n, -0.75) * form * (n % 2 ? 1 : 0.8); }
    return (reedWaves[key] = ac.createPeriodicWave(re, im));
  }
  function harmoniumVoice(midi, vel, dest) {
    var t = ac.currentTime, f = mtof(midi), g = ac.createGain(), lpf = ac.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = 7000; lpf.Q.value = 0.5;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06 + 0.04 * vel, t + 0.05); g.gain.setTargetAtTime(0.055 + 0.035 * vel, t + 0.05, 0.3);
    var nodes = [[1, -5, 1], [1, 6, 0.85], [0.5, 0, 0.55]].map(function (d) {
      var o = ac.createOscillator(), og = ac.createGain(); o.setPeriodicWave(reedWave(midi + 12 * Math.log2(d[0])));
      o.frequency.setValueAtTime(f * d[0] * 0.994, t); o.frequency.exponentialRampToValueAtTime(f * d[0], t + 0.06);   // reeds speak a touch flat
      o.detune.value = d[1]; og.gain.value = d[2]; o.connect(og); og.connect(lpf); o.start(t); return o;
    });
    var br = ac.createBufferSource(), bf = ac.createBiquadFilter(), bg = ac.createGain();   // air through the reeds
    br.buffer = noiseBuffer(); br.loop = true; bf.type = 'bandpass'; bf.frequency.value = 1800; bf.Q.value = 0.8; bg.gain.value = 0.05;
    br.connect(bf); bf.connect(bg); bg.connect(g); br.start(t, Math.random() * 0.5); nodes.push(br);
    var lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 4.6; lg.gain.value = 0.006; lfo.connect(lg); lg.connect(g.gain); lfo.start(t); nodes.push(lfo);   // bellows
    lpf.connect(g); g.connect(dest);
    return { stop: function () { var t2 = ac.currentTime; g.gain.cancelScheduledValues(t2); g.gain.setTargetAtTime(0, t2, 0.05); nodes.forEach(function (o) { try { o.stop(t2 + 0.4); } catch (e) {} }); } };
  }
  function keyNoteOn(k, vel) {
    k.on++; k.t = performance.now(); stats.plays++; stats.keys = (stats.keys || 0) + 1;
    if (!ac) return null;
    var dest = mkPan(k.x + k.w / 2);
    if (S.keys === 'harmonium') return harmoniumVoice(k.midi, vel, dest);
    var t = ac.currentTime, src = ac.createBufferSource(), lpf = ac.createBiquadFilter(), g = ac.createGain();
    var smp = pianoSample(k.midi, vel > 0.62), buf = smp && smpCache[smp.url];
    if (buf) { src.buffer = buf; src.playbackRate.value = Math.pow(2, (k.midi - smp.midi) / 12); lpf.frequency.value = 18000; g.gain.value = 0.35 + 0.75 * vel; }
    else { src.buffer = pianoBuffer(k.midi); lpf.frequency.value = Math.min(16000, mtof(k.midi) * (2.5 + 14 * vel)); g.gain.value = 0.15 + 0.85 * vel * vel; if (smp) loadSample(smp.url); }
    lpf.type = 'lowpass';
    src.connect(lpf); lpf.connect(g); g.connect(dest); src.start(t);
    return { stop: function () { var t2 = ac.currentTime; g.gain.cancelScheduledValues(t2); g.gain.setTargetAtTime(0, t2, 0.07); try { src.stop(t2 + 0.6); } catch (e) {} } };
  }
  function keyNoteOff(k, v) { k.on = Math.max(0, k.on - 1); if (v && !(S.keys === 'piano' && S.sustain)) v.stop(); }
  var FINGERS = [[8, 5], [12, 9], [16, 13], [20, 17]];                    // fingertip, knuckle
  function flexRatio(h, f) { var w = h.pts[0]; return dist(h.pts[f[0]], w) / Math.max(1, dist(h.pts[f[1]], w)); }
  function keyForX(x) {                                                    // black keys answer only near their middle, so sharps are not hit by accident
    for (var i = 0; i < keys.length; i++) { var k = keys[i], m = k.black ? 0.15 * k.w : 0; if (x >= k.x + m && x <= k.x + k.w - m) return k; }
    return null;
  }
  function interactKeys(now) {
    hands.forEach(function (h) {
      h.kd = h.kd || {}; h.kb = h.kb || {}; h.kr = h.kr || {}; h.kn = (h.kn || 0) + 1;
      var fs = FINGERS.map(function (f) {
        var r = flexRatio(h, f), b = h.kb[f[0]];
        if (b === undefined || r > b) b = r; else if (!h.kd[f[0]]) b = b * 0.996 + r * 0.004;   // baseline: the finger's straight length, slowly adapting
        h.kb[f[0]] = b; return { ti: f[0], r: r, b: b };
      });
      var fist = fs.every(function (x) { return x.r < x.b * 0.8; });        // a closed fist is a rest, not a chord
      fs.forEach(function (x) {
        var st = h.kd[x.ti];
        if (st) { if (x.r > x.b * 0.88 || fist) { keyNoteOff(st.key, st.v); h.kd[x.ti] = null; } return; }
        if (fist || h.kn < 4 || x.r >= x.b * 0.76) return;
        var k = keyForX(h.pts[x.ti][0]); if (!k) return;
        var pr = h.kr[x.ti] != null ? h.kr[x.ti] : x.r, rate = (pr - x.r) / x.b / (Math.max(1, h.dt) / 1000), vel = clamp(0.35 + rate * 0.15, 0.3, 1);
        h.kd[x.ti] = { key: k, vel: vel, v: keyNoteOn(k, vel) };
      });
      fs.forEach(function (x) { h.kr[x.ti] = x.r; });
    });
  }
  function releaseHand(h) { if (h.kd) Object.keys(h.kd).forEach(function (ti) { var st = h.kd[ti]; if (st) keyNoteOff(st.key, st.v); }); h.kd = {}; }
  function releaseAll() {
    hands.forEach(releaseHand);
    Object.keys(pointers).forEach(function (id) { var q = pointers[id]; if (q.kd) { keyNoteOff(q.kd.key, q.kd.v); q.kd = null; } });
    keys.forEach(function (k) { k.on = 0; }); therKill(); geVoice = null;
  }

  /* ---------- shared percussion sound pieces ---------- */
  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    var n = ac.sampleRate, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return (noiseBuf = b);
  }
  function noiseHit(dest, t, type, freq, q, amp, dur) {
    var s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuffer(); fl.type = type; fl.frequency.value = freq; fl.Q.value = q;
    g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(fl); fl.connect(g); g.connect(dest); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
  /* Modal synthesis: a struck drumhead or cymbal as a few decaying sine modes [ratio, amplitude, time constant]. */
  function modal(f, parts, amp, dest, t) {
    parts.forEach(function (pp) {
      var o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f * pp[0];
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(pp[1] * amp, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.003 + pp[2] * 3);
      o.connect(g); g.connect(dest); o.start(t); o.stop(t + pp[2] * 3 + 0.05);
    });
  }
  function sweepTone(dest, t, type, f0, f1, glide, amp, dur) {
    var o = ac.createOscillator(), g = ac.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.02); return o;
  }
  function circleHit(q, p, c, r) {                                         // fingertip moved from outside the circle into it, or right through it
    if (dist(q, c) <= r) return false;
    return dist(p, c) <= r || segDist(c, q, p).d <= r;
  }
  function burstAt(x, y, hue, n, sp) {
    for (var i = 0; i < n; i++) { var a = Math.random() * 6.283, v = (0.3 + Math.random()) * sp * DIAG; particles.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.3 + Math.random() * 0.4, hue: hue, sat: 85 }); }
  }

  /* ---------- drum kit ---------- */
  function layoutPads() {
    var land = W >= H, m = Math.min(W, H), defs = land
      ? [['hihat', 0.16, 0.4, 0.16], ['crash', 0.3, 0.17, 0.15], ['tom1', 0.5, 0.33, 0.14], ['ride', 0.72, 0.17, 0.15], ['snare', 0.27, 0.72, 0.17], ['tom2', 0.73, 0.7, 0.17], ['kick', 0.5, 0.86, 0.12]]
      : [['hihat', 0.2, 0.3, 0.15], ['crash', 0.75, 0.2, 0.16], ['tom1', 0.55, 0.42, 0.13], ['snare', 0.25, 0.62, 0.17], ['ride', 0.82, 0.48, 0.13], ['tom2', 0.72, 0.7, 0.16], ['kick', 0.45, 0.86, 0.14]];
    var old = {}; pads.forEach(function (p) { old[p.id] = p; });
    pads = defs.map(function (d) { return { id: d[0], c: [lx(d[1] * W), d[2] * H], r: d[3] * m, t: old[d[0]] ? old[d[0]].t : 0 }; });
  }
  function playDrum(id, vel) {
    var pd = pads.filter(function (p) { return p.id === id; })[0];
    if (!ac || !pd) return;
    var t = ac.currentTime, g = ac.createGain(); g.gain.value = 0.35 + 0.65 * vel; g.connect(mkPan(pd.c[0]));
    var buf = smpCache[drumUrl(id, vel > 0.6 ? 2 : 1)] || smpCache[drumUrl(id, vel > 0.6 ? 1 : 2)];
    if (buf) { var src = ac.createBufferSource(); src.buffer = buf; src.playbackRate.value = 0.985 + Math.random() * 0.03; g.gain.value = 0.45 + 0.75 * vel; src.connect(g); src.start(t); return; }
    preloadDrums();
    if (id === 'kick') { sweepTone(g, t, 'sine', 155, 48, 0.13, 1.1, 0.5); noiseHit(g, t, 'highpass', 1800, 0.7, 0.25, 0.012); }
    else if (id === 'snare') { noiseHit(g, t, 'bandpass', 1900, 0.6, 0.9, 0.24); noiseHit(g, t, 'highpass', 5000, 0.7, 0.3, 0.12); sweepTone(g, t, 'triangle', 195, 165, 0.08, 0.6, 0.14); }
    else if (id === 'hihat') { noiseHit(g, t, 'highpass', 7500, 0.8, 0.55, 0.06); noiseHit(g, t, 'bandpass', 10000, 1, 0.3, 0.05); }
    else if (id === 'crash') { noiseHit(g, t, 'highpass', 4200, 0.6, 0.65, 1.8); noiseHit(g, t, 'bandpass', 6500, 0.9, 0.35, 0.9); }
    else if (id === 'ride') { noiseHit(g, t, 'highpass', 6000, 0.7, 0.3, 1.1); modal(510, [[1, 0.25, 0.4], [2.76, 0.15, 0.3], [5.4, 0.08, 0.2]], 1, g, t); }
    else { var f0 = id === 'tom1' ? 200 : 120; sweepTone(g, t, 'sine', f0 * 1.4, f0, 0.15, 0.9, id === 'tom1' ? 0.5 : 0.75); noiseHit(g, t, 'lowpass', 1200, 0.7, 0.2, 0.04); }
  }
  function hitPad(pd, vel, now) {
    pd.t = now; playDrum(pd.id, vel); stats.plays++; stats.drums = (stats.drums || 0) + 1;
    burstAt(pd.c[0], pd.c[1], PAD_HUE[pd.id], Math.round(8 + 18 * vel), 0.35);
  }
  /* A stroke lands when the fingertip has been moving down fast and then stops: the moment a stick meets the skin.
     Sideways or upward movement, and slowly lowering a hand, never sound. Works at low frame rates too. */
  function strike(h, now) {
    var sk = h.sk || (h.sk = { peak: 0, armedAt: 0, last: 0 });
    if (!h.rawPrev || h.hits < 3) { sk.armedAt = 0; sk.peak = 0; return null; }
    var p = h.raw[8], q = h.rawPrev[8], dt = Math.max(0.008, h.dt / 1000), vy = (p[1] - q[1]) / dt / H, jump = (p[1] - q[1]) / h.s;
    var downFast = vy > 1.1 || jump > 0.45, power = Math.max(vy / 3.2, jump / 1.1);
    if (downFast) { if (!sk.armedAt) sk.armedAt = now; sk.peak = Math.max(sk.peak, power); sk.pvy = vy; return null; }
    if (!sk.armedAt) return null;
    if (now - sk.armedAt > Math.max(450, 5 * 1000 / Math.max(fps, 1))) { sk.armedAt = 0; sk.peak = 0; return null; }   // longer allowance on slow devices
    if (vy < Math.max(0.45, 0.4 * (sk.pvy || 0)) && now - sk.last > 90) {
      var vel = clamp(sk.peak, 0.25, 1); sk.armedAt = 0; sk.peak = 0; sk.last = now; return { p: p, vel: vel };
    }
    return null;
  }
  function padAt(list, p, grow) { var best = null; list.forEach(function (pd) { var d = dist(p, pd.c) / pd.r; if (d <= grow && (!best || d < best.d)) best = { pd: pd, d: d }; }); return best && best.pd; }
  function interactDrums(now) {
    hands.forEach(function (h) { var s = strike(h, now); if (!s) return; var pd = padAt(pads, s.p, 1.15); if (pd && now - pd.t > 60) hitPad(pd, s.vel, now); });
  }

  /* ---------- tabla ---------- */
  function layoutTabla() {
    var land = W >= H, m = Math.min(W, H);
    var b = land ? [0.32, 0.6, 0.25] : [0.3, 0.68, 0.27], d = land ? [0.7, 0.6, 0.2] : [0.7, 0.45, 0.21];
    var bc = [lx(b[0] * W), b[1] * H], dc = [lx(d[0] * W), d[1] * H], Rb = b[2] * m, Rd = d[2] * m, sr = 0.07 * m, gap = 0.06 * m, out = S.lefty ? -1 : 1;
    // the small Te and Ke pads sit beside the drums, never above them, so a downward stroke onto a drum cannot clip one
    var tdir = land ? [out, 0] : [out * 0.707, 0.707], kdir = land ? [-out, 0] : [-out * 0.5, -0.866];
    function place(c, R, d) { return [clamp(c[0] + d[0] * (R + gap + sr), sr + 4, W - sr - 4), clamp(c[1] + d[1] * (R + gap + sr), sr + 4, H - sr - 4)]; }
    var old = {}; tpads.forEach(function (p) { old[p.id] = p; });
    tpads = [
      { id: 'bayan', bol: 'Ge', c: bc, r: Rb }, { id: 'dayan', bol: 'Na', c: dc, r: Rd },
      { id: 'ke', bol: 'Ke', c: place(bc, Rb, kdir), r: sr }, { id: 'te', bol: 'Te', c: place(dc, Rd, tdir), r: sr }
    ].map(function (p) { p.t = old[p.id] ? old[p.id].t : 0; return p; });
  }
  /* The dayan is tuned to Sa (the Key setting). Its black syahi makes the overtones harmonic, which is why a
     tabla sounds pitched: Na rings in the upper harmonics, Tin in the fundamental. The bayan rises as it sounds. */
  /* Tabla strokes, rendered from the instruments' physics. C. V. Raman showed that the dayan's black syahi makes its
     overtones harmonic (1:2:3:4:5), which is why it sounds pitched; the bayan's plain membrane has the inharmonic
     circular-membrane modes (1 : 1.59 : 2.14 : 2.65). Each mode is [ratio, amplitude, decay time constant]. */
  var TABLA = {
    Na:  { bayan: false, modes: [[1, 0.12, 0.18], [2, 0.9, 0.42], [3, 0.65, 0.3], [4, 0.45, 0.22], [5, 0.3, 0.16], [6, 0.14, 0.1]], noise: ['hp', 3200, 0.009, 0.55], drop: 0.02 },
    Tin: { bayan: false, modes: [[1, 1, 0.75], [2, 0.5, 0.5], [3, 0.28, 0.32], [4, 0.14, 0.2], [5, 0.07, 0.14]], noise: ['bp', 1600, 0.007, 0.3], drop: 0.015 },
    Te:  { bayan: false, modes: [[1, 0.55, 0.045], [2, 0.32, 0.035], [3, 0.2, 0.03]], noise: ['bp', 1200, 0.02, 0.75], drop: 0 },
    Ge:  { bayan: true, modes: [[1, 1, 0.75], [1.59, 0.22, 0.3], [2.14, 0.13, 0.2], [2.65, 0.07, 0.14]], noise: ['lp', 420, 0.012, 0.5], rise: 0.12 },
    Ke:  { bayan: true, modes: [[1, 0.55, 0.05], [1.59, 0.3, 0.04]], noise: ['lp', 520, 0.028, 0.9], drop: 0 }
  };
  var tablaCache = {};
  function biquadCoef(type, f, q, sr) {                                    // RBJ cookbook filters, for shaping the strike noise
    var w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), b;
    if (type === 'lp') b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]; else if (type === 'hp') b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]; else b = [al, 0, -al];
    var a0 = 1 + al; return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * cs / a0, (1 - al) / a0];
  }
  function tablaBuffer(bol) {
    var key = bol + '|' + S.key; if (tablaCache[key]) return tablaCache[key];
    var T = TABLA[bol], sr = ac.sampleRate, f0 = T.bayan ? mtof(60 + S.key) / 3.2 : mtof(60 + S.key);
    var dur = 0.05 + Math.max.apply(null, T.modes.map(function (m) { return m[2]; })) * 5, n = Math.floor(sr * dur), out = new Float32Array(n), i;
    T.modes.forEach(function (m) {
      var ph = Math.random() * 6.283, amp = m[1], d = Math.exp(-1 / (m[2] * sr));
      for (i = 0; i < n; i++) {
        var t = i / sr, ratio = T.rise ? 1 + T.rise * (1 - Math.exp(-t / 0.08)) : 1 + (T.drop || 0) * Math.exp(-t / 0.02);   // bayan rises, dayan settles
        ph += 2 * Math.PI * f0 * m[0] * ratio / sr; out[i] += amp * Math.sin(ph); amp *= d;
      }
    });
    var c = biquadCoef(T.noise[0], T.noise[1], 0.8, sr), x1 = 0, x2 = 0, y1 = 0, y2 = 0, nn = Math.floor(sr * T.noise[2] * 4);   // the finger striking the skin
    for (i = 0; i < nn && i < n; i++) {
      var x = Math.random() * 2 - 1, y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] += T.noise[3] * 2.5 * y * Math.exp(-i / (sr * T.noise[2]));
    }
    var peak = 0, att = Math.floor(sr * 0.001); for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (i = 0; i < n; i++) { out[i] *= 0.9 / (peak || 1); if (i < att) out[i] *= i / att; }
    var b = ac.createBuffer(1, n, sr); b.getChannelData(0).set(out);
    return (tablaCache[key] = b);
  }
  function playTabla(bol, vel, x) {
    if (!ac) return null;
    var t = ac.currentTime, src = ac.createBufferSource(), lpf = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = tablaBuffer(bol); lpf.type = 'lowpass'; lpf.frequency.value = 2500 + 9000 * vel; g.gain.value = 0.4 + 0.6 * vel;
    src.connect(lpf); lpf.connect(g); g.connect(mkPan(x)); src.start(t);
    if (bol === 'Ge') return { set: function (ratio) { src.playbackRate.setTargetAtTime(ratio, ac.currentTime, 0.04); } };   // meend
    return null;
  }
  function hitTabla(pd, bol, vel, now, h) {
    pd.t = now; pd.last = bol;
    var shown = bol;
    if ((bol === 'Na' && now - (lastBol.Ge || 0) < 90) || (bol === 'Ge' && now - (lastBol.Na || 0) < 90)) shown = 'Dha';     // Na + Ge together
    if ((bol === 'Tin' && now - (lastBol.Ge || 0) < 90) || (bol === 'Ge' && now - (lastBol.Tin || 0) < 90)) shown = 'Dhin';
    lastBol[bol] = now;
    var v = playTabla(bol, vel, pd.c[0]);
    if (v && h) geVoice = { set: v.set, hand: h.id, y0: h.pts[0][1], t0: now, lift: 0, last: 1 };
    if (v && !h) geVoice = null;
    labels.push({ x: pd.c[0], y: pd.c[1] - pd.r * 0.25, text: shown, t0: now, hue: pd.id === 'bayan' || pd.id === 'ke' ? 30 : 50 });
    burstAt(pd.c[0], pd.c[1], 40, Math.round(6 + 12 * vel), 0.25);
    stats.plays++; stats.tabla = (stats.tabla || 0) + 1; stats.lastBol = shown;
  }
  function tablaBol(pd, p) { return pd.id === 'dayan' ? (dist(p, pd.c) < 0.5 * pd.r ? 'Tin' : 'Na') : pd.bol; }   // dayan: black centre rings (Tin), the rim is sharp (Na)
  function interactTabla(now) {
    hands.forEach(function (h) {
      var s = strike(h, now); if (!s) return;
      var pd = padAt(tpads, s.p, 1.12); if (!pd || now - pd.t < 60) return;
      hitTabla(pd, tablaBol(pd, s.p), s.vel, now, pd.id === 'bayan' ? h : null);
    });
    if (geVoice) {                                                         // meend: lift the hand that struck the bayan to bend its pitch upward
      var gh = hands.filter(function (h) { return h.id === geVoice.hand; })[0];
      if (gh) { geVoice.lift = clamp((geVoice.y0 - gh.pts[0][1]) / (0.25 * H), 0, 1); var r = 1 + 0.5 * geVoice.lift; if (geVoice.lift > 0.05 && Math.abs(r - geVoice.last) > 0.01) { geVoice.set(r); geVoice.last = r; } }
      if (now - geVoice.t0 > 1500) geVoice = null;
    }
  }

  /* ---------- theremin ---------- */
  function therRoot() { return 48 + S.key; }                               // the key's root in octave 3, two octaves of range
  function therMap(y) { var u = clamp((0.92 * H - y) / (0.84 * H), 0, 1), m = therRoot() + 24 * u; return S.snap ? snap(m, therRoot()) : m; }
  function therVoice() {
    if (ther || !ac) return ther;
    var t = ac.currentTime, o = ac.createOscillator(), o2 = ac.createOscillator(), g2 = ac.createGain(), sh = ac.createWaveShaper(), lp2 = ac.createBiquadFilter(), g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
    o.type = 'sine'; o2.type = 'triangle'; o.frequency.value = 220; o2.frequency.value = 440; g2.gain.value = 0.1;
    sh.curve = driveCurve(1.4); lp2.type = 'lowpass'; lp2.frequency.value = 3500;
    lfo.frequency.value = 5.6; lg.gain.value = 14; lfo.connect(lg); lg.connect(o.detune); lg.connect(o2.detune);   // vibrato
    g.gain.value = 0;
    o.connect(sh); o2.connect(g2); g2.connect(sh); sh.connect(lp2); lp2.connect(g); g.connect(master);
    o.start(t); o2.start(t); lfo.start(t);
    return (ther = { o: o, o2: o2, g: g, lfo: lfo, on: false });
  }
  function therSet(m, vol) {
    var v = therVoice(); stats.ther = mtof(m); if (!v) return;
    var t = ac.currentTime, f = mtof(m), tc = S.snap ? 0.03 : 0.012;
    if (!v.on) { v.o.frequency.setValueAtTime(f, t); v.o2.frequency.setValueAtTime(2 * f, t); }
    else { v.o.frequency.setTargetAtTime(f, t, tc); v.o2.frequency.setTargetAtTime(2 * f, t, tc); }
    v.g.gain.setTargetAtTime(0.32 * vol * vol, t, 0.04); v.on = true;
  }
  function therOff() { if (ther && ther.on) { ther.g.gain.setTargetAtTime(0, ac.currentTime, 0.08); ther.on = false; } }
  function therKill() {
    if (!ther) return; var t = ac.currentTime;
    ther.g.gain.setTargetAtTime(0, t, 0.05); [ther.o, ther.o2, ther.lfo].forEach(function (o) { try { o.stop(t + 0.4); } catch (e) {} }); ther = null;
  }
  function interactTheremin(now) {
    var ph = null, vh = null;
    hands.forEach(function (h) { var pitchSide = S.lefty ? h.c[0] < W / 2 : h.c[0] >= W / 2; if (pitchSide) { if (!ph) ph = h; } else if (!vh) vh = h; });
    if (!ph && vh && hands.length === 1) { ph = vh; vh = null; }           // one hand: it sets the pitch, volume stays medium
    if (!ph) { if (!Object.keys(pointers).length) { therOff(); therState.tip = null; } return; }
    var tip = ph.pts[8], m = therMap(tip[1]), vol = vh ? clamp((0.92 * H - vh.pts[8][1]) / (0.8 * H), 0, 1) : 0.7;
    therState.tip = tip; therState.m = m; therState.vol = vol; therState.vtip = vh ? vh.pts[8] : null;
    therTrail.push({ x: tip[0], y: tip[1], t: now }); if (therTrail.length > 40) therTrail.shift();
    therSet(m, vol);
  }

  /* ---------- drawing the new instruments ---------- */
  function keyLabel(m) { var pc = ((m % 12) + 12) % 12; return S.names === 'sargam' ? SARGAM[(pc - S.key + 12) % 12] : WEST[pc] + (pc === 0 ? Math.floor(m / 12) - 1 : ''); }
  function drawKeys(now, k) {
    var whites = keys.filter(function (x) { return !x.black; }), blacks = keys.filter(function (x) { return x.black; });
    whites.forEach(function (key) {
      var f = Math.max(0, 1 - (now - key.t) / 400);
      ctx.fillStyle = key.on ? 'rgba(61,220,151,.78)' : 'rgba(255,255,255,' + (0.22 + 0.3 * f) + ')'; rrect(key.x, key.y, key.w, key.h, 6 * k); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1 * k; rrect(key.x, key.y, key.w, key.h, 6 * k); ctx.stroke();
      ctx.font = '600 ' + Math.min(13 * k, key.w * 0.36) + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = key.on ? '#04261a' : 'rgba(255,255,255,.85)';
      ctx.fillText(keyLabel(key.midi), key.x + key.w / 2, key.y + key.h - 10 * k);
    });
    blacks.forEach(function (key) {
      ctx.fillStyle = key.on ? 'rgba(61,220,151,.95)' : 'rgba(12,14,20,.86)'; rrect(key.x, key.y, key.w, key.h, 5 * k); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1 * k; rrect(key.x, key.y, key.w, key.h, 5 * k); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(61,220,151,.6)'; ctx.lineWidth = 2 * k; ctx.beginPath(); ctx.moveTo(0, keySurf); ctx.lineTo(W, keySurf); ctx.stroke();
    seenHands().forEach(function (h) {                                     // where each finger is aiming, and how far it is bent
      FINGERS.forEach(function (f) {
        var x = h.pts[f[0]][0], key = keyForX(x), on = h.kd && h.kd[f[0]], b = h.kb && h.kb[f[0]], bend = b ? clamp((1 - flexRatio(h, f) / b) / 0.24, 0, 1) : 0;
        if (!key) return;
        ctx.fillStyle = on ? 'rgba(61,220,151,.95)' : 'rgba(255,255,255,' + (0.35 + 0.5 * bend) + ')';
        ctx.beginPath(); ctx.moveTo(x, keySurf + 4 * k); ctx.lineTo(x - 7 * k, keySurf - 9 * k); ctx.lineTo(x + 7 * k, keySurf - 9 * k); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.15 + 0.35 * bend) + ')'; ctx.lineWidth = 1 * k; ctx.setLineDash([3 * k, 4 * k]);
        ctx.beginPath(); ctx.moveTo(x, h.pts[f[0]][1]); ctx.lineTo(x, keySurf - 10 * k); ctx.stroke(); ctx.setLineDash([]);
      });
    });
  }
  function disc(c, r) { ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 6.283); }
  function drawAim(k) {                                                    // the striking fingertip; fills while a stroke is on its way down
    seenHands().forEach(function (h) {
      var p = h.pts[8], armed = h.sk && h.sk.armedAt;
      ctx.strokeStyle = armed ? 'rgba(255,220,120,1)' : 'rgba(255,255,255,.8)'; ctx.lineWidth = 2.5 * k; disc(p, 13 * k); ctx.stroke();
      if (armed) { ctx.fillStyle = 'rgba(255,220,120,.55)'; disc(p, 13 * k); ctx.fill(); }
    });
  }
  function drawPads(now, k) {
    pads.forEach(function (pd) {
      var f = Math.max(0, 1 - (now - pd.t) / 300), hue = PAD_HUE[pd.id], cym = pd.id === 'hihat' || pd.id === 'crash' || pd.id === 'ride';
      var gr = ctx.createRadialGradient(pd.c[0], pd.c[1], pd.r * 0.1, pd.c[0], pd.c[1], pd.r);
      gr.addColorStop(0, 'hsla(' + hue + ',' + (cym ? 80 : 30) + '%,' + (cym ? 70 : 85) + '%,' + (0.25 + 0.5 * f) + ')');
      gr.addColorStop(1, 'hsla(' + hue + ',' + (cym ? 75 : 40) + '%,' + (cym ? 45 : 55) + '%,' + (0.2 + 0.35 * f) + ')');
      ctx.fillStyle = gr; disc(pd.c, pd.r); ctx.fill();
      ctx.strokeStyle = 'hsla(' + hue + ',70%,75%,' + (0.6 + 0.4 * f) + ')'; ctx.lineWidth = 2.5 * k; disc(pd.c, pd.r); ctx.stroke();
      if (cym) { ctx.strokeStyle = 'hsla(' + hue + ',60%,80%,.35)'; ctx.lineWidth = 1 * k; [0.35, 0.6, 0.82].forEach(function (s) { disc(pd.c, pd.r * s); ctx.stroke(); }); }
      if (f > 0) { ctx.strokeStyle = 'hsla(' + hue + ',90%,80%,' + f + ')'; ctx.lineWidth = 3 * k; disc(pd.c, pd.r * (1 + 0.35 * (1 - f))); ctx.stroke(); }
      ctx.font = '700 ' + 15 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText(PAD_NAMES[pd.id], pd.c[0], pd.c[1]); ctx.textBaseline = 'alphabetic';
    });
  }
  function drawTabla(now, k) {
    tpads.forEach(function (pd) {
      var f = Math.max(0, 1 - (now - pd.t) / 300), big = pd.id === 'bayan' || pd.id === 'dayan';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (big) {
        ctx.fillStyle = pd.id === 'bayan' ? 'rgba(160,130,95,.6)' : 'rgba(120,75,40,.65)'; disc(pd.c, pd.r * 1.07); ctx.fill();
        ctx.fillStyle = 'rgba(236,220,186,' + (0.55 + 0.3 * f) + ')'; disc(pd.c, pd.r); ctx.fill();
        var sc = pd.id === 'bayan' ? [pd.c[0] + (S.lefty ? 1 : -1) * 0.22 * pd.r, pd.c[1]] : pd.c, srr = pd.id === 'bayan' ? 0.38 * pd.r : 0.5 * pd.r;
        ctx.fillStyle = 'rgba(28,24,26,.9)'; disc(sc, srr); ctx.fill();
        ctx.font = '700 ' + 16 * k + 'px system-ui,sans-serif';
        if (pd.id === 'dayan') { ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText('Tin', pd.c[0], pd.c[1]); ctx.fillStyle = 'rgba(60,40,25,.9)'; ctx.fillText('Na', pd.c[0], pd.c[1] - 0.75 * pd.r); }
        else { ctx.fillStyle = 'rgba(60,40,25,.9)'; ctx.fillText('Ge', pd.c[0] + (S.lefty ? -1 : 1) * 0.45 * pd.r, pd.c[1]); }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.15 + 0.45 * f) + ')'; disc(pd.c, pd.r); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.5 * k; disc(pd.c, pd.r); ctx.stroke();
        ctx.font = '700 ' + 15 * k + 'px system-ui,sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(pd.bol, pd.c[0], pd.c[1]);
      }
      if (f > 0) { ctx.strokeStyle = 'rgba(255,220,150,' + f + ')'; ctx.lineWidth = 3 * k; disc(pd.c, pd.r * (1 + 0.25 * (1 - f))); ctx.stroke(); }
      ctx.textBaseline = 'alphabetic';
    });
    if (geVoice && geVoice.lift > 0.05) {
      var b = tpads[0]; ctx.strokeStyle = 'rgba(255,200,120,.95)'; ctx.lineWidth = 4 * k;
      ctx.beginPath(); ctx.arc(b.c[0], b.c[1], b.r * 1.15, -Math.PI / 2, -Math.PI / 2 + geVoice.lift * Math.PI); ctx.stroke();
      ctx.font = '600 ' + 13 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,220,160,.95)'; ctx.fillText('meend', b.c[0], b.c[1] + b.r * 1.3);
    }
  }
  function drawTheremin(now, k) {
    var rx = lx(0.94 * W), mx = lx(0.06 * W), top = 0.08 * H, bot = 0.92 * H, root = therRoot(), steps = SCALES[S.scale].steps;
    function yOf(m) { return bot - (m - root) / 24 * (bot - top); }
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.moveTo(rx, top); ctx.lineTo(rx, bot); ctx.stroke();
    ctx.font = '600 ' + 11 * k + 'px system-ui,sans-serif'; ctx.textAlign = S.lefty ? 'left' : 'right'; ctx.textBaseline = 'middle';
    for (var m = root; m <= root + 24; m++) {
      var inScale = steps.indexOf((m - root) % 12) >= 0, isRoot = (m - root) % 12 === 0;
      if (S.snap && !inScale) continue;
      var y = yOf(m), len = (isRoot ? 16 : inScale ? 10 : 5) * k, dir = S.lefty ? 1 : -1;
      ctx.strokeStyle = isRoot ? 'rgba(61,220,151,.9)' : 'rgba(255,255,255,.55)'; ctx.lineWidth = (isRoot ? 2.5 : 1.5) * k;
      ctx.beginPath(); ctx.moveTo(rx, y); ctx.lineTo(rx + dir * len, y); ctx.stroke();
      if (inScale) { ctx.fillStyle = isRoot ? 'rgba(61,220,151,.95)' : 'rgba(255,255,255,.7)'; ctx.fillText(noteName(m), rx + dir * (len + 4 * k), y); }
    }
    ctx.textBaseline = 'alphabetic';
    var vol = therState.tip ? therState.vol : 0;                           // volume meter
    ctx.fillStyle = 'rgba(255,255,255,.12)'; rrect(mx - 7 * k, top, 14 * k, bot - top, 7 * k); ctx.fill();
    ctx.fillStyle = 'rgba(61,220,151,.85)'; rrect(mx - 7 * k, bot - vol * (bot - top), 14 * k, vol * (bot - top), 7 * k); ctx.fill();
    ctx.font = '600 ' + 12 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText('volume', mx, top - 10 * k);
    if (!therState.tip) return;
    var tip = therState.tip, hue = hueOf(therState.m), ty = yOf(therState.m);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 1; i < therTrail.length; i++) {
      var a = therTrail[i - 1], b = therTrail[i], al = Math.max(0, 1 - (now - b.t) / 900);
      ctx.strokeStyle = 'hsla(' + hue + ',90%,65%,' + al * 0.8 + ')'; ctx.lineWidth = 6 * k * al; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    var wob = 3 * k * Math.sin(now / 28);
    ctx.strokeStyle = 'hsla(' + hue + ',90%,70%,.35)'; ctx.lineWidth = 10 * k; ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.quadraticCurveTo((tip[0] + rx) / 2, (tip[1] + ty) / 2 + wob, rx, ty); ctx.stroke();
    ctx.strokeStyle = 'hsla(' + hue + ',90%,85%,.95)'; ctx.lineWidth = 2 * k; ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.quadraticCurveTo((tip[0] + rx) / 2, (tip[1] + ty) / 2 + wob, rx, ty); ctx.stroke();
    ctx.fillStyle = 'hsla(' + hue + ',90%,80%,1)'; disc([rx, ty], 7 * k); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '800 ' + 24 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'hsl(' + hue + ',90%,82%)';
    ctx.fillText(noteName(therState.m), tip[0], tip[1] - 26 * k);
  }

  /* ---------- touch for the new instruments ---------- */
  function pointerDownInst(id, p, now) {
    var q = pointers[id];
    if (S.mode === 'keys') { var kk = keyAt(p); if (kk) q.kd = { key: kk, vel: 0.7, v: keyNoteOn(kk, 0.7) }; }
    else if (S.mode === 'drums') { var pd = nearestIn(pads, p); if (pd) hitPad(pd, 0.75, now); }
    else if (S.mode === 'tabla') { var tp = nearestIn(tpads, p); if (tp) hitTabla(tp, tablaBol(tp, p), 0.75, now, null); }
    else if (S.mode === 'theremin') { q.ther = true; therPointer(p); }
  }
  function pointerMoveInst(q, p) {
    if (S.mode === 'keys' && q.kd) { var kk = keyAt(p); if (kk && kk !== q.kd.key) { keyNoteOff(q.kd.key, q.kd.v); q.kd.key = kk; q.kd.v = keyNoteOn(kk, q.kd.vel); } }
    else if (S.mode === 'theremin' && q.ther) therPointer(p);
  }
  function pointerUpInst(q) {
    if (q.kd) { keyNoteOff(q.kd.key, q.kd.v); q.kd = null; }
    if (q.ther && !seenHands().length) { therOff(); therState.tip = null; }
  }
  function therPointer(p) { var m = therMap(p[1]); therState.tip = p; therState.m = m; therState.vol = 0.7; therTrail.push({ x: p[0], y: p[1], t: performance.now() }); if (therTrail.length > 40) therTrail.shift(); therSet(m, 0.7); }
  function nearestIn(list, p) { var best = null; list.forEach(function (pd) { var d = dist(p, pd.c); if (d <= pd.r && (!best || d / pd.r < best.d)) best = { pd: pd, d: d / pd.r }; }); return best && best.pd; }

  /* ================= touch and mouse ================= */
  function toCanvas(e) {
    var r = canvas.getBoundingClientRect(), sc = Math.min(r.width / W, r.height / H);
    return [(e.clientX - r.left - (r.width - W * sc) / 2) / sc, (e.clientY - r.top - (r.height - H * sc) / 2) / sc];
  }
  canvas.addEventListener('pointerdown', function (e) {
    initAudio(); try { canvas.setPointerCapture(e.pointerId); } catch (er) {}
    var p = toCanvas(e), now = performance.now(); pointers[e.pointerId] = { p: p, t: now };
    pointerDownInst(e.pointerId, p, now);
    if (S.mode === 'strum') zones.forEach(function (z, i) { if (p[0] >= z.x && p[0] <= z.x + z.w && p[1] >= z.y && p[1] <= z.y + z.h) { chordIdx = i; tuneStrum(); } });
    pointerLive(now);
  });
  canvas.addEventListener('pointermove', function (e) {
    var q = pointers[e.pointerId]; if (!q) return;
    var p = toCanvas(e), now = performance.now();
    if (S.mode === 'strings' || S.mode === 'strum') { if (!plive) sweep(q.p, p, Math.max(8, now - q.t), now); }
    else pointerMoveInst(q, p);
    q.p = p; q.t = now; pointerLive(now);
  });
  function endPointer(e) { var q = pointers[e.pointerId]; if (!q) return; delete pointers[e.pointerId]; pointerUpInst(q); pointerLive(performance.now()); }
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  function pointerLive(now) {
    var ids = Object.keys(pointers);
    if (S.mode === 'strings' && ids.length >= 2) { var src = { live: plive }; makeLive(pointers[ids[0]].p, pointers[ids[1]].p, now, src); plive = src.live; }
    else if (plive) { commit(plive, now); plive = null; }
  }

  /* ================= effects ================= */
  function sparks(s, x, y, vel, muted) {
    var dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, hue = s.midi === null ? 0 : hueOf(s.midi);
    var n = muted ? 4 : Math.round(10 + 26 * vel);
    for (var i = 0; i < n; i++) {
      var along = (Math.random() - 0.5) * 0.5 * l, sp = (0.15 + Math.random() * 0.6) * DIAG * (0.4 + vel), side = Math.random() < 0.5 ? -1 : 1;
      particles.push({ x: x + dx / l * along, y: y + dy / l * along, vx: nx * sp * side * Math.random() + dx / l * (Math.random() - 0.5) * sp * 0.4,
        vy: ny * sp * side * Math.random() + dy / l * (Math.random() - 0.5) * sp * 0.4, life: 0, max: 0.35 + Math.random() * 0.55, hue: hue, sat: muted ? 0 : 90 });
    }
    if (particles.length > 700) particles.splice(0, particles.length - 700);
  }
  function burst(s, n) {
    for (var i = 0; i < n; i++) {
      var u = Math.random(), x = s.a[0] + (s.b[0] - s.a[0]) * u, y = s.a[1] + (s.b[1] - s.a[1]) * u, ang = Math.random() * 6.283, sp = Math.random() * 0.3 * DIAG;
      particles.push({ x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 0.5 + Math.random() * 0.5, hue: s.midi === null ? 0 : hueOf(s.midi), sat: 70 });
    }
  }

  /* ================= drawing ================= */
  /* A plucked string's shape is a sum of standing waves: harmonic k has amplitude
     sin(kπp)/k² for a pluck at p, so a pluck near the end sounds and looks brighter. */
  function stringPath(s, now) {
    var n = 36, dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, pts = [], act = false;
    var vs = s.vib.filter(function (v) { return now - v.t0 < 2500; }); s.vib = vs;
    for (var i = 0; i <= n; i++) {
      var u = i / n, d = 0;
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j], t = (now - v.t0) / 1000, A = v.amp * Math.min(0.045 * l, 0.03 * DIAG) * Math.exp(-t / 0.55);
        if (A < 0.3) continue; act = true;
        for (var k = 1; k <= 3; k++) d += A * Math.sin(k * Math.PI * v.p) / (k * k) * Math.sin(k * Math.PI * u) * Math.cos(2 * Math.PI * 13 * k * t);
      }
      pts.push([s.a[0] + dx * u + nx * d, s.a[1] + dy * u + ny * d]);
    }
    return { pts: pts, act: act };
  }
  function strokePath(pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke(); }
  function drawString(s, now, k) {
    var sp = stringPath(s, now), hue = s.midi === null ? 0 : hueOf(s.midi), sat = s.midi === null ? 0 : 90;
    var flash = Math.max(0, 1 - (now - s.last) / 600), born = clamp((now - (s.born || 0)) / 300, 0, 1);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'hsla(' + hue + ',' + sat + '%,65%,' + (0.12 + 0.25 * flash) * born + ')'; ctx.lineWidth = (10 + 10 * flash) * k; strokePath(sp.pts);
    ctx.strokeStyle = 'hsla(' + hue + ',' + sat + '%,' + (72 + 18 * flash) + '%,' + 0.95 * born + ')'; ctx.lineWidth = (s.gauge || 2.2) * k; strokePath(sp.pts);
    if (!s.strum) {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      [s.a, s.b].forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 * k, 0, 6.283); ctx.fill(); });
      var m = mid(s.a, s.b); ctx.font = '600 ' + 12 * k + 'px system-ui,sans-serif'; ctx.fillStyle = 'hsla(' + hue + ',80%,80%,.7)'; ctx.textAlign = 'center';
      ctx.fillText(noteName(s.midi), m[0], m[1] - 12 * k);
    }
  }
  function drawLive(L, now, k) {
    var a = L.a, b = L.b, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, hue = hueOf(L.midi);
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = 'hsla(' + hue + ',90%,70%,.25)'; ctx.lineWidth = 9 * k; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([7 * k, 6 * k]); ctx.lineDashOffset = -now / 30; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
    var step = 0.025 * DIAG, nT = Math.floor(l / step);                   // ruler ticks, the longer ones every fifth
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.2 * k;
    for (var i = 1; i < nT; i++) { var t = i * step / l, h = (i % 5 === 0 ? 9 : 5) * k, px = a[0] + dx * t, py = a[1] + dy * t; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + nx * h, py + ny * h); ctx.stroke(); }
    [a, b].forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 9 * k, 0, 6.283); ctx.stroke(); });
    var m = mid(a, b), ok = L.len >= 0.1 * DIAG;
    ctx.font = '700 ' + 20 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = ok ? 'hsl(' + hue + ',90%,78%)' : 'rgba(255,255,255,.5)';
    ctx.fillText(ok ? noteName(L.midi) : 'pull apart', m[0] - nx * 22 * k, m[1] - ny * 22 * k);
    ctx.restore();
  }
  function drawHands(k) {
    hands.forEach(function (h) {
      if (h.hits < 2) return;
      if (S.skeleton) {
        ctx.strokeStyle = 'rgba(74,222,128,.9)'; ctx.lineWidth = 2.2 * k; ctx.lineCap = 'round';
        BONES.forEach(function (bn) { ctx.beginPath(); ctx.moveTo(h.pts[bn[0]][0], h.pts[bn[0]][1]); ctx.lineTo(h.pts[bn[1]][0], h.pts[bn[1]][1]); ctx.stroke(); });
        ctx.fillStyle = 'rgba(239,68,68,.95)';
        h.pts.forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.2 * k, 0, 6.283); ctx.fill(); });
      }
      ctx.strokeStyle = h.pinch ? '#fff' : 'rgba(255,255,255,.55)'; ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(h.pp[0], h.pp[1], (h.pinch ? 7 : 5) * k, 0, 6.283); ctx.stroke();
      if (h.pinch) { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(h.pp[0], h.pp[1], 3 * k, 0, 6.283); ctx.fill(); }
      (S.mode === 'keys' ? TIPS : [8, 12]).forEach(function (i) { if (h.pinch && i === 8 && (S.mode === 'strings' || S.mode === 'strum')) return; if (S.mode === 'keys' && h.kd && h.kd[i]) { ctx.fillStyle = '#3ddc97'; ctx.beginPath(); ctx.arc(h.pts[i][0], h.pts[i][1], 8 * k, 0, 6.283); ctx.fill(); } ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(h.pts[i][0], h.pts[i][1], 4.5 * k, 0, 6.283); ctx.fill(); });
    });
  }
  function drawStrum(now, k) {
    var r = strum[0], body = { x: r.a[0], y: strum[0].a[1], w: r.b[0] - r.a[0], h: strum[5].a[1] - strum[0].a[1] };
    ctx.fillStyle = 'rgba(10,14,20,.35)'; rrect(body.x - 10 * k, body.y - 22 * k, body.w + 20 * k, body.h + 44 * k, 14 * k); ctx.fill();
    zones.forEach(function (z, i) {
      var on = i === chordIdx;
      ctx.fillStyle = on ? 'rgba(61,220,151,.85)' : 'rgba(10,14,20,.5)'; rrect(z.x, z.y, z.w, z.h, 10 * k); ctx.fill();
      ctx.strokeStyle = on ? '#3ddc97' : 'rgba(255,255,255,.18)'; ctx.lineWidth = 1.5 * k; rrect(z.x, z.y, z.w, z.h, 10 * k); ctx.stroke();
      ctx.fillStyle = on ? '#04261a' : 'rgba(255,255,255,.85)'; ctx.font = '700 ' + Math.min(26 * k, z.h * 0.5) + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(z.name, z.x + z.w / 2, z.y + z.h / 2);
    });
    ctx.textBaseline = 'alphabetic';
    strum.forEach(function (s) { drawString(s, now, k); });
    ctx.font = '600 ' + 13 * k + 'px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textAlign = 'center';
    ctx.fillText('strum here', body.x + body.w / 2, body.y + body.h + 38 * k);
  }
  function rrect(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  var lastFrame = 0;
  function render(now) {
    requestAnimationFrame(render);
    var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016; lastFrame = now;
    var r = canvas.getBoundingClientRect(), k = r.width ? Math.max(1, 1 / Math.min(r.width / W, r.height / H)) : 1;
    if (running && video.readyState >= 2) {
      ctx.save(); if (facing === 'user') { ctx.translate(W, 0); ctx.scale(-1, 1); } ctx.drawImage(video, 0, 0, W, H); ctx.restore();
      ctx.fillStyle = 'rgba(6,8,12,.28)'; ctx.fillRect(0, 0, W, H);
    } else { ctx.fillStyle = '#07090d'; ctx.fillRect(0, 0, W, H); }
    ctx.globalCompositeOperation = 'lighter';
    if (S.mode === 'strum') { ctx.globalCompositeOperation = 'source-over'; drawStrum(now, k); ctx.globalCompositeOperation = 'lighter'; }
    else if (S.mode === 'strings') strings.forEach(function (s) { drawString(s, now, k); });
    else {
      ctx.globalCompositeOperation = 'source-over';
      if (S.mode === 'keys') drawKeys(now, k); else if (S.mode === 'drums') { drawPads(now, k); drawAim(k); } else if (S.mode === 'tabla') { drawTabla(now, k); drawAim(k); } else drawTheremin(now, k);
      ctx.globalCompositeOperation = 'lighter';
    }
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i]; p.life += dt; if (p.life > p.max) { particles.splice(i, 1); continue; }
      p.vx *= 0.92; p.vy = p.vy * 0.92 + 0.15 * DIAG * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      var a = 1 - p.life / p.max; ctx.strokeStyle = 'hsla(' + p.hue + ',' + p.sat + '%,75%,' + a + ')'; ctx.lineWidth = 1.6 * k;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (i = labels.length - 1; i >= 0; i--) {
      var L = labels[i], age = (now - L.t0) / 1000; if (age > 1.1) { labels.splice(i, 1); continue; }
      ctx.font = '700 ' + 18 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'hsla(' + L.hue + ',90%,80%,' + (1 - age / 1.1) + ')';
      ctx.fillText(L.text, L.x, L.y - 18 * k - age * 40 * k);
    }
    if (live) drawLive(live, now, k); if (plive) drawLive(plive, now, k);
    if (holdDel) {
      var f = clamp((now - holdDel.t0) / 800, 0, 1);
      ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 3 * k; ctx.beginPath(); ctx.arc(holdDel.p[0], holdDel.p[1], 16 * k, -Math.PI / 2, -Math.PI / 2 + f * 6.283); ctx.stroke();
    }
    drawHands(k);
    if (S.mode === 'strum') {
      ctx.font = '800 ' + 30 * k + 'px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText(CHORD_SETS[S.chords][chordIdx], lx(0.735 * W), 0.24 * H);
    }
    if (rec) { ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(22 * k, 22 * k, 7 * k, 0, 6.283); ctx.fill(); ctx.font = '700 ' + 13 * k + 'px system-ui'; ctx.textAlign = 'left'; ctx.fillText('REC', 34 * k, 27 * k); }
  }

  /* ================= camera ================= */
  function seenHands() { return hands.filter(function (h) { return h.hits >= 2; }); }
  function pill() { var n = seenHands().length; $('pill').textContent = !ready ? 'loading…' : (running ? (fps < 10 ? fps.toFixed(1) : fps.toFixed(0)) + ' fps · ' + n + (n === 1 ? ' hand' : ' hands') : 'ready'); }
  function hint() {
    var any = seenHands().length;
    if (S.mode === 'keys') return any ? 'Bend a finger to press the key it points at. Straighten it to let go.' : 'Hold your hands up, fingers straight, above the keyboard.';
    if (S.mode === 'drums') return any ? 'Strike down at a pad and stop sharply, like a drumstick.' : 'Show your hands to the camera, then strike down at the pads.';
    if (S.mode === 'tabla') return any ? 'Strike down and stop: dayan rim for Na, black centre for Tin, bayan for Ge.' : 'Show both hands to the camera.';
    if (S.mode === 'theremin') return any ? 'Raise the ' + (S.lefty ? 'left' : 'right') + '-side hand for higher notes; the other hand sets the volume.' : 'Show your hands to the camera.';
    if (S.mode === 'strum') return hands.length ? 'Point at a chord with one hand. Sweep the other hand’s fingers across the strings.' : 'Show both hands to the camera.';
    if (!seenHands().length) return 'Show your hands to the camera, palms facing it, in good light.';
    if (live) return 'Pull apart to stretch, open your fingers to place the string.';
    if (!strings.length) return 'Pinch thumb and index on both hands, then pull apart.';
    return 'Sweep a fingertip through a string to pluck it. Pinch one string and hold to delete it.';
  }
  async function detectLoop(g) {
    while (running && g === gen) {
      if (video.readyState >= 2 && video.videoWidth) {
        setSize(video.videoWidth, video.videoHeight);
        var t0 = performance.now(), dets, mirror = facing === 'user';
        try { dets = await detectNow(mirror); } catch (e) { status('Tracking error: ' + (e && e.message ? e.message : e), 'bad'); await sleep(300); continue; }
        if (!running || g !== gen) return;
        var now = performance.now();
        if (lastDet) { var inst = 1000 / (now - lastDet); fps = fps ? fps * 0.85 + inst * 0.15 : inst; } lastDet = now;
        if (!testHold) processHands(dets, now);
        pill(); status(hint());
        await sleep(Math.max(1, 16 - (now - t0)));                       // always yield, so drawing and touch stay responsive
      } else await sleep(50);
    }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function stopCamera() {
    releaseAll(); therState.tip = null;
    running = false; gen++;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    hands = []; live = null;
  }
  async function startCamera() {
    initAudio();
    if (!ready) { status('Hand tracking is still loading, one moment…'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('No camera here. Open this page from an https:// address. You can still play by touch.', 'bad'); return; }
    stopCamera();
    var h = S.quality === 'lite' ? 480 : 720;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h }, frameRate: { ideal: 30 } } }); }
    catch (e) { status('Camera could not start: ' + (e && e.name === 'NotAllowedError' ? 'permission was refused. You can still play by touch.' : (e && e.message) || e), 'bad'); return; }
    video.srcObject = stream; try { await video.play(); } catch (e) {}
    $('placeholder').style.display = 'none'; $('startBtn').textContent = 'Restart'; $('flipBtn').disabled = false; $('recBtn').disabled = false;
    running = true; lastDet = 0; fps = 0;
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    detectLoop(gen);
  }

  /* ================= recording ================= */
  var rec = null, chunks = [];
  function toggleRec() {
    if (rec) { rec.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) { toast('This browser cannot record here.'); return; }
    initAudio();
    var tracks = canvas.captureStream(30).getVideoTracks();
    if (recDest) tracks = tracks.concat(recDest.stream.getAudioTracks());
    var types = ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'], mime = '';
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) { mime = types[i]; break; }
    try { rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 5e6 } : undefined); }
    catch (e) { rec = null; toast('Recording could not start.'); return; }
    chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      var type = (rec && rec.mimeType) || mime || 'video/webm', blob = new Blob(chunks, { type: type });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'air-guitar-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (/mp4/.test(type) ? '.mp4' : '.webm');
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      rec = null; $('recBtn').textContent = 'Record'; $('recBtn').classList.remove('on');
    };
    rec.start(500); $('recBtn').textContent = 'Stop'; $('recBtn').classList.add('on');
  }

  /* ================= controls ================= */
  function setMode(m) {
    releaseAll(); therState.tip = null;
    S.mode = m; saveS(); live = null; plive = null; holdDel = null;
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === m); });
    $('undoBtn').style.display = $('clearBtn').style.display = m === 'strings' ? '' : 'none';
    document.querySelectorAll('[data-modes]').forEach(function (el) { el.style.display = el.dataset.modes.split(' ').indexOf(m) >= 0 ? '' : 'none'; });
    prewarm();
    renderHelp(); status(running ? hint() : (ready ? 'Ready. Press Start, or play by touch.' : 'Loading hand tracking…'));
  }
  function renderHelp() {
    var h = $('help'), side = S.lefty ? 'left' : 'right', other = S.lefty ? 'right' : 'left';
    var HELP = {
      keys: '<p><b>Play:</b> hold your hands up, fingers straight, above the keyboard. Each finger’s position picks a key, marked on the keyboard. <b>Bend a finger</b> to press its key, as on a real keyboard, and straighten it to let go. Several fingers make a chord; a quicker bend plays louder. A closed fist is silent.</p>' +
        '<p><b>Piano</b> is a recorded Steinway grand. <b>Harmonium</b> holds the note while the finger stays bent. Turn on Sustain pedal to let piano notes ring. On a touch screen, press the keys directly.</p>',
      drums: '<p><b>Play:</b> strike down at a pad with your index finger, as if holding a stick, and stop sharply. The hit lands where your stroke stops; a faster stroke plays louder. Moving sideways, upward or slowly makes no sound.</p><p>The kit is a recorded jazz drum kit. On a touch screen, tap the pads.</p>',
      tabla: '<p><b>Dayan</b> (' + side + '): strike the rim for <b>Na</b>, the black centre for <b>Tin</b>, and the small pad beside it for <b>Te</b>. <b>Bayan</b> (' + other + '): strike it for <b>Ge</b>, the small pad for <b>Ke</b>. Na or Tin with Ge at the same moment sound <b>Dha</b> or <b>Dhin</b>.</p>' +
        '<p><b>Play:</b> strike down with your index finger and stop sharply on the spot. <b>Meend:</b> after a Ge, lift that hand to bend the bayan’s pitch upward. The dayan is tuned to Sa, set by Key. Left-handed swaps the drums.</p>',
      theremin: '<p><b>Pitch:</b> your ' + side + '-side hand sets the note. Raise its index finger for higher notes, along the scale drawn on the ' + side + '. <b>Volume:</b> raise your other hand for louder. With one hand only, the volume stays medium.</p>' +
        '<p>With Snap to scale on, the pitch glides from note to note of the chosen scale or raag. Turn it off for a fully continuous, singing pitch. On a touch screen, drag up and down.</p>'
    };
    if (HELP[S.mode]) { h.innerHTML = HELP[S.mode]; return; }
    h.innerHTML = S.mode === 'strings'
      ? '<p><b>Make a string:</b> pinch thumb and index finger on both hands, then pull your hands apart. A ruler shows the note. Open your fingers to leave the string in the air.</p>' +
        '<p><b>Play:</b> sweep a fingertip through a string. A faster sweep plays louder, and plucking near the end sounds brighter. Shorter strings play higher notes, as on a real string.</p>' +
        '<p><b>Delete:</b> pinch one string with one hand and hold for a moment. On a touch screen, use two fingers to stretch a string and one to pluck.</p>'
      : '<p><b>Chords:</b> point with your ' + (S.lefty ? 'right' : 'left') + '-side hand at a chord on the ' + (S.lefty ? 'right' : 'left') + '. <b>Strum:</b> sweep your other hand’s fingers up or down across the six strings. Each string sounds in the order your fingers cross it, like a real strum.</p>' +
        '<p>Try “Power chords” with the Electric sound. On a touch screen, tap a chord and swipe across the strings.</p>';
  }
  function fillSelects() {
    var sc = $('scale'); Object.keys(SCALES).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = SCALES[k].name; sc.appendChild(o); });
    var ky = $('key'); WEST.forEach(function (n, i) { var o = document.createElement('option'); o.value = i; o.textContent = n + ' (' + SARGAM[0] + ' = ' + n + ')'; ky.appendChild(o); });
    [['tone', 'tone'], ['scale', 'scale'], ['key', 'key'], ['names', 'names'], ['chords', 'chords'], ['quality', 'quality'], ['keysel', 'keys'], ['octave', 'octave']].forEach(function (p) {
      var el = $(p[0]); el.value = String(S[p[1]]);
      el.addEventListener('change', function () {
        S[p[1]] = p[1] === 'key' || p[1] === 'octave' ? parseInt(el.value, 10) : el.value; saveS();
        if (p[1] === 'keys' || p[1] === 'octave') { releaseAll(); layoutKeys(); prewarm(); preloadPiano(); }
        if (p[1] === 'key') tablaCache = {};
        if (p[1] === 'tone') { bufCache = {}; cacheKeys = []; applyTone(); }
        if (p[1] === 'scale' || p[1] === 'key') retune();
        if (p[1] === 'chords') { chordIdx = 0; layoutStrum(); }
        if (p[1] === 'quality' && engine === 'mp') { mpHands.setOptions({ modelComplexity: S.quality === 'lite' ? 0 : 1 }); return; }
        if (p[1] === 'quality' && human) { human.config.hand.skeleton.modelPath = S.quality === 'lite' ? 'handlandmark-lite.json' : 'handlandmark-full.json'; reloadModels(); }
      });
    });
  }
  async function reloadModels() {
    var was = running; stopCamera(); ready = false; pill(); status('Loading hand tracking…');
    try { human.models.reset ? human.models.reset() : null; } catch (e) {}
    try { var Hm = window.Human.Human || window.Human, c = cfg(); c.backend = human.tf.getBackend(); human = new Hm(c); await human.load(); ready = true; pill(); if (was) startCamera(); else status('Ready.'); }
    catch (e) { status('Hand tracking could not load: ' + (e && e.message ? e.message : e), 'bad'); }
  }
  function retune() { strings.forEach(function (s) { s.midi = lengthToMidi(s.len); }); }
  document.querySelectorAll('[data-set]').forEach(function (el) {
    el.checked = !!S[el.dataset.set];
    el.addEventListener('change', function () { S[el.dataset.set] = el.checked; saveS();
      if (el.dataset.set === 'reverb') applyTone(); if (el.dataset.set === 'snap') retune(); if (el.dataset.set === 'lefty') { layoutAll(); renderHelp(); } });
  });
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.addEventListener('click', function () { initAudio(); setMode(b.dataset.mode); }); });
  $('startBtn').addEventListener('click', startCamera);
  $('flipBtn').addEventListener('click', function () { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
  $('undoBtn').addEventListener('click', function () { if (strings.length) removeString(strings[strings.length - 1]); });
  $('clearBtn').addEventListener('click', function () { strings.slice().forEach(removeString); });
  $('recBtn').addEventListener('click', toggleRec);
  document.addEventListener('visibilitychange', async function () { if (!document.hidden && running && !wakeLock) { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} } });

  /* ================= boot ================= */
  if (['strings', 'strum', 'keys', 'drums', 'tabla', 'theremin'].indexOf(S.mode) < 0) S.mode = 'strings';
  fillSelects(); layoutAll(); setMode(S.mode); requestAnimationFrame(render);
  (async function () {
    try { await initEngine(); status('Ready. Press Start, or play by touch.'); }
    catch (e) { status('Hand tracking could not load: ' + (e && e.message ? e.message : e) + '. You can still play by touch.', 'bad'); }
  })();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').then(function (r) { r.update(); }).catch(function () {});

  window.AirGuitar = {   // for testing
    feed: function (dets, t) { processHands(dets, t || performance.now()); }, hold: function (v) { testHold = v; }, setSize: setSize,
    get hands() { return hands; }, get strings() { return strings; }, get strum() { return strum; }, get live() { return live; },
    get chord() { return CHORD_SETS[S.chords][chordIdx]; }, get keys() { return keys; }, get keySurf() { return keySurf; }, get pads() { return pads; }, get tpads() { return tpads; }, get geVoice() { return geVoice; }, get ther() { return therState; }, setMode: setMode, get smp() { return Object.keys(smpCache); }, stats: stats, S: S, get human() { return human; }, get engine() { return engine; },
    lengthToMidi: lengthToMidi, initAudio: initAudio, ksBuffer: function (f, u, v) { initAudio(); return ksBuffer(f, u, v); }, get ac() { return ac; }
  };
})();
