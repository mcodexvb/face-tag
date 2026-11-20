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

  var DEFAULTS = { mode: 'strings', tone: 'acoustic', scale: 'minpent', key: 9, names: 'western', chords: 'pop',
                   snap: true, skeleton: true, reverb: true, lefty: false, quality: 'full' };
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
  var human = null, ready = false, running = false, gen = 0, stream = null, facing = 'user', wakeLock = null;
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
  function setSize(w, h) { if (w === W && h === H) return; W = w; H = h; DIAG = Math.hypot(W, H); canvas.width = W; canvas.height = H; $('stage').style.aspectRatio = W + ' / ' + H; layoutStrum(); }

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
  async function initEngine() {
    var Hm = window.Human && (window.Human.Human || window.Human);
    human = new Hm(cfg());
    var order = ['webgl', 'wasm', 'cpu'], ok = false;
    if (FORCE_BACKEND) order = [FORCE_BACKEND].concat(order.filter(function (b) { return b !== FORCE_BACKEND; }));
    for (var i = 0; i < order.length && !ok; i++) { try { human.config.backend = order[i]; await human.init(); ok = human.tf.getBackend() === order[i]; } catch (e) { ok = false; } }
    await human.load();
    try { await human.warmup(); } catch (e) {}
    ready = true; pill();
  }
  function palm(p) { var x = 0, y = 0; [0, 5, 9, 13, 17].forEach(function (i) { x += p[i][0]; y += p[i][1]; }); return [x / 5, y / 5]; }
  /* dets: arrays of 21 [x, y] points already in screen (mirrored) coordinates. */
  function processHands(dets, now) {
    var info = dets.map(function (p) { return { p: p, c: palm(p), s: Math.max(8, dist(p[0], p[9])) }; });
    var uniq = [];
    info.forEach(function (d) { if (!uniq.some(function (u) { return dist(u.c, d.c) < 0.6 * Math.max(u.s, d.s); })) uniq.push(d); });
    var pairs = [];
    hands.forEach(function (h, hi) { uniq.forEach(function (d, di) { var dd = dist(h.c, d.c); if (dd < 1.6 * Math.max(h.s, d.s)) pairs.push({ hi: hi, di: di, d: dd }); }); });
    pairs.sort(function (a, b) { return a.d - b.d; });
    var usedH = {}, usedD = {};
    pairs.forEach(function (q) { if (usedH[q.hi] || usedD[q.di]) return; usedH[q.hi] = usedD[q.di] = true; updateHand(hands[q.hi], uniq[q.di], now); });
    uniq.forEach(function (d, di) {
      if (usedD[di]) return;
      var beta = 5 / DIAG, h = { id: ++handSeq, filt: [], pts: null, prev: null, pinch: false, seen: now, releasedAt: 0, born: now, hits: 0 };
      for (var i = 0; i < 21; i++) h.filt.push([new OneEuro(1.6, beta), new OneEuro(1.6, beta)]);
      updateHand(h, d, now); h.prev = null; hands.push(h);
    });
    hands = hands.filter(function (h) { return now - h.seen < 300; });
    var all = hands; hands = all.filter(function (h) { return h.hits >= 2; });
    interact(now); hands = all;
  }
  function updateHand(h, d, now) {
    var gap = now - h.seen;
    h.prev = h.pts && gap < 260 ? h.pts : null;                        // only compare with a recent reading: no phantom sweeps
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
    if (!L || L.len < 0.1 * DIAG || now - L.born < 120) return null;
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
    if (S.mode === 'strings') interactStrings(now); else interactStrum(now);
    hands.forEach(function (h) {
      if (!h.prev || h.pinch || now - h.releasedAt < 250) return;
      [8, 12].forEach(function (k) { sweep(h.prev[k], h.pts[k], h.dt, now); });
    });
  }

  /* ================= touch and mouse ================= */
  function toCanvas(e) {
    var r = canvas.getBoundingClientRect(), sc = Math.min(r.width / W, r.height / H);
    return [(e.clientX - r.left - (r.width - W * sc) / 2) / sc, (e.clientY - r.top - (r.height - H * sc) / 2) / sc];
  }
  canvas.addEventListener('pointerdown', function (e) {
    initAudio(); try { canvas.setPointerCapture(e.pointerId); } catch (er) {}
    var p = toCanvas(e), now = performance.now(); pointers[e.pointerId] = { p: p, t: now };
    if (S.mode === 'strum') zones.forEach(function (z, i) { if (p[0] >= z.x && p[0] <= z.x + z.w && p[1] >= z.y && p[1] <= z.y + z.h) { chordIdx = i; tuneStrum(); } });
    pointerLive(now);
  });
  canvas.addEventListener('pointermove', function (e) {
    var q = pointers[e.pointerId]; if (!q) return;
    var p = toCanvas(e), now = performance.now();
    if (!plive) sweep(q.p, p, Math.max(8, now - q.t), now);
    q.p = p; q.t = now; pointerLive(now);
  });
  function endPointer(e) { if (!pointers[e.pointerId]) return; delete pointers[e.pointerId]; pointerLive(performance.now()); }
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
      [8, 12].forEach(function (i) { if (h.pinch && i === 8) return; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(h.pts[i][0], h.pts[i][1], 4.5 * k, 0, 6.283); ctx.fill(); });
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
    else strings.forEach(function (s) { drawString(s, now, k); });
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
        var t0 = performance.now(), res;
        try { res = await human.detect(video); } catch (e) { status('Tracking error: ' + (e && e.message ? e.message : e), 'bad'); await sleep(300); continue; }
        if (!running || g !== gen) return;
        var now = performance.now();
        if (lastDet) { var inst = 1000 / (now - lastDet); fps = fps ? fps * 0.85 + inst * 0.15 : inst; } lastDet = now;
        if (!testHold) {
          var mirror = facing === 'user';
          // the detector's box score is often low for real hands; the finger model's own score is the reliable signal
          var dets = (res.hand || []).filter(function (h) { return h.keypoints && h.keypoints.length === 21 && (h.fingerScore || 0) + 0.5 * (h.score || 0) >= 0.7; })
            .map(function (h) { return h.keypoints.map(function (q) { return [mirror ? W - q[0] : q[0], q[1]]; }); });
          processHands(dets, now);
        }
        pill(); status(hint());
        await sleep(Math.max(1, 16 - (now - t0)));                       // always yield, so drawing and touch stay responsive
      } else await sleep(50);
    }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function stopCamera() {
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
    S.mode = m; saveS(); live = null; plive = null; holdDel = null;
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === m); });
    $('undoBtn').disabled = $('clearBtn').disabled = m === 'strum';
    renderHelp(); status(running ? hint() : (ready ? 'Ready. Press Start, or play by touch.' : 'Loading hand tracking…'));
  }
  function renderHelp() {
    var h = $('help');
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
    [['tone', 'tone'], ['scale', 'scale'], ['key', 'key'], ['names', 'names'], ['chords', 'chords'], ['quality', 'quality']].forEach(function (p) {
      var el = $(p[0]); el.value = String(S[p[1]]);
      el.addEventListener('change', function () {
        S[p[1]] = p[1] === 'key' ? parseInt(el.value, 10) : el.value; saveS();
        if (p[1] === 'tone') { bufCache = {}; cacheKeys = []; applyTone(); }
        if (p[1] === 'scale' || p[1] === 'key') retune();
        if (p[1] === 'chords') { chordIdx = 0; layoutStrum(); }
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
      if (el.dataset.set === 'reverb') applyTone(); if (el.dataset.set === 'snap') retune(); if (el.dataset.set === 'lefty') { layoutStrum(); renderHelp(); } });
  });
  document.querySelectorAll('#modeSeg button').forEach(function (b) { b.addEventListener('click', function () { initAudio(); setMode(b.dataset.mode); }); });
  $('startBtn').addEventListener('click', startCamera);
  $('flipBtn').addEventListener('click', function () { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
  $('undoBtn').addEventListener('click', function () { if (strings.length) removeString(strings[strings.length - 1]); });
  $('clearBtn').addEventListener('click', function () { strings.slice().forEach(removeString); });
  $('recBtn').addEventListener('click', toggleRec);
  document.addEventListener('visibilitychange', async function () { if (!document.hidden && running && !wakeLock) { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} } });

  /* ================= boot ================= */
  fillSelects(); layoutStrum(); setMode(S.mode); requestAnimationFrame(render);
  (async function () {
    if (typeof window.Human === 'undefined') { status('Hand tracking did not load. Check the connection and reload. You can still play by touch.', 'bad'); return; }
    try { await initEngine(); status('Ready. Press Start, or play by touch.'); }
    catch (e) { status('Hand tracking could not load: ' + (e && e.message ? e.message : e) + '. You can still play by touch.', 'bad'); }
  })();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').then(function (r) { r.update(); }).catch(function () {});

  window.AirGuitar = {   // for testing
    feed: function (dets, t) { processHands(dets, t || performance.now()); }, hold: function (v) { testHold = v; }, setSize: setSize,
    get hands() { return hands; }, get strings() { return strings; }, get strum() { return strum; }, get live() { return live; },
    get chord() { return CHORD_SETS[S.chords][chordIdx]; }, stats: stats, S: S, get human() { return human; },
    lengthToMidi: lengthToMidi, initAudio: initAudio, ksBuffer: function (f, u, v) { initAudio(); return ksBuffer(f, u, v); }, get ac() { return ac; }
  };
})();
