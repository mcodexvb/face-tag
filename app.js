/* Face Tag 3 — multi-face tracking, age estimate, recognition and name tags, all in the browser.
   Engine: Human by Vladimir Mandic (MIT), https://github.com/vladmandic/human

   Design: two engine instances.
     A "tracker"  : face detector only, runs on every frame, feeds a multi-object tracker.
     B "analyst"  : full pipeline (mesh, signature, age, emotion, spoof), runs on a zoomed
                    crop of ONE tracked face at a time, scheduled by need.
   Each track collects its own evidence, and names are assigned across all faces at once so
   that one person can never label two faces. */
(function () {
  'use strict';

  /* ================= constants and settings ================= */
  var CDN_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/human-models@3.0.4/models/';
  var MODELS = location.protocol === 'file:' ? CDN_MODELS : './models/';
  var MATCH_OPTS = { order: 2, multiplier: 25, min: 0.2, max: 0.8 };   // tuned for the faceres signature
  var MAX_MANUAL = 12, MAX_AUTO = 8, MAX_NEG = 10, OBS_KEEP = 6, CROP = 320;
  var LIVE_MIN = 0.3;                                                    // spoof score below this = probably a photo or screen
  var GUEST_COLORS = ['#6cb6ff', '#c297ff', '#ff9bce', '#7ee0e0', '#f2cc60', '#ffa07a'];
  var $ = function (id) { return document.getElementById(id); };
  var QUERY = new URLSearchParams(location.search), FORCE_BACKEND = QUERY.get('backend'), WASM_PATH = QUERY.get('wasm');   // for testing

  var DEFAULTS = { threshold: 0.5, res: '720', showAge: true, showGender: true, showEmotion: false, showConf: false, showMesh: false,
                   blurUnknown: false, announce: false, requireLive: true, thumbs: true, learn: true, guests: true, effect: 'none', showLabels: true };
  var S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem('facetag-settings-v3') || localStorage.getItem('facetag-settings-v2') || '{}')); } catch (e) {}
  function saveSettings() { try { localStorage.setItem('facetag-settings-v3', JSON.stringify(S)); } catch (e) {} }

  /* ================= state ================= */
  var video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d'), stage = $('stage');
  var crop = document.createElement('canvas'), cropCtx = crop.getContext('2d');
  var qCan = document.createElement('canvas'); qCan.width = qCan.height = 48; var qCtx = qCan.getContext('2d', { willReadFrequently: true });
  var pix = document.createElement('canvas'); pix.width = pix.height = 10; var pixCtx = pix.getContext('2d');
  var frameCan = document.createElement('canvas'), frameCtx = frameCan.getContext('2d'), fxMsg = '';
  function fxOn() { return S.effect && S.effect !== 'none' && (window.FaceFX || window.FaceFX2); }
  function fx2On() { return window.FaceFX2 && window.FaceFX2.has(S.effect); }
  /* Person segmentation for background effects: a small separate engine, run on a 256-pixel copy of the picture. */
  var humanS = null, segBusy = false, segCan = document.createElement('canvas'), segCtx = segCan.getContext('2d');
  async function segment(pic) {
    if (segBusy || !pic || !pic.width || !window.FaceFX2) return; segBusy = true;
    try {
      if (!humanS) {
        var Hm = window.Human.Human || window.Human;
        humanS = new Hm({ modelBasePath: MODELS, backend: humanA.tf.getBackend(), debug: false, cacheSensitivity: 0, filter: { enabled: true, equalization: false },
          face: { enabled: false }, body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false },
          segmentation: { enabled: true, modelPath: 'selfie.json', mode: 'alpha' } });
        await humanS.load();
      }
      var w = 256, h = Math.max(64, Math.round(256 * pic.height / pic.width));
      if (segCan.width !== w || segCan.height !== h) { segCan.width = w; segCan.height = h; }
      segCtx.drawImage(pic, 0, 0, w, h);
      var t = await humanS.segmentation(segCan);
      if (t) { var d = await t.data(); humanS.tf.dispose(t); window.FaceFX2.setMask(d, w, h); }
    } catch (e) { console.warn('segmentation failed', e); }
    segBusy = false;
  }
  var humanA = null, humanB = null, ready = false;
  var running = false, loopGen = 0, facing = 'user', stream = null, wakeLock = null, torchOn = false;
  var mode = 'camera';                 // 'camera' | 'photo'
  var photos = [], photoIdx = -1, photoCanvas = null;
  var people = [], guests = [], guestSeq = 0, idMap = {};
  var tracks = [], trackSeq = 0, lastT = 0, frameMs = 100;   // frameMs: smoothed time between frames, so timeouts adapt to slow devices
  var sess = {};                       // identity id -> { first, last, ms, ages:[], lastAgeAt }
  var spoken = {}, enrol = null, fps = 0, lastFrame = 0, lastFaceAt = 0, dirty = {}, flushTimer = null;

  /* ================= small helpers ================= */
  function status(msg, cls) { var s = $('status'); if (s.textContent !== msg) s.textContent = msg; s.className = cls || ''; }
  var toastTimer;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3400); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function median(a) { if (!a || !a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
  function mean(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sim(a, b) { return humanA.match.similarity(a, b, MATCH_OPTS); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function mkBtn(label, fn, cls, disabled) { var b = el('button', cls || 'small', label); b.type = 'button'; b.disabled = !!disabled; b.addEventListener('click', fn); return b; }
  function pill() {
    var b = humanA && humanA.tf && humanA.tf.getBackend ? humanA.tf.getBackend() : '…';
    var shown = tracks.filter(isVisible).length;
    $('pill').textContent = !ready ? 'loading…' : (running ? (fps < 10 ? fps.toFixed(1) : fps.toFixed(0)) + ' fps · ' + shown + (shown === 1 ? ' face' : ' faces') : b + ' ready');
  }
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ================= storage ================= */
  var db = null;
  function idb() {
    return new Promise(function (res) {
      try { var rq = indexedDB.open('facetag', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('people', { keyPath: 'id' }); };
        rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function dbReq(modeName, fn) {
    return new Promise(function (res) {
      if (!db) return res(null);
      try { var t = db.transaction('people', modeName), r = fn(t.objectStore('people'));
        t.oncomplete = function () { res(r && r.result !== undefined ? r.result : true); }; t.onerror = t.onabort = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function serial(p) { return { id: p.id, name: p.name, created: p.created, thumb: p.thumb, ages: p.ages, samples: p.samples, negatives: p.negatives }; }
  function dbPut(p) { return p.guest ? Promise.resolve(true) : dbReq('readwrite', function (s) { return s.put(serial(p)); }); }
  function dbDel(id) { return dbReq('readwrite', function (s) { return s.delete(id); }); }
  function normalise(p) {            // accepts records written by earlier versions
    p.samples = (p.samples || []).map(function (s) {
      if (s && s.v) return { v: s.v instanceof Float32Array ? s.v : new Float32Array(s.v), auto: !!s.auto, q: s.q || 0.6 };
      return { v: s instanceof Float32Array ? s : new Float32Array(s), auto: false, q: 0.6 };
    });
    p.negatives = (p.negatives || []).map(function (n) { return n instanceof Float32Array ? n : new Float32Array(n); });
    p.ages = p.ages || []; p.guest = false; return p;
  }
  function markDirty(p) {
    if (p.guest) return; dirty[p.id] = p;
    if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; var d = dirty; dirty = {}; Object.keys(d).forEach(function (k) { if (people.indexOf(d[k]) >= 0) dbPut(d[k]); }); }, 4000);
  }

  /* ================= identities (saved people + session guests) ================= */
  function identities() { return people.concat(guests); }
  function thrFor(idn) { return idn.guest ? Math.max(S.threshold, 0.5) + 0.04 : S.threshold; }
  function findPerson(name) { var k = name.trim().toLowerCase(); return people.filter(function (p) { return p.name.toLowerCase() === k; })[0] || null; }
  function newPerson(name) { var p = { id: uid(), name: name.trim(), guest: false, samples: [], negatives: [], thumb: null, ages: [], created: Date.now() }; people.push(p); return p; }
  function scoreIdentity(emb, idn) {
    var s = 0, i, v;
    for (i = 0; i < idn.samples.length; i++) { v = sim(emb, idn.samples[i].v); if (v > s) s = v; }
    if (idn.negatives && idn.negatives.length) {
      var n = 0; for (i = 0; i < idn.negatives.length; i++) { v = sim(emb, idn.negatives[i]); if (v > n) n = v; }
      if (n >= s - 0.02 && n >= S.threshold) return 0;        // the user said "not this person" about a face like this one
    }
    return s;
  }
  function topMatches(emb) {
    var all = identities(), out = [];
    for (var i = 0; i < all.length; i++) { var s = scoreIdentity(emb, all[i]); if (s > 0.2) out.push({ id: all[i].id, sim: s }); }
    out.sort(function (a, b) { return b.sim - a.sim; }); return out.slice(0, 4);
  }
  function allTrackLists() { var l = [tracks]; photos.forEach(function (p) { if (p.tracks && p.tracks !== tracks) l.push(p.tracks); }); return l; }
  /* Call after anything about people/guests/samples changes. */
  function changed() {
    idMap = {}; identities().forEach(function (i) { idMap[i.id] = i; });
    allTrackLists().forEach(function (list) { list.forEach(function (t) { t.obs.forEach(function (o) { o.top = topMatches(o.emb); }); }); });
    renderPeople(); renderSession();
    if (mode === 'photo') { photos.forEach(function (p) { if (p.tracks) resolveIdentities(p.tracks, true); }); renderStrip(); render(); }
    else resolveIdentities(tracks, false);
  }
  function addSamples(idn, embs, auto) {
    embs.forEach(function (e) { idn.samples.push({ v: new Float32Array(e.v), auto: !!auto, q: e.q || 0.6 }); });
    var man = idn.samples.filter(function (s) { return !s.auto; }), aut = idn.samples.filter(function (s) { return s.auto; });
    while (man.length > MAX_MANUAL) man.shift();
    while (aut.length > MAX_AUTO) aut.shift();
    idn.samples = man.concat(aut);
  }
  function dropGuest(g, intoId) { guests = guests.filter(function (x) { return x !== g; }); if (intoId) mergeSession(g.id, intoId); else delete sess[g.id]; }
  function mergeSession(fromId, toId) {
    var a = sess[fromId]; if (!a) return; var b = sess[toId];
    if (!b) sess[toId] = a; else { b.first = Math.min(b.first, a.first); b.last = Math.max(b.last, a.last); b.ms += a.ms; b.ages = b.ages.concat(a.ages).slice(-80); }
    delete sess[fromId];
  }

  /* ================= dialog ================= */
  var dlgResolve = null, dlgPrimary = null;
  function dlg(o) {
    return new Promise(function (resolve) {
      if (dlgResolve) { var r = dlgResolve; dlgResolve = null; r(null); }
      dlgResolve = resolve; dlgPrimary = null;
      $('dlgTitle').textContent = o.title || '';
      $('dlgBody').textContent = o.body || ''; $('dlgBody').style.display = o.body ? '' : 'none';
      var ex = $('dlgExtra'); ex.textContent = ''; if (o.extra) ex.appendChild(o.extra);
      var inp = $('dlgInput');
      if (o.input) {
        inp.style.display = ''; inp.type = o.input.type || 'text'; inp.value = o.input.value || ''; inp.placeholder = o.input.placeholder || '';
        inp.required = !o.input.optional; inp.autocomplete = inp.type === 'password' ? 'new-password' : 'off';
        if (inp.type === 'password') inp.removeAttribute('list'); else inp.setAttribute('list', 'names');
      } else { inp.style.display = 'none'; inp.required = false; inp.value = ''; }
      var box = $('dlgBtns'); box.textContent = ''; box.className = 'btns' + (o.stack ? ' stack' : '');
      (o.buttons || [{ label: 'OK', value: 'ok', primary: true }]).forEach(function (b) {
        var e = el('button', (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), b.label);
        e.type = b.primary ? 'submit' : 'button';
        if (b.primary) dlgPrimary = b.value; else e.addEventListener('click', function () { dlgDone(b.value); });
        box.appendChild(e);
      });
      $('dlg').classList.add('open');
      if (o.input) setTimeout(function () { inp.focus(); inp.select(); }, 40);
    });
  }
  function dlgDone(value) {
    var text = $('dlgInput').value.trim();
    $('dlg').classList.remove('open'); var r = dlgResolve; dlgResolve = null;
    if (r) r(value == null ? null : { value: value, text: text });
  }
  $('dlgForm').addEventListener('submit', function (e) { e.preventDefault(); dlgDone(dlgPrimary); });
  $('dlg').addEventListener('click', function (e) { if (e.target === $('dlg')) dlgDone(null); });
  function ask(title, o) {
    o = o || {};
    return dlg({ title: title, body: o.body, input: { value: o.value, placeholder: o.placeholder, type: o.type, optional: o.optional },
      buttons: [{ label: 'Cancel', value: null }, { label: o.ok || 'OK', value: 'ok', primary: true }] }).then(function (r) { return r ? r.text : null; });
  }

  /* ================= engine ================= */
  function cfgA() {
    var c = { modelBasePath: MODELS, backend: 'webgl', cacheSensitivity: 0, debug: false, filter: { enabled: true, equalization: false },
      face: { enabled: true, detector: { modelPath: 'blazeface.json', maxDetected: 12, minConfidence: 0.3, iouThreshold: 0.1, rotation: false, return: false },
        mesh: { enabled: false, modelPath: 'facemesh.json' }, iris: { enabled: false }, description: { enabled: false }, emotion: { enabled: false },
        antispoof: { enabled: false }, liveness: { enabled: false } },
      body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false } };
    if (WASM_PATH) c.wasmPath = WASM_PATH;
    return c;
  }
  function cfgB() {
    var c = cfgA();
    c.face.detector.maxDetected = 2; c.face.detector.minConfidence = 0.2;
    c.face.mesh.enabled = true;
    c.face.description = { enabled: true, modelPath: 'faceres.json' };
    c.face.emotion = { enabled: true, modelPath: 'emotion.json' };
    c.face.antispoof = { enabled: true, modelPath: 'antispoof.json' };
    return c;
  }
  async function initEngine() {
    var H = window.Human && (window.Human.Human || window.Human);
    humanA = new H(cfgA());
    var order = ['webgl', 'wasm', 'cpu'], ok = false;
    if (FORCE_BACKEND && order.indexOf(FORCE_BACKEND) >= 0) order = [FORCE_BACKEND].concat(order.filter(function (b) { return b !== FORCE_BACKEND; }));
    for (var i = 0; i < order.length && !ok; i++) {
      try { humanA.config.backend = order[i]; await humanA.init(); ok = humanA.tf.getBackend() === order[i]; } catch (e) { ok = false; }
    }
    await humanA.load();
    var c = cfgB(); c.backend = humanA.tf.getBackend(); humanB = new H(c);
    await humanB.load();
    try { await humanA.warmup(); await humanB.warmup(); } catch (e) {}
    ready = true; pill();
  }

  /* ================= multi-face tracker ================= */
  function iou(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    var i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), u = a.w * a.h + b.w * b.h - i; return u > 0 ? i / u : 0;
  }
  function toDets(faces) {
    var d = (faces || []).map(function (f) { var b = f.box; return { x: b[0], y: b[1], w: b[2], h: b[3], score: f.boxScore || f.score || 0, mesh: f.mesh }; })
      .filter(function (d) { return d.w >= 20 && d.h >= 20; }).sort(function (a, b) { return b.score - a.score; });
    var keep = [];
    d.forEach(function (x) { if (!keep.some(function (k) { return iou(k, x) > 0.45; })) keep.push(x); });
    return keep;
  }
  function newTrack(d, now) {
    return { id: ++trackSeq, box: { x: d.x, y: d.y, w: d.w, h: d.h }, vx: 0, vy: 0, hits: 1, born: now, seen: now, confirmed: false, mesh: d.mesh,
      obs: [], ages: [], genders: [], reals: [], emotion: null, parts: null, rot: null, thumb: null, thumbQ: 0, analysedAt: 0, bFail: 0, newObs: false,
      idn: null, sure: false, sim: 0, prevId: null, cands: [], ageAt: 0 };
  }
  function updateTracks(dets, now) {
    var dt = lastT ? Math.min(1, (now - lastT) / 1000) : 0;
    if (lastT) frameMs = frameMs * 0.7 + Math.min(3000, now - lastT) * 0.3;
    lastT = now;
    var pairs = [];
    tracks.forEach(function (t, ti) {
      var p = { x: t.box.x + t.vx * dt, y: t.box.y + t.vy * dt, w: t.box.w, h: t.box.h };
      var gate = now - t.seen < Math.max(450, 1.6 * frameMs) ? 0.9 : 1.5;
      dets.forEach(function (d, di) {
        var ratio = Math.min(p.w, d.w) / Math.max(p.w, d.w); if (ratio < 0.4) return;
        var io = iou(p, d), sz = (p.w + d.w) / 2, dist = Math.hypot(p.x + p.w / 2 - d.x - d.w / 2, p.y + p.h / 2 - d.y - d.h / 2);
        if (io > 0.05 || dist < gate * sz) pairs.push({ ti: ti, di: di, c: (1 - io) + 0.5 * dist / sz });
      });
    });
    pairs.sort(function (a, b) { return a.c - b.c; });
    var usedT = {}, usedD = {};
    pairs.forEach(function (p) {
      if (usedT[p.ti] || usedD[p.di]) return; usedT[p.ti] = usedD[p.di] = true;
      var t = tracks[p.ti], d = dets[p.di], a = 0.65;
      if (dt > 0) {
        var nvx = (d.x + d.w / 2 - t.box.x - t.box.w / 2) / dt, nvy = (d.y + d.h / 2 - t.box.y - t.box.h / 2) / dt;
        t.vx = 0.5 * t.vx + 0.5 * nvx; t.vy = 0.5 * t.vy + 0.5 * nvy;
      }
      t.box.x += (d.x - t.box.x) * a; t.box.y += (d.y - t.box.y) * a; t.box.w += (d.w - t.box.w) * a; t.box.h += (d.h - t.box.h) * a;
      t.hits++; t.seen = now; if (t.hits >= 3) t.confirmed = true;
      if (d.mesh && t.mesh && d.mesh.length === t.mesh.length) t.mesh = d.mesh.map(function (p, i) { var q = t.mesh[i]; return [q[0] + (p[0] - q[0]) * 0.6, q[1] + (p[1] - q[1]) * 0.6, p[2]]; });   // light smoothing: effects stay steady
      else t.mesh = d.mesh;
    });
    tracks.forEach(function (t, ti) { if (!usedT[ti]) { t.vx *= 0.5; t.vy *= 0.5; } });
    dets.forEach(function (d, di) { if (!usedD[di]) tracks.push(newTrack(d, now)); });
    tracks = tracks.filter(function (t) { return now - t.seen < (t.confirmed ? Math.max(1100, 3.5 * frameMs) : Math.max(260, 2.2 * frameMs)); });
  }
  function isVisible(t) { return t.static || (t.confirmed && lastT - t.seen < Math.max(320, 1.6 * frameMs) && !(t.bFail >= 4 && !t.obs.length)); }

  /* ================= analysis of one face ================= */
  function nextDue(now) {
    var best = null, bp = 0;
    tracks.forEach(function (t) {
      if (!t.confirmed || t.seen !== now) return;
      var p;
      if (enrol && enrol.track === t) p = 1e9;
      else if (!t.analysedAt) p = 1e6 + t.box.w * t.box.h;
      else {
        var age = now - t.analysedAt;
        var every = t.bFail >= 4 && !t.obs.length ? 1500 : (t.idn && t.sure && !t.idn.guest ? 1200 : (t.obs.length >= OBS_KEEP ? 700 : 180));
        if (age < every) return; p = age / every;
      }
      if (p > bp) { bp = p; best = t; }
    });
    return best;
  }
  function measure(src, b) {            // size, sharpness and lighting of the face region
    var size = clamp((Math.min(b.w, b.h) - 36) / 110, 0, 1), sharp = 0.5, light = 0.5;
    try {
      qCtx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, 48, 48);
      var d = qCtx.getImageData(0, 0, 48, 48).data, g = new Float32Array(2304), m = 0, i;
      for (i = 0; i < 2304; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; m += g[i]; }
      m /= 2304; var v = 0, n = 0;
      for (var y = 1; y < 47; y++) for (var x = 1; x < 47; x++) { i = y * 48 + x; var l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 48] - g[i + 48]; v += l * l; n++; }
      sharp = clamp((v / n) / 160, 0, 1); light = clamp((m - 30) / 45, 0, 1) * clamp((252 - m) / 30, 0, 1);
    } catch (e) {}
    return { size: size, sharp: sharp, light: light, pose: 0.5, q: 0 };
  }
  function thumbFromCrop(fx, fy, fw) {
    try { var c = document.createElement('canvas'); c.width = c.height = 96; var s = fw * 1.5;
      var g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 96, 96);
      g.drawImage(crop, fx - s / 2, fy - s / 2, s, s, 0, 0, 96, 96); return c.toDataURL('image/jpeg', 0.74);
    } catch (e) { return null; }
  }
  async function analyse(t, src, sw, sh, now) {
    t.analysedAt = now;
    var b = t.box, side = Math.max(b.w, b.h) * 1.8, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    var x0 = Math.max(0, cx - side / 2), y0 = Math.max(0, cy - side / 2), x1 = Math.min(sw, cx + side / 2), y1 = Math.min(sh, cy + side / 2);
    var cw = x1 - x0, ch = y1 - y0; if (cw < 16 || ch < 16) return null;
    var sc = CROP / Math.max(cw, ch);
    crop.width = Math.max(32, Math.round(cw * sc)); crop.height = Math.max(32, Math.round(ch * sc));
    cropCtx.drawImage(src, x0, y0, cw, ch, 0, 0, crop.width, crop.height);
    var parts = measure(src, b);                           // measured before the await, on the same frame we cropped
    var res; try { res = await humanB.detect(crop); } catch (e) { return null; }
    var ex = (cx - x0) * sc, ey = (cy - y0) * sc, best = null, bd = 1e9;
    (res.face || []).forEach(function (f) {
      if (!f.embedding || !f.embedding.length) return;
      var d = Math.hypot(f.box[0] + f.box[2] / 2 - ex, f.box[1] + f.box[3] / 2 - ey); if (d < bd) { bd = d; best = f; }
    });
    if (!best || bd > 0.4 * Math.max(crop.width, crop.height)) { t.bFail++; return null; }
    t.bFail = 0;
    var a = best.rotation && best.rotation.angle;
    parts.pose = a ? 1 - clamp(Math.max(Math.abs(a.yaw) / 0.65, Math.abs(a.pitch) / 0.55), 0, 1) : 0.5;
    parts.q = (0.35 * parts.size + 0.25 * parts.pose + 0.2 * parts.sharp + 0.2 * parts.light) * ((best.faceScore || best.score || 0) > 0.5 ? 1 : 0.6);
    var o = { emb: best.embedding, q: parts.q, w: 0.35 + 0.65 * parts.q, t: now, top: topMatches(best.embedding) };
    // a strong, contradicting reading means the track changed hands: forget older evidence at once
    if (t.idn && o.top[0] && o.top[0].id !== t.idn.id && idMap[o.top[0].id] && o.top[0].sim >= thrFor(idMap[o.top[0].id]) + 0.1) {
      var cur = o.top.filter(function (c) { return c.id === t.idn.id; })[0];
      if (!cur || cur.sim < thrFor(t.idn) - 0.1) { t.obs = []; t.ages = []; t.genders = []; t.reals = []; t.thumbQ = 0; }
    }
    t.obs.push(o); if (t.obs.length > OBS_KEEP) t.obs.shift();
    if (typeof best.age === 'number' && best.age > 0 && (t.static || parts.q > 0.25)) { t.ages.push(best.age); if (t.ages.length > 15) t.ages.shift(); }
    if (best.gender && best.genderScore > 0.15) { t.genders.push(best.gender); if (t.genders.length > 15) t.genders.shift(); }
    if (typeof best.real === 'number') { t.reals.push(best.real); if (t.reals.length > 8) t.reals.shift(); }
    var em = best.emotion && best.emotion[0]; t.emotion = em && em.score > 0.4 ? em.emotion : null;
    t.parts = parts; t.rot = a || null; t.newObs = true;
    if (parts.q > t.thumbQ + 0.06 || !t.thumb) { var th = thumbFromCrop(best.box[0] + best.box[2] / 2, best.box[1] + best.box[3] / 2, Math.max(best.box[2], best.box[3])); if (th) { t.thumb = th; t.thumbQ = parts.q; } }
    return o;
  }
  function liveScore(t) { return t.reals.length >= 2 ? mean(t.reals) : null; }
  function liveOk(t) { var l = liveScore(t); return t.static || l == null || l >= LIVE_MIN; }

  /* ================= who is who: joint assignment over all faces ================= */
  function resolveIdentities(list, isStatic) {
    var props = [];
    list.forEach(function (t) {
      t.cands = []; var n = t.obs.length; if (!n) return;
      var agg = {}, W = 0;
      t.obs.forEach(function (o) { W += o.w; o.top.forEach(function (c) { agg[c.id] = (agg[c.id] || 0) + o.w * c.sim; }); });
      var arr = Object.keys(agg).map(function (id) { return { idn: idMap[id], s: agg[id] / W }; }).filter(function (c) { return c.idn; })
        .sort(function (a, b) { return b.s - a.s; });
      t.cands = arr;
      arr.forEach(function (c, i) {
        var thr = thrFor(c.idn); if (c.s < thr - 0.06) return;
        var strong = c.s >= thr && (isStatic || n >= 2 || c.s >= thr + 0.12) && (i > 0 || !arr[1] || c.s - arr[1].s >= 0.03);
        props.push({ t: t, idn: c.idn, s: c.s, strong: strong, key: c.s + (t.prevId === c.idn.id ? 0.03 : 0) });
      });
    });
    props.sort(function (a, b) { return b.key - a.key; });
    var doneT = [], usedI = {};
    props.forEach(function (p) {                              // best evidence first; each person and each face is used once
      if (doneT.indexOf(p.t) >= 0 || usedI[p.idn.id]) return;
      doneT.push(p.t); usedI[p.idn.id] = true; p.t.idn = p.idn; p.t.sim = p.s; p.t.sure = p.strong;
    });
    list.forEach(function (t) { if (doneT.indexOf(t) < 0) { t.idn = null; t.sure = false; t.sim = 0; } t.prevId = t.idn ? t.idn.id : null; });
  }
  function goodEmbs(t, minQ, max) {
    var out = [];
    t.obs.slice().sort(function (a, b) { return b.q - a.q; }).forEach(function (o) {
      if (o.q < minQ || out.length >= max) return;
      if (!out.some(function (e) { return sim(e.v, o.emb) > 0.93; })) out.push({ v: o.emb, q: o.q });
    });
    return out;
  }
  /* Runs after names are assigned on a live frame: session log, learning, guests, guided capture. */
  function afterResolve(now, dtMs) {
    var listsChanged = false, logChanged = false;
    tracks.forEach(function (t) {
      if (!isVisible(t)) return;
      var idn = t.idn;
      if (idn && t.sure) {
        var s = sess[idn.id];
        if (!s) { s = sess[idn.id] = { first: Date.now(), last: 0, ms: 0, ages: [], lastAgeAt: 0 }; logChanged = true; if (!idn.guest) greet(idn.name); }
        if (Date.now() - s.last > 1500) logChanged = true;
        s.ms += Math.min(dtMs, 1500); s.last = Date.now();
        var am = t.ages.length >= 3 ? median(t.ages) : null;
        if (am != null && now - s.lastAgeAt > 2500) { s.lastAgeAt = now; s.ages.push(am); if (s.ages.length > 80) s.ages.shift(); }
        if (am != null && !idn.guest && now - t.ageAt > 30000) { t.ageAt = now; idn.ages.push(Math.round(am * 10) / 10); if (idn.ages.length > 40) idn.ages.shift(); markDirty(idn); }
        if (t.newObs) {                                                         // learn a new angle of someone we are sure about
          var o = t.obs[t.obs.length - 1], sc = scoreIdentity(o.emb, idn);
          if ((idn.guest || S.learn) && o.q >= 0.55 && t.obs.length >= 3 && sc >= thrFor(idn) + 0.12 && sc < 0.9 && liveOk(t)) {
            addSamples(idn, [{ v: o.emb, q: o.q }], true); markDirty(idn);
          }
          if (idn.guest && t.thumb && t.thumbQ > (idn.thumbQ || 0)) { idn.thumb = t.thumb; idn.thumbQ = t.thumbQ; }
        }
      } else if (!idn && S.guests && t.obs.length >= 3) {                       // a stranger seen clearly enough: give a steady guest label
        var top = t.cands[0];
        if (!top || top.s < thrFor(top.idn) - 0.06) {
          var embs = goodEmbs(t, 0.35, 5);
          if (embs.length) {
            var g = { id: 'g' + uid(), guest: true, n: ++guestSeq, name: 'Guest ' + guestSeq, samples: [], negatives: [], thumb: t.thumb, thumbQ: t.thumbQ, ages: [], created: Date.now() };
            addSamples(g, embs, false); guests.push(g); listsChanged = true;
          }
        }
      }
      if (t.newObs && enrol && enrol.track === t) stepEnrol(t);
      t.newObs = false;
    });
    if (listsChanged) changed(); else if (logChanged) renderSession();
  }
  function greet(name) {
    if (!S.announce || !('speechSynthesis' in window)) return;
    var t = Date.now(); if (spoken[name] && t - spoken[name] < 60000) return; spoken[name] = t;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('Hello ' + name)); } catch (e) {}
  }

  /* ================= drawing ================= */
  function colorOf(t) {
    if (!t.idn) return '#9aa3b2';
    if (t.idn.guest) return GUEST_COLORS[(t.idn.n - 1) % GUEST_COLORS.length];
    return t.sure ? '#3ddc97' : '#ffb454';
  }
  function ageText(t) {
    var a = null, sp = null;
    if (t.ages.length >= 3) { a = median(t.ages); if (t.ages.length >= 5) sp = Math.max(2, Math.round((Math.max.apply(null, t.ages) - Math.min.apply(null, t.ages)) / 3)); }
    else if (t.idn && t.sure) { var s = sess[t.idn.id]; if (s && s.ages.length) a = median(s.ages); else if (t.idn.ages && t.idn.ages.length) a = median(t.idn.ages); }
    if (a == null && t.ages.length) a = median(t.ages);
    return a == null ? null : '~' + Math.round(a) + (sp ? '±' + sp : '') + ' yrs';
  }
  function genderOf(t) { if (!t.genders.length) return null; var m = 0; t.genders.forEach(function (g) { if (g === 'male') m++; }); return m * 2 >= t.genders.length ? 'M' : 'F'; }
  function labelOf(t) {
    var l1;
    if (t.idn) l1 = t.idn.name + (t.sure ? '' : '?') + (S.showConf ? '  ' + Math.round(t.sim * 100) + '%' : '');
    else l1 = t.obs.length ? 'Unknown' : '…';
    var bits = [], a = S.showAge ? ageText(t) : null, g = S.showGender ? genderOf(t) : null;
    if (a) bits.push(a); if (g) bits.push(g); if (S.showEmotion && t.emotion) bits.push(t.emotion);
    var live = liveScore(t); if (!t.static && live != null && live < LIVE_MIN) bits.push('photo?');
    return [l1, bits.join(' · ')];
  }
  function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  function hit(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
  function render() {
    var W = canvas.width, H = canvas.height; if (!W || !H) return;
    var mirror = mode === 'camera' && facing === 'user', src = mode === 'photo' ? photoCanvas : video;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'photo' && photoCanvas) ctx.drawImage(photoCanvas, 0, 0, W, H);
    var rect = canvas.getBoundingClientRect(), k = rect.width ? 1 / Math.min(rect.width / W, rect.height / H) : 1;   // canvas px per CSS px
    var list = tracks.filter(isVisible).sort(function (a, b) { return a.box.y - b.box.y; }), placed = [];
    fxMsg = '';
    if (fxOn() && (mode === 'photo' ? photoCanvas : video.readyState >= 2)) {
      var pic = photoCanvas;
      if (mode === 'camera') {                                              // the effects draw onto the picture itself
        if (frameCan.width !== W || frameCan.height !== H) { frameCan.width = W; frameCan.height = H; }
        frameCtx.save(); if (mirror) { frameCtx.translate(W, 0); frameCtx.scale(-1, 1); } frameCtx.drawImage(video, 0, 0, W, H); frameCtx.restore();
        ctx.drawImage(frameCan, 0, 0); pic = frameCan;
      }
      var faces = list.filter(function (t) { return t.mesh && t.mesh.length >= 468; }).map(function (t) {
        return { id: t.id, emotion: t.emotion, mesh: mirror ? t.mesh.map(function (p) { return [W - p[0], p[1]]; }) : t.mesh };
      });
      if (fx2On()) { faces = list.filter(function (t) { return t.mesh && t.mesh.length >= 468; }).map(function (t) { return { id: t.id, mesh: mirror ? t.mesh.map(function (p) { return [W - p[0], p[1], p[2]]; }) : t.mesh }; }); }
      try { fxMsg = (fx2On() ? window.FaceFX2.render(ctx, pic, W, H, faces, S.effect, performance.now()) : window.FaceFX.draw(ctx, pic, W, H, faces, S.effect, performance.now())) || ''; }
      catch (e) { console.warn(e); fxMsg = ''; }
      if (!S.showLabels) return;
    } else if (!S.showLabels) return;
    list.forEach(function (t) { t.dx = mirror ? W - t.box.x - t.box.w : t.box.x; placed.push({ x: t.dx, y: t.box.y, w: t.box.w, h: t.box.h }); });
    list.forEach(function (t) {
      var b = t.box, x = t.dx, col = colorOf(t);
      if (S.blurUnknown && src && !(t.idn && !t.idn.guest && t.sure)) {
        try { pixCtx.save(); if (mirror) { pixCtx.translate(10, 0); pixCtx.scale(-1, 1); }
          pixCtx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, 10, 10); pixCtx.restore();
          ctx.imageSmoothingEnabled = false; ctx.drawImage(pix, 0, 0, 10, 10, x, b.y, b.w, b.h); ctx.imageSmoothingEnabled = true; } catch (e) {}
      }
      if (S.showMesh && t.mesh && t.mesh.length > 100) {
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        for (var i = 0; i < t.mesh.length; i += 3) { var px = mirror ? W - t.mesh[i][0] : t.mesh[i][0]; ctx.fillRect(px - k * 0.6, t.mesh[i][1] - k * 0.6, k * 1.2, k * 1.2); }
      }
      ctx.lineWidth = Math.max(1.5, 2 * k); ctx.strokeStyle = col; ctx.lineCap = 'round';
      var c = Math.min(b.w, b.h) * 0.2;
      [[x, b.y, 1, 1], [x + b.w, b.y, -1, 1], [x, b.y + b.h, 1, -1], [x + b.w, b.y + b.h, -1, -1]].forEach(function (q) {
        ctx.beginPath(); ctx.moveTo(q[0] + q[2] * c, q[1]); ctx.lineTo(q[0], q[1]); ctx.lineTo(q[0], q[1] + q[3] * c); ctx.stroke();
      });
    });
    list.forEach(function (t, ti) {                                             // labels last, placed so they do not cover faces or each other
      var b = t.box, x = t.dx, col = colorOf(t), lb = labelOf(t);
      var fs = clamp((b.w / k) * 0.15, 11, 15) * k, fs2 = fs * 0.86, pad = fs * 0.45;
      ctx.font = '650 ' + fs + 'px system-ui, sans-serif'; var w1 = ctx.measureText(lb[0]).width;
      ctx.font = '500 ' + fs2 + 'px system-ui, sans-serif'; var w2 = lb[1] ? ctx.measureText(lb[1]).width : 0;
      var tw = Math.max(w1, w2) + pad * 2 + fs * 0.35, th = fs * 1.3 + (lb[1] ? fs2 * 1.3 : 0) + pad * 0.7;
      var lx = clamp(x + b.w / 2 - tw / 2, 2, Math.max(2, W - tw - 2)), gap = fs * 0.3;
      var tries = [b.y + b.h + gap, b.y - th - gap], r = null;
      for (var s = 1; s < 6; s++) tries.push(b.y + b.h + gap + s * (th + 2));
      for (var i = 0; i < tries.length && !r; i++) {
        var cand = { x: lx, y: clamp(tries[i], 2, Math.max(2, H - th - 2)), w: tw, h: th };
        if (!placed.some(function (p, pi) { return pi !== ti && hit(cand, p); })) r = cand;
      }
      if (!r) r = { x: lx, y: clamp(tries[0], 2, Math.max(2, H - th - 2)), w: tw, h: th };
      placed.push(r);
      ctx.fillStyle = 'rgba(8,11,16,.82)'; rr(r.x, r.y, r.w, r.h, fs * 0.4); ctx.fill();
      ctx.fillStyle = col; rr(r.x, r.y, fs * 0.28, r.h, fs * 0.14); ctx.fill();
      ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.font = '650 ' + fs + 'px system-ui, sans-serif';
      ctx.fillText(lb[0], r.x + pad + fs * 0.3, r.y + pad * 0.35 + fs * 0.65);
      if (lb[1]) { ctx.fillStyle = '#b9c3d3'; ctx.font = '500 ' + fs2 + 'px system-ui, sans-serif'; ctx.fillText(lb[1], r.x + pad + fs * 0.3, r.y + pad * 0.35 + fs * 1.3 + fs2 * 0.6); }
    });
  }

  /* ================= camera loop ================= */
  function hint() {
    var vis = tracks.filter(isVisible);
    if (!vis.length) return 'No face in view.';
    var big = vis.slice().sort(function (a, b) { return b.box.w * b.box.h - a.box.w * a.box.h; })[0], p = big.parts, tip = '';
    if (p && vis.length <= 2) { if (p.light < 0.3) tip = ' Too dark for a good reading.'; else if (p.size < 0.2) tip = ' Move closer for a better reading.'; else if (p.sharp < 0.1) tip = ' Hold steady.'; else if (p.pose < 0.25) tip = ' Face the camera.'; }
    var known = vis.filter(function (t) { return t.idn && !t.idn.guest && t.sure; }).length;
    return vis.length + (vis.length === 1 ? ' face' : ' faces') + (known ? ', ' + known + ' recognised' : '') + '. Tap a face to name it.' + tip;
  }
  async function loop(gen) {
    if (!running || gen !== loopGen) return;
    if (document.hidden) { setTimeout(function () { loop(gen); }, 400); return; }
    var idle = false;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; stage.style.aspectRatio = vw + ' / ' + vh; }
        var wantMesh = !!S.showMesh || !!fxOn(); if (humanA.config.face.mesh.enabled !== wantMesh) humanA.config.face.mesh.enabled = wantMesh;
        var t0 = performance.now(), res = await humanA.detect(video);
        if (!running || gen !== loopGen) return;
        var now = performance.now(), dtMs = lastFrame ? now - lastFrame : 0;
        if (lastFrame) { var inst = 1000 / (now - lastFrame); fps = fps ? fps * 0.8 + inst * 0.2 : inst; } lastFrame = now;
        updateTracks(toDets(res.face), now);
        if (enrol && (!enrol.track || tracks.indexOf(enrol.track) < 0 || !isVisible(enrol.track))) enrol.track = biggest();
        for (var n = 0; n < 3; n++) {
          var due = nextDue(now); if (!due) break;
          await analyse(due, video, vw, vh, now);
          if (!running || gen !== loopGen) return;
          if (performance.now() - t0 > 70) break;
        }
        if (fx2On() && window.FaceFX2.needsSeg(S.effect) && frameCan.width) await segment(frameCan);   // the mask from the last frame is close enough
        if (!running || gen !== loopGen) return;
        resolveIdentities(tracks, false); afterResolve(now, dtMs); render(); pill();
        if (tracks.length) lastFaceAt = now; idle = now - lastFaceAt > 6000;
        if (!enrol) status(fxMsg && fxOn() ? fxMsg : hint());
      } catch (e) { status('Detection error: ' + (e && e.message ? e.message : e), 'bad'); idle = true; }
    }
    if (idle) setTimeout(function () { loop(gen); }, 220); else requestAnimationFrame(function () { loop(gen); });
  }
  function stopCamera() {
    running = false; loopGen++;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    $('torchBtn').hidden = true; torchOn = false;
  }
  async function startCamera() {
    if (!ready) { status('Face models are still loading, one moment…', 'warn'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('No camera access here. Open this page from an https:// address.', 'bad'); return; }
    stopCamera(); cancelEnrol(); mode = 'camera'; photoCanvas = null; $('strip').classList.remove('on'); if (window.FaceFX2) window.FaceFX2.clearMask();
    var h = parseInt(S.res, 10) || 720;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h } } }); }
    catch (e) { status('Camera could not start: ' + (e && e.name === 'NotAllowedError' ? 'permission was refused.' : (e && e.message) || e), 'bad'); return; }
    video.style.display = ''; video.srcObject = stream; video.classList.toggle('mirror', facing === 'user');
    try { await video.play(); } catch (e) {}
    $('placeholder').style.display = 'none'; $('startBtn').textContent = 'Restart'; $('flipBtn').disabled = false; $('enrolBtn').disabled = false; $('snapBtn').disabled = false;
    try { var vt = stream.getVideoTracks()[0], caps = vt.getCapabilities ? vt.getCapabilities() : {}; $('torchBtn').hidden = !caps.torch; $('torchBtn').textContent = 'Light'; } catch (e) {}
    tracks = []; lastT = 0; lastFrame = 0; fps = 0; lastFaceAt = performance.now(); running = true; renderPeople();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    loop(loopGen);
  }

  /* ================= photos ================= */
  async function decode(file) {
    var url = URL.createObjectURL(file), img = new Image();
    try { await new Promise(function (ok, bad) { img.onload = ok; img.onerror = bad; img.src = url; }); } catch (e) { URL.revokeObjectURL(url); return null; }
    var sc = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); return c;
  }
  async function analysePhoto(c, label) {
    humanA.config.face.detector.maxDetected = 40; humanA.config.face.mesh.enabled = true;          // the mesh lets effects work on photos too
    var res; try { res = await humanA.detect(c); } finally { humanA.config.face.detector.maxDetected = 12; }
    var dets = toDets(res.face), list = [], now = performance.now();
    for (var i = 0; i < dets.length; i++) {
      status(label + 'reading face ' + (i + 1) + ' of ' + dets.length + '…');
      var t = newTrack(dets[i], now); t.static = true; t.confirmed = true;
      await analyse(t, c, c.width, c.height, now);
      if (t.obs.length) list.push(t);
    }
    return list;
  }
  async function openPhotos(files) {
    if (!ready) { status('Face models are still loading, one moment…', 'warn'); return; }
    files = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name); });
    if (!files.length) return;
    stopCamera(); cancelEnrol(); mode = 'photo'; video.style.display = 'none'; $('placeholder').style.display = 'none';
    $('startBtn').textContent = 'Start camera'; $('enrolBtn').disabled = true; $('flipBtn').disabled = true;
    photos = []; photoIdx = -1; tracks = []; var bad = 0;
    for (var i = 0; i < files.length; i++) {
      var label = files.length > 1 ? 'Photo ' + (i + 1) + ' of ' + files.length + ': ' : '';
      status(label + 'finding faces…');
      var c = await decode(files[i]); if (!c) { bad++; continue; }
      var p = { file: files[i], tracks: null, thumb: null };
      try { p.tracks = await analysePhoto(c, label); } catch (e) { bad++; continue; }
      if (mode !== 'photo') return;                          // the camera was started meanwhile
      try { var th = document.createElement('canvas'); th.width = th.height = 136; var s = Math.min(c.width, c.height);
        th.getContext('2d').drawImage(c, (c.width - s) / 2, (c.height - s) / 2, s, s, 0, 0, 136, 136); p.thumb = th.toDataURL('image/jpeg', 0.7); } catch (e) {}
      resolveIdentities(p.tracks, true); photos.push(p);
      if (photos.length === 1) await showPhoto(0, c); else renderStrip();
    }
    if (!photos.length) { status('Those files could not be opened as images.', 'bad'); return; }
    $('snapBtn').disabled = false; photoStatus(bad);
  }
  function photoStatus(bad) {
    var total = 0, counts = {};
    photos.forEach(function (p) { total += p.tracks.length; p.tracks.forEach(function (t) { if (t.idn && t.sure && !t.idn.guest) counts[t.idn.name] = (counts[t.idn.name] || 0) + 1; }); });
    var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 4).map(function (n) { return n + (photos.length > 1 ? ' in ' + counts[n] : ''); });
    status((photos.length > 1 ? photos.length + ' photos, ' : '') + total + (total === 1 ? ' face' : ' faces') + (names.length ? ' · ' + names.join(', ') : '') +
      (total ? '. Tap a face to name it.' : '.') + (bad ? ' ' + bad + ' file(s) skipped.' : ''));
  }
  async function showPhoto(i, c) {
    var p = photos[i]; if (!p) return;
    c = c || await decode(p.file); if (!c || mode !== 'photo') return;
    photoIdx = i; photoCanvas = c; tracks = p.tracks; if (window.FaceFX2) window.FaceFX2.clearMask(); if (fx2On() && window.FaceFX2.needsSeg(S.effect)) segment(c).then(render); canvas.width = c.width; canvas.height = c.height; stage.style.aspectRatio = c.width + ' / ' + c.height;
    resolveIdentities(tracks, true); renderStrip(); render(); pill();
  }
  function renderStrip() {
    var st = $('strip'); st.textContent = ''; st.classList.toggle('on', mode === 'photo' && photos.length > 1);
    photos.forEach(function (p, i) {
      var b = el('button', i === photoIdx ? 'cur' : ''); b.type = 'button';
      if (p.thumb) { var im = el('img'); im.src = p.thumb; im.alt = ''; b.appendChild(im); }
      var known = p.tracks.filter(function (t) { return t.idn && t.sure && !t.idn.guest; }).length;
      b.appendChild(el('span', '', known + '/' + p.tracks.length));
      b.title = p.file.name; b.addEventListener('click', function () { showPhoto(i).then(function () { photoStatus(0); }); }); st.appendChild(b);
    });
  }

  /* ================= naming a face ================= */
  function pickTrack(ev) {
    var r = canvas.getBoundingClientRect(), cw = canvas.width, ch = canvas.height, sc = Math.min(r.width / cw, r.height / ch);
    var x = (ev.clientX - r.left - (r.width - cw * sc) / 2) / sc, y = (ev.clientY - r.top - (r.height - ch * sc) / 2) / sc;
    var mirror = mode === 'camera' && facing === 'user', best = null, bd = 1e9;
    tracks.filter(isVisible).forEach(function (t) {
      var bx = mirror ? cw - t.box.x - t.box.w : t.box.x, cx = bx + t.box.w / 2, cy = t.box.y + t.box.h / 2;
      var d = Math.hypot(x - cx, y - cy) / Math.max(t.box.w, t.box.h); if (d < 0.9 && d < bd) { bd = d; best = t; }
    });
    return best;
  }
  function faceCard(t) {
    var card = el('div'), top = el('div', 'facecard');
    if (t.thumb) { var im = el('img'); im.src = t.thumb; im.alt = ''; top.appendChild(im); }
    var lines = el('div', 'lines');
    lines.appendChild(el('b', '', t.idn ? t.idn.name + (t.sure ? '' : ' (not sure)') : 'Unknown face'));
    var bits = [], a = ageText(t), g = genderOf(t); if (a) bits.push('Age ' + a); if (g) bits.push(g === 'M' ? 'male' : 'female'); if (t.emotion) bits.push(t.emotion);
    if (bits.length) lines.appendChild(el('div', '', bits.join(' · ')));
    if (t.parts) {
      var q = t.parts.q, why = t.parts.light < 0.3 ? 'dark' : (t.parts.size < 0.25 ? 'small' : (t.parts.sharp < 0.12 ? 'blurry' : (t.parts.pose < 0.3 ? 'turned away' : '')));
      lines.appendChild(el('div', '', 'Reading quality: ' + (q > 0.62 ? 'good' : (q > 0.4 ? 'fair' : 'poor')) + (why && q <= 0.62 ? ' (' + why + ')' : '')));
      var m = el('div', 'meter'), bar = el('i'); bar.style.width = Math.round(q * 100) + '%'; m.appendChild(bar); lines.appendChild(m);
    }
    var live = liveScore(t); if (!t.static && live != null && live < LIVE_MIN) lines.appendChild(el('div', '', 'Looks like a photo or screen.'));
    top.appendChild(lines); card.appendChild(top);
    var cands = t.cands.filter(function (c) { return !c.idn.guest && c.s > 0.3; }).slice(0, 3);
    if (cands.length) {
      var row = el('div', 'cands');
      cands.forEach(function (c) { row.appendChild(mkBtn(c.idn.name + ' ' + Math.round(c.s * 100) + '%', function () { $('dlgInput').value = c.idn.name; $('dlgInput').focus(); })); });
      card.appendChild(row);
    }
    return card;
  }
  async function saveAs(name, embs, opts) {            // opts: { track, guest, thumb }
    opts = opts || {};
    if (!embs.length) { toast('Still reading this face. Try again in a second.'); return null; }
    if (opts.track && S.requireLive && !liveOk(opts.track)) { toast('This looks like a photo or screen, so it was not saved. You can turn that check off in Settings.'); return null; }
    var p = findPerson(name);
    if (!p) {
      var best = null;                                 // does this face already belong to somebody saved?
      people.forEach(function (o) { var s = 0; embs.forEach(function (e) { s = Math.max(s, scoreIdentity(e.v, o)); }); if (s >= S.threshold && (!best || s > best.s)) best = { p: o, s: s }; });
      if (best) {
        var r = await dlg({ title: 'This looks like ' + best.p.name + ' (' + Math.round(best.s * 100) + '%)', body: 'Add this face to ' + best.p.name + ', or save “' + name + '” as a different person?',
          buttons: [{ label: 'Cancel', value: null }, { label: 'Different person', value: 'new' }, { label: 'Add to ' + best.p.name, value: 'same', primary: true }] });
        if (!r) return null;
        if (r.value === 'same') p = best.p;
        else { embs.slice(0, 3).forEach(function (e) { best.p.negatives.push(new Float32Array(e.v)); }); while (best.p.negatives.length > MAX_NEG) best.p.negatives.shift(); await dbPut(best.p); }
      }
    }
    if (!p) p = newPerson(name);
    // naming a face as this person overrides any earlier "not this person" correction about a similar face
    p.negatives = p.negatives.filter(function (n) { return !embs.some(function (e) { return sim(n, e.v) >= S.threshold; }); });
    addSamples(p, embs, false);
    if (S.thumbs && !p.thumb && opts.thumb) p.thumb = opts.thumb;
    if (opts.guest) dropGuest(opts.guest, p.id);
    var kept = await dbPut(p); changed();
    toast(kept ? 'Saved ' + p.name + ' (' + p.samples.length + (p.samples.length === 1 ? ' sample)' : ' samples)') : 'Saved for now, but this browser would not store it permanently.');
    return p;
  }
  async function openFace(t) {
    var idn = t.idn, known = idn && !idn.guest;
    var buttons = [{ label: 'Cancel', value: null }];
    if (known) buttons.push({ label: 'Not ' + idn.name, value: 'not', danger: true });
    buttons.push({ label: known ? 'Add sample' : 'Save', value: 'save', primary: true });
    var r = await dlg({ title: known ? (t.sure ? idn.name : 'Is this ' + idn.name + '?') : 'Who is this?', extra: faceCard(t),
      input: { value: known ? idn.name : '', placeholder: 'Name' }, buttons: buttons });
    if (!r) return;
    if (r.value === 'not') {
      var e = t.obs.length ? t.obs[t.obs.length - 1].emb : null; if (!e) return;
      idn.negatives.push(new Float32Array(e)); while (idn.negatives.length > MAX_NEG) idn.negatives.shift();
      idn.samples = idn.samples.filter(function (s) { return !(s.auto && sim(s.v, e) > 0.85); });      // drop anything learned from this mistake
      await dbPut(idn); changed();
      toast('Got it. That face will no longer be tagged as ' + idn.name + '.'); return;
    }
    if (!r.text) return;
    var guest = t.idn && t.idn.guest ? t.idn : null;
    var embs = guest ? guest.samples.map(function (s) { return { v: s.v, q: s.q }; }).slice(0, 6) : goodEmbs(t, t.static ? 0 : 0.3, 5);
    if (!embs.length && t.obs.length) embs = [{ v: t.obs[t.obs.length - 1].emb, q: t.obs[t.obs.length - 1].q }];
    await saveAs(r.text, embs, { track: t, guest: guest, thumb: (guest && guest.thumb) || t.thumb });
    if (mode === 'photo') photoStatus(0);
  }
  canvas.addEventListener('click', function (ev) { if (enrol) return; var t = pickTrack(ev); if (t) openFace(t); });

  /* ================= guided capture ================= */
  var STEPS = [
    { say: 'Look straight at the camera', ok: function (a) { return Math.abs(a.yaw) < 0.18 && Math.abs(a.pitch) < 0.25; } },
    { say: 'Turn your head slightly to one side', ok: function (a, e) { if (Math.abs(a.yaw) > 0.22) { e.sign = Math.sign(a.yaw); return true; } return false; } },
    { say: 'Now slightly to the other side', ok: function (a, e) { return a.yaw * (e.sign || 1) < -0.22; } },
    { say: 'Tilt your chin a little up or down', ok: function (a) { return Math.abs(a.pitch) > 0.2 && Math.abs(a.yaw) < 0.45; } }
  ];
  function biggest() { return tracks.filter(isVisible).sort(function (a, b) { return b.box.w * b.box.h - a.box.w * a.box.h; })[0] || null; }
  async function startEnrol(preset) {
    if (!running) { toast('Start the camera first.'); return; }
    var n = preset || await ask('Who are you adding?', { placeholder: 'Name', ok: 'Start', body: 'One person in front of the camera works best. Only add people who have agreed to it.' });
    if (!n) return;
    enrol = { name: n, step: 0, got: 0, stable: 0, until: 0, sign: 0, track: biggest(), busy: false }; drawCoach();
  }
  function cancelEnrol() { if (!enrol) return; var e = enrol; enrol = null; $('coach').classList.remove('on'); if (e.got) toast('Saved ' + e.got + ' samples for ' + e.name); }
  function drawCoach() {
    var c = $('coach'); if (!enrol) { c.classList.remove('on'); return; } c.classList.add('on');
    $('coachText').textContent = enrol.name + ': ' + STEPS[enrol.step].say;
    var dots = $('coachDots'); dots.textContent = '';
    STEPS.forEach(function (s, i) { dots.appendChild(el('i', i < enrol.step ? 'done' : (i === enrol.step ? 'now' : ''))); });
  }
  async function takeEnrol(t) {
    if (!enrol || enrol.busy || !t || !t.obs.length) return; enrol.busy = true;
    var o = t.obs[t.obs.length - 1], e = enrol;
    if (S.requireLive && !liveOk(t)) { toast('This looks like a photo or screen. Turn the check off in Settings to override.'); e.busy = false; return; }
    var p = findPerson(e.name) || newPerson(e.name);
    addSamples(p, [{ v: o.emb, q: o.q }], false); if (S.thumbs && !p.thumb) p.thumb = t.thumb;
    if (t.idn && t.idn.guest) dropGuest(t.idn, p.id);
    await dbPut(p); changed();
    e.got++; e.step++; e.stable = 0; e.until = performance.now() + 600; e.busy = false;
    if (enrol !== e) return;
    if (e.step >= STEPS.length) { enrol = null; $('coach').classList.remove('on'); toast('Saved ' + e.got + ' samples for ' + e.name); }
    else { status('Captured ' + e.got + ' of ' + STEPS.length + '.'); drawCoach(); }
  }
  function stepEnrol(t) {
    if (!enrol || enrol.busy || performance.now() < enrol.until || !t.rot || !t.parts) return;
    var good = t.parts.q > 0.4 && t.parts.size > 0.3 && STEPS[enrol.step].ok(t.rot, enrol);
    enrol.stable = good ? enrol.stable + 1 : 0;
    if (enrol.stable >= 2) takeEnrol(t);
  }
  $('coachNow').addEventListener('click', function () { if (!enrol) return; var t = enrol.track && isVisible(enrol.track) ? enrol.track : biggest(); if (t && t.obs.length) takeEnrol(t); else toast('No clear face in view yet.'); });
  $('coachCancel').addEventListener('click', cancelEnrol);

  /* ================= lists ================= */
  function avatar(idn) {
    if (idn.thumb) { var im = el('img'); im.src = idn.thumb; im.alt = ''; return im; }
    return el('div', 'ph', idn.name.charAt(0).toUpperCase());
  }
  function renderPeople() {
    var ul = $('people'); ul.textContent = '';
    people.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
      var li = el('li', 'p'), info = el('div', 'info');
      var man = p.samples.filter(function (s) { return !s.auto; }).length, aut = p.samples.length - man, age = median(p.ages);
      info.appendChild(el('div', 'nm', p.name));
      info.appendChild(el('div', 'meta', man + (man === 1 ? ' sample' : ' samples') + (aut ? ' + ' + aut + ' learned' : '') + (age != null ? ' · est. age ~' + Math.round(age) : '')));
      var acts = el('div', 'acts');
      acts.appendChild(mkBtn('Add samples', function () { startEnrol(p.name); }, 'small', !running));
      acts.appendChild(mkBtn('More', function () { personMenu(p); }));
      li.appendChild(avatar(p)); li.appendChild(info); li.appendChild(acts); ul.appendChild(li);
    });
    $('empty').style.display = people.length ? 'none' : '';
    var dl = $('names'); dl.textContent = ''; people.forEach(function (p) { var o = document.createElement('option'); o.value = p.name; dl.appendChild(o); });
  }
  async function personMenu(p) {
    var aut = p.samples.filter(function (s) { return s.auto; }).length;
    var buttons = [{ label: 'Rename', value: 'rename' }, { label: 'Merge into another person', value: 'merge' }];
    if (aut) buttons.push({ label: 'Remove ' + aut + ' learned samples', value: 'unlearn' });
    if (p.negatives.length) buttons.push({ label: 'Clear “not this person” corrections', value: 'unneg' });
    buttons.push({ label: 'Forget ' + p.name, value: 'forget', danger: true }, { label: 'Close', value: null });
    var r = await dlg({ title: p.name, stack: true, buttons: buttons }); if (!r) return;
    if (r.value === 'rename') {
      var n = await ask('New name for ' + p.name, { value: p.name, ok: 'Rename' }); if (!n) return;
      var o = findPerson(n); if (o && o !== p) { toast('Someone is already called ' + n + '. Use Merge instead.'); return; }
      p.name = n; await dbPut(p); changed();
    } else if (r.value === 'merge') {
      var m = await ask('Merge ' + p.name + ' into…', { placeholder: 'Existing name', ok: 'Merge' }); if (!m) return;
      var q = findPerson(m); if (!q || q === p) { toast('No other saved person is called ' + m + '.'); return; }
      addSamples(q, p.samples.filter(function (s) { return !s.auto; }).map(function (s) { return { v: s.v, q: s.q }; }), false);
      addSamples(q, p.samples.filter(function (s) { return s.auto; }).map(function (s) { return { v: s.v, q: s.q }; }), true);
      q.ages = q.ages.concat(p.ages).slice(-40); if (!q.thumb) q.thumb = p.thumb;
      people = people.filter(function (x) { return x !== p; }); mergeSession(p.id, q.id);
      await dbDel(p.id); await dbPut(q); changed(); toast('Merged into ' + q.name + '.');
    } else if (r.value === 'unlearn') { p.samples = p.samples.filter(function (s) { return !s.auto; }); await dbPut(p); changed(); }
    else if (r.value === 'unneg') { p.negatives = []; await dbPut(p); changed(); }
    else if (r.value === 'forget') { people = people.filter(function (x) { return x !== p; }); delete sess[p.id]; await dbDel(p.id); changed(); toast(p.name + ' was forgotten.'); }
  }
  function fmtDur(ms) { var s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  var sessKey = '';
  function sessMeta(r) { var age = median(r.s.ages); return 'in view ' + fmtDur(r.s.ms) + ' · last ' + new Date(r.s.last).toLocaleTimeString() + (age != null ? ' · ~' + Math.round(age) + ' yrs' : ''); }
  function renderSession() {
    var ul = $('session');
    var rows = Object.keys(sess).map(function (id) { return { idn: idMap[id], s: sess[id] }; }).filter(function (r) { return r.idn; })
      .sort(function (a, b) { return a.s.first - b.s.first; });
    var key = rows.map(function (r) { return r.idn.id + ':' + r.idn.name + ':' + (r.idn.thumb ? r.idn.thumb.length : 0); }).join('|');
    if (key === sessKey && ul.children.length === rows.length) {          // same rows: update the text only, so buttons stay tappable
      rows.forEach(function (r, i) { var li = ul.children[i];
        li.querySelector('.dot').className = 'dot' + (Date.now() - r.s.last < 2500 && running ? ' here' : ''); li.querySelector('.meta').textContent = sessMeta(r); });
      return;
    }
    sessKey = key; ul.textContent = '';
    rows.forEach(function (r) {
      var li = el('li', 'p'), info = el('div', 'info'), nm = el('div', 'nm');
      nm.appendChild(el('span', 'dot' + (Date.now() - r.s.last < 2500 && running ? ' here' : '')));
      nm.appendChild(el('span', '', r.idn.name)); if (r.idn.guest) nm.appendChild(el('span', 'tag', 'guest'));
      info.appendChild(nm); info.appendChild(el('div', 'meta', sessMeta(r)));
      var acts = el('div', 'acts');
      if (r.idn.guest) acts.appendChild(mkBtn('Name', async function () {
        var g = r.idn, n = await ask('Who is ' + g.name + '?', { placeholder: 'Name', ok: 'Save' });
        if (n && guests.indexOf(g) >= 0) saveAs(n, g.samples.map(function (s) { return { v: s.v, q: s.q }; }).slice(0, 6), { guest: g, thumb: g.thumb });
      }));
      li.appendChild(avatar(r.idn)); li.appendChild(info); li.appendChild(acts); ul.appendChild(li);
    });
    $('sessEmpty').style.display = rows.length ? 'none' : '';
  }
  function exportCsv() {
    var rows = [['name', 'type', 'first_seen', 'last_seen', 'seconds_in_view', 'estimated_age']];
    Object.keys(sess).forEach(function (id) { var i = idMap[id], s = sess[id]; if (!i) return; var a = median(s.ages);
      rows.push([i.name, i.guest ? 'guest' : 'saved', new Date(s.first).toISOString(), new Date(s.last).toISOString(), Math.round(s.ms / 1000), a != null ? Math.round(a) : '']); });
    if (rows.length === 1) { toast('Nothing to export yet.'); return; }
    var csv = rows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    download(new Blob([csv], { type: 'text/csv' }), 'facetag-session.csv');
  }

  /* ================= snapshot ================= */
  function snapshot() {
    if (!canvas.width) return;
    var c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; var g = c.getContext('2d');
    if (mode === 'camera') { g.save(); if (facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); } g.drawImage(video, 0, 0, c.width, c.height); g.restore(); }
    g.drawImage(canvas, 0, 0);
    c.toBlob(function (b) { if (!b) { toast('Could not make the snapshot.'); return; } download(b, 'facetag-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png'); }, 'image/png');
  }

  /* ================= backup ================= */
  function b64(buf) { var s = '', u = new Uint8Array(buf); for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }
  function unb64(s) { var r = atob(s), u = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; }
  function nums(v) { return Array.from(v, function (x) { return Math.round(x * 1e5) / 1e5; }); }
  async function keyFrom(pass, salt) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function exportBackup() {
    if (!people.length) { toast('Nobody to export yet.'); return; }
    var pass = await ask('Passphrase to lock the backup', { type: 'password', optional: true, ok: 'Export', body: 'Leave empty for an unencrypted file. A face signature can identify a person, so a passphrase is wise.' });
    if (pass === null) return;
    var body = JSON.stringify({ app: 'face-tag', v: 3, people: people.map(function (p) {
      return { name: p.name, created: p.created, thumb: p.thumb, ages: p.ages, samples: p.samples.map(function (s) { return { v: nums(s.v), a: s.auto ? 1 : 0, q: Math.round(s.q * 100) / 100 }; }), negatives: p.negatives.map(nums) }; }) });
    var out = body;
    if (pass) {
      var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await keyFrom(pass, salt);
      var enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(body));
      out = JSON.stringify({ app: 'face-tag', v: 3, enc: true, salt: b64(salt), iv: b64(iv), data: b64(enc) });
    }
    download(new Blob([out], { type: 'application/json' }), 'facetag-backup.json'); toast('Backup exported.');
  }
  async function importBackup(file) {
    try {
      var j = JSON.parse(await file.text());
      if (j.enc) {
        var pass = await ask('Passphrase for this backup', { type: 'password', ok: 'Unlock' }); if (!pass) return;
        var key = await keyFrom(pass, unb64(j.salt));
        j = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data))));
      }
      if (j.app !== 'face-tag' || !Array.isArray(j.people)) throw new Error('not a Face Tag backup');
      var added = 0;
      for (var i = 0; i < j.people.length; i++) {
        var r = j.people[i]; if (!r.name || !Array.isArray(r.samples)) continue;
        var p = findPerson(String(r.name));
        if (!p) { p = newPerson(String(r.name)); p.thumb = r.thumb || null; p.created = r.created || Date.now(); }
        r.samples.forEach(function (s) { var v = Array.isArray(s) ? s : s.v; if (v && v.length) addSamples(p, [{ v: v, q: s.q || 0.6 }], !Array.isArray(s) && !!s.a); });
        (r.negatives || []).forEach(function (n) { p.negatives.push(new Float32Array(n)); }); p.negatives = p.negatives.slice(-MAX_NEG);
        p.ages = p.ages.concat(r.ages || []).slice(-40); added++; await dbPut(p);
      }
      changed(); toast('Imported ' + added + (added === 1 ? ' person.' : ' people.'));
    } catch (e) { toast('Import failed: ' + (e && e.name === 'OperationError' ? 'wrong passphrase.' : (e && e.message) || e)); }
  }

  /* ================= wiring ================= */
  $('startBtn').addEventListener('click', startCamera);
  $('flipBtn').addEventListener('click', function () { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
  $('enrolBtn').addEventListener('click', function () { startEnrol(); });
  $('snapBtn').addEventListener('click', snapshot);
  $('torchBtn').addEventListener('click', async function () {
    try { torchOn = !torchOn; await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); $('torchBtn').textContent = torchOn ? 'Light on' : 'Light'; }
    catch (e) { torchOn = false; toast('The light could not be switched.'); }
  });
  $('photoIn').addEventListener('change', function (e) { var f = Array.prototype.slice.call(e.target.files || []); e.target.value = ''; if (f.length) openPhotos(f); });
  $('expBtn').addEventListener('click', exportBackup);
  $('impIn').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });
  $('csvBtn').addEventListener('click', exportCsv);
  function clearGuests() { guests.forEach(function (g) { delete sess[g.id]; }); guests = []; changed(); }
  $('guestClr').addEventListener('click', clearGuests);
  $('clearBtn').addEventListener('click', async function () {
    var r = await dlg({ title: 'Forget everyone?', body: 'This deletes all ' + people.length + ' saved people from this browser. It cannot be undone.', buttons: [{ label: 'Cancel', value: null }, { label: 'Forget everyone', value: 'yes', danger: true }] });
    if (!r) return; for (var i = 0; i < people.length; i++) await dbDel(people[i].id);
    people = []; guests = []; sess = {}; changed(); toast('All saved people were forgotten.');
  });
  document.querySelectorAll('[data-set]').forEach(function (e) {
    e.checked = !!S[e.dataset.set];
    e.addEventListener('change', function () { S[e.dataset.set] = e.checked; saveSettings(); if (e.dataset.set === 'guests' && !e.checked) clearGuests(); if (mode === 'photo') render(); });
  });
  $('thr').value = S.threshold; $('thr').addEventListener('input', function () { S.threshold = parseFloat($('thr').value); saveSettings(); if (ready) changed(); });
  $('res').value = S.res; $('res').addEventListener('change', function () { S.res = $('res').value; saveSettings(); if (running) startCamera(); });
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      ['people', 'session', 'settings'].forEach(function (n) { $('tab-' + n).classList.toggle('on', n === b.dataset.tab); });
      if (b.dataset.tab === 'session') renderSession();
    });
  });
  (function buildFx() {
    var row = $('fxRow'); if (!row || !window.FaceFX) return;
    var all = (window.FaceFX2 ? window.FaceFX2.list : [['none', '⭕', 'None']]).concat([['_', '', 'Classic']]).concat(window.FaceFX.list.filter(function (e) { return e[0] !== 'none'; }));
    all.forEach(function (e) {
      if (e[0] === '_') { row.appendChild(el('span', 'fxsep', e[2])); return; }
      var b = el('button', 'fx' + (S.effect === e[0] ? ' on' : '')); b.type = 'button'; b.dataset.fx = e[0];
      b.appendChild(el('span', 'ic', e[1])); b.appendChild(el('span', '', e[2]));
      b.addEventListener('click', function () {
        S.effect = e[0]; saveSettings();
        row.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.fx === S.effect); });
        if (window.FaceFX2 && window.FaceFX2.needsSeg(S.effect) && mode === 'photo' && photoCanvas) segment(photoCanvas).then(render);
        if (mode === 'photo') render();
      });
      row.appendChild(b);
    });
  })();
  window.addEventListener('resize', function () { if (mode === 'photo') render(); });
  document.addEventListener('visibilitychange', async function () {
    if (!document.hidden && running && !wakeLock) { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  });
  setInterval(function () { if (running && $('tab-session').classList.contains('on') && !$('dlg').classList.contains('open')) renderSession(); }, 2000);

  /* ================= boot ================= */
  (async function boot() {
    renderPeople(); renderSession();
    if (typeof window.Human === 'undefined') { status('The face engine did not load. Check the connection and reload.', 'bad'); return; }
    db = await idb(); var rows = await dbReq('readonly', function (s) { return s.getAll(); });
    people = (Array.isArray(rows) ? rows : []).map(normalise);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(function () {});
    try { await initEngine(); changed(); status('Ready. Start the camera or open photos.'); }
    catch (e) { status('Face models could not load: ' + (e && e.message ? e.message : e), 'bad'); }
    window.FaceTag = { get tracks() { return tracks; }, get people() { return people; }, get guests() { return guests; }, get sess() { return sess; },
      visible: function () { return tracks.filter(isVisible); }, setEffect: function (e) { var b = document.querySelector('[data-fx="' + e + '"]'); if (b) b.click(); }, saveAs: saveAs, goodEmbs: goodEmbs, openFace: openFace, labelOf: labelOf, S: S };
  })();
})();
