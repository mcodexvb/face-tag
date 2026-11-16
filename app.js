/* Face Tag — in-browser age estimate, face recognition and name tags.
   Engine: Human by Vladimir Mandic (MIT), https://github.com/vladmandic/human */
(function () {
  'use strict';

  /* ---------- constants and state ---------- */
  var CDN_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/human-models@3.0.4/models/';
  var MODELS = location.protocol === 'file:' ? CDN_MODELS : './models/';
  var MATCH_OPTS = { order: 2, multiplier: 25, min: 0.2, max: 0.8 };   // tuned for the faceres model
  var MAX_SAMPLES = 12;
  var LIVE_MIN = 0.5;                                                    // antispoof score below this = probably a photo or screen
  var $ = function (id) { return document.getElementById(id); };

  var DEFAULTS = { threshold: 0.5, res: '720', showAge: true, showGender: true, showEmotion: false,
                   showMesh: false, announce: false, requireLive: true, thumbs: true };
  var S = Object.assign({}, DEFAULTS);
  try { Object.assign(S, JSON.parse(localStorage.getItem('facetag-settings-v2') || '{}')); } catch (e) {}
  function saveSettings() { try { localStorage.setItem('facetag-settings-v2', JSON.stringify(S)); } catch (e) {} }

  var video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d'), stage = $('stage');
  var human = null, ready = false, running = false, busy = false, facing = 'user', stream = null, wakeLock = null;
  var mode = 'camera';                 // 'camera' or 'photo'
  var photo = null;                    // { img, w, h, faces }
  var people = [];                     // { id, name, samples:[Float32Array], thumb, created }
  var faces = [];                      // latest faces in display coordinates
  var tracks = [], trackId = 0;
  var seen = {};                       // name -> { first, last, ages:[] }
  var spoken = {};
  var enrol = null;                    // guided capture state
  var fps = 0, lastFrame = 0;

  function status(msg, cls) { var s = $('status'); s.textContent = msg; s.className = cls || ''; }
  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3200);
  }
  function pill() {
    var b = human && human.tf && human.tf.getBackend ? human.tf.getBackend() : '…';
    $('pill').textContent = ready ? b + (running && fps ? ' · ' + (fps < 10 ? fps.toFixed(1) : fps.toFixed(0)) + ' fps' : '') : 'loading…';
  }

  /* ---------- storage (IndexedDB, with in-memory fallback) ---------- */
  var db = null;
  function idb() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('facetag', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('people', { keyPath: 'id' }); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function dbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      try { var r = db.transaction('people').objectStore('people').getAll(); r.onsuccess = function () { res(r.result || []); }; r.onerror = function () { res([]); }; }
      catch (e) { res([]); }
    });
  }
  function dbPut(p) {
    return new Promise(function (res) {
      if (!db) return res(false);
      try { var t = db.transaction('people', 'readwrite'); t.objectStore('people').put(p); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; }
      catch (e) { res(false); }
    });
  }
  function dbDel(id) {
    return new Promise(function (res) {
      if (!db) return res(false);
      try { var t = db.transaction('people', 'readwrite'); t.objectStore('people').delete(id); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; }
      catch (e) { res(false); }
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------- people list UI ---------- */
  function renderPeople() {
    tracks.forEach(function (t) { t.hist = []; });             // re-evaluate names after any change
    var ul = $('people'); ul.textContent = '';
    people.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (p) {
      var li = document.createElement('li'); li.className = 'p';
      var pic;
      if (p.thumb) { pic = document.createElement('img'); pic.src = p.thumb; pic.alt = ''; }
      else { pic = document.createElement('div'); pic.className = 'ph'; pic.textContent = p.name.charAt(0).toUpperCase(); }
      var info = document.createElement('div'); info.className = 'info';
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = p.name;
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = p.samples.length + (p.samples.length === 1 ? ' sample' : ' samples');
      info.appendChild(nm); info.appendChild(meta);
      var acts = document.createElement('div'); acts.className = 'acts';
      acts.appendChild(mkBtn('Add samples', function () { startEnrol(p.name); }, !running));
      acts.appendChild(mkBtn('Rename', function () { renamePerson(p); }));
      acts.appendChild(mkBtn('Forget', function () { forgetPerson(p); }));
      li.appendChild(pic); li.appendChild(info); li.appendChild(acts); ul.appendChild(li);
    });
    $('empty').hidden = people.length > 0;
    var dl = $('names'); dl.textContent = '';
    people.forEach(function (p) { var o = document.createElement('option'); o.value = p.name; dl.appendChild(o); });
  }
  function mkBtn(label, fn, disabled) {
    var b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.disabled = !!disabled;
    b.addEventListener('click', fn); return b;
  }
  function renderSeen() {
    var names = Object.keys(seen);
    $('seenBox').hidden = names.length === 0;
    var ul = $('seen'); ul.textContent = '';
    names.sort(function (a, b) { return seen[b].last - seen[a].last; }).forEach(function (n) {
      var s = seen[n], li = document.createElement('li'); li.className = 's';
      var a = document.createElement('span'); a.textContent = n;
      var ages = s.ages.slice().sort(function (x, y) { return x - y; });
      var med = ages.length ? Math.round(ages[Math.floor(ages.length / 2)]) : null;
      var b = document.createElement('span');
      b.textContent = 'last ' + new Date(s.last).toLocaleTimeString() + (med ? ' · ~' + med + ' yrs' : '');
      li.appendChild(a); li.appendChild(b); ul.appendChild(li);
    });
  }
  async function renamePerson(p) {
    var n = await ask({ title: 'New name for ' + p.name, value: p.name, ok: 'Rename' });
    if (!n) return;
    var other = findPerson(n);
    if (other && other !== p) { toast('Someone is already called ' + n); return; }
    p.name = n; await dbPut(p); renderPeople();
  }
  async function forgetPerson(p) {
    people = people.filter(function (x) { return x !== p; });
    await dbDel(p.id); renderPeople();
  }
  function findPerson(name) {
    var k = name.trim().toLowerCase();
    return people.filter(function (p) { return p.name.toLowerCase() === k; })[0] || null;
  }

  /* ---------- generic text prompt (sheet) ---------- */
  var askResolve = null;
  function ask(o) {
    return new Promise(function (resolve) {
      askResolve = resolve;
      $('askLabel').textContent = o.title;
      var inp = $('askInput'); inp.type = o.type || 'text'; inp.value = o.value || '';
      inp.placeholder = o.placeholder || ''; inp.autocomplete = o.type === 'password' ? 'new-password' : 'off'; inp.required = !o.optional;
      if (o.type === 'password') inp.removeAttribute('list'); else inp.setAttribute('list', 'names');
      $('askHint').textContent = o.hint || ''; $('askOk').textContent = o.ok || 'OK';
      $('sheet').classList.add('open'); setTimeout(function () { inp.focus(); }, 30);
    });
  }
  function askDone(v) { $('sheet').classList.remove('open'); var r = askResolve; askResolve = null; if (r) r(v); }
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); askDone($('askInput').value.trim()); });
  $('askCancel').addEventListener('click', function () { askDone(null); });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) askDone(null); });

  /* ---------- Human engine ---------- */
  function humanConfig() {
    return {
      modelBasePath: MODELS, backend: 'webgl', cacheSensitivity: 0.01, debug: false,
      filter: { enabled: true, equalization: false },
      face: {
        enabled: true,
        detector: { modelPath: 'blazeface.json', maxDetected: 6, minConfidence: 0.35, rotation: false, return: false },
        mesh: { enabled: true, modelPath: 'facemesh.json' },
        iris: { enabled: false },
        description: { enabled: true, modelPath: 'faceres.json' },
        emotion: { enabled: true, modelPath: 'emotion.json' },
        antispoof: { enabled: true, modelPath: 'antispoof.json' },
        liveness: { enabled: false }
      },
      body: { enabled: false }, hand: { enabled: false }, object: { enabled: false },
      gesture: { enabled: false }, segmentation: { enabled: false }
    };
  }
  async function initHuman() {
    var H = window.Human && (window.Human.Human || window.Human);
    human = new H(humanConfig());
    var order = ['webgl', 'wasm', 'cpu'], ok = false;
    for (var i = 0; i < order.length && !ok; i++) {
      try { human.config.backend = order[i]; await human.init(); ok = human.tf.getBackend() === order[i]; } catch (e) { ok = false; }
    }
    await human.load();
    try { await human.warmup(); } catch (e) {}
    ready = true; pill();
  }

  /* ---------- matching and tracking ---------- */
  function bestMatch(emb) {
    var best = null;
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      for (var j = 0; j < p.samples.length; j++) {
        var sim = human.match.similarity(emb, p.samples[j], MATCH_OPTS);
        if (!best || sim > best.sim) best = { p: p, sim: sim };
      }
    }
    return best && best.sim >= S.threshold ? best : null;
  }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

  function assignTrack(cx, cy, w, now) {
    var hit = null, hd = w * 0.7;
    tracks.forEach(function (t) { var d = Math.hypot(t.cx - cx, t.cy - cy); if (d < hd) { hd = d; hit = t; } });
    if (!hit) { hit = { id: ++trackId, ages: [], hist: [], genders: [] }; tracks.push(hit); }
    hit.cx = cx; hit.cy = cy; hit.seen = now; return hit;
  }

  /* Turn Human results into display faces. `isStatic` skips temporal smoothing (single photo). */
  function buildFaces(raw, W, mirror, isStatic) {
    var now = performance.now();
    var out = raw.map(function (f) {
      var b = f.box, x = mirror ? W - b[0] - b[2] : b[0];
      var d = { raw: f, x: x, y: b[1], w: b[2], h: b[3], emb: f.embedding && f.embedding.length ? f.embedding : null };
      var cand = d.emb && people.length ? bestMatch(d.emb) : null;
      var age = typeof f.age === 'number' ? f.age : null;
      if (isStatic) {
        d.age = age; d.person = cand ? cand.p : null; d.sim = cand ? cand.sim : 0;
        d.gender = f.genderScore > 0.15 ? f.gender : null;
      } else {
        var t = assignTrack(x + b[2] / 2, b[1] + b[3] / 2, b[2], now);
        if (age != null) { t.ages.push(age); if (t.ages.length > 25) t.ages.shift(); }
        if (f.genderScore > 0.15) { t.genders.push(f.gender); if (t.genders.length > 25) t.genders.shift(); }
        t.hist.push(cand); if (t.hist.length > 8) t.hist.shift();
        var counts = {}, top = null;
        t.hist.forEach(function (c) { if (c) { var k = c.p.id; counts[k] = (counts[k] || 0) + 1; if (!top || counts[k] > counts[top]) top = k; } });
        var need = Math.min(2, t.hist.length);
        var person = top && counts[top] >= need ? people.filter(function (p) { return p.id === top; })[0] : null;
        d.person = person || null;
        d.sim = cand && person && cand.p === person ? cand.sim : 0;
        d.age = t.ages.length ? median(t.ages) : null;
        d.ageSpread = t.ages.length > 4 ? Math.max(2, Math.round((Math.max.apply(null, t.ages) - Math.min.apply(null, t.ages)) / 3)) : null;
        var g = { male: 0, female: 0 }; t.genders.forEach(function (v) { g[v] = (g[v] || 0) + 1; });
        d.gender = t.genders.length ? (g.male >= g.female ? 'male' : 'female') : null;
      }
      var em = f.emotion && f.emotion[0]; d.emotion = em && em.score > 0.4 ? em.emotion : null;
      d.real = typeof f.real === 'number' ? f.real : null;
      return d;
    });
    if (!isStatic) tracks = tracks.filter(function (t) { return now - t.seen < 1500; });
    return out;
  }

  function logSeen(list) {
    var changed = false, t = Date.now();
    list.forEach(function (d) {
      if (!d.person) return;
      var n = d.person.name, s = seen[n];
      if (!s) { s = seen[n] = { first: t, last: 0, ages: [] }; changed = true; greet(n); }
      if (t - s.last > 1000) { changed = true; if (d.age != null) { s.ages.push(d.age); if (s.ages.length > 60) s.ages.shift(); } }
      s.last = t;
    });
    if (changed) renderSeen();
  }
  function greet(name) {
    if (!S.announce || !('speechSynthesis' in window)) return;
    var t = Date.now(); if (spoken[name] && t - spoken[name] < 60000) return; spoken[name] = t;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('Hello ' + name)); } catch (e) {}
  }

  /* ---------- drawing ---------- */
  function render() {
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'photo' && photo) ctx.drawImage(photo.img, 0, 0, W, H);
    var fs = Math.max(13, Math.round(W / 38));
    ctx.font = '600 ' + fs + 'px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    faces.forEach(function (d) {
      var known = !!d.person, color = known ? '#3ddc97' : '#ffb454';
      ctx.lineWidth = Math.max(2, W / 300); ctx.strokeStyle = color;
      var c = Math.min(d.w, d.h) * 0.22;                        // corner brackets
      [[d.x, d.y, 1, 1], [d.x + d.w, d.y, -1, 1], [d.x, d.y + d.h, 1, -1], [d.x + d.w, d.y + d.h, -1, -1]].forEach(function (k) {
        ctx.beginPath(); ctx.moveTo(k[0] + k[2] * c, k[1]); ctx.lineTo(k[0], k[1]); ctx.lineTo(k[0], k[1] + k[3] * c); ctx.stroke();
      });
      if (S.showMesh && d.raw.mesh) {
        ctx.fillStyle = 'rgba(61,220,151,.55)';
        var m = d.raw.mesh, step = 3, mir = mode === 'camera' && facing === 'user';
        for (var i = 0; i < m.length; i += step) { var px = mir ? W - m[i][0] : m[i][0]; ctx.fillRect(px - 1, m[i][1] - 1, 2, 2); }
      }
      var l1 = known ? d.person.name : 'Unknown';
      var bits = [];
      if (S.showAge && d.age != null) bits.push('~' + Math.round(d.age) + (d.ageSpread ? '±' + d.ageSpread : '') + ' yrs');
      if (S.showGender && d.gender) bits.push(d.gender === 'male' ? 'M' : 'F');
      if (S.showEmotion && d.emotion) bits.push(d.emotion);
      var l2 = bits.join(' · ');
      if (d.real != null && d.real < LIVE_MIN && mode === 'camera') l2 += (l2 ? ' · ' : '') + 'not live?';
      var lines = l2 ? [l1, l2] : [l1];
      var tw = 0; lines.forEach(function (s) { tw = Math.max(tw, ctx.measureText(s).width); });
      tw += fs * 0.8; var lh = fs * 1.35, th = lh * lines.length + fs * 0.2;
      var lx = Math.min(Math.max(0, d.x), W - tw), ly = d.y - th >= 0 ? d.y - th : d.y + d.h;
      ctx.fillStyle = color; ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = '#06140d';
      lines.forEach(function (s, i) { ctx.fillText(s, lx + fs * 0.4, ly + fs * 0.1 + lh * (i + 0.5)); });
    });
  }

  /* ---------- camera loop ---------- */
  async function loop() {
    if (!running) return;
    if (document.hidden) { setTimeout(loop, 400); return; }
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      busy = true;
      try {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          stage.style.aspectRatio = video.videoWidth + ' / ' + video.videoHeight;
        }
        var res = await human.detect(video);
        var now = performance.now(); if (lastFrame) { var inst = 1000 / (now - lastFrame); fps = fps ? fps * 0.8 + inst * 0.2 : inst; } lastFrame = now;
        faces = buildFaces(res.face || [], canvas.width, facing === 'user', false);
        logSeen(faces); stepEnrol(faces); render(); pill();
        $('enrolBtn').disabled = false; $('snapBtn').disabled = false;
        if (!enrol) status(faces.length === 0 ? 'No face in view.' : faces.length + (faces.length === 1 ? ' face' : ' faces') + '. Tap one to name it.');
      } catch (e) { status('Detection error: ' + (e && e.message ? e.message : e), 'bad'); }
      busy = false;
    }
    requestAnimationFrame(loop);
  }
  function stopCamera() {
    running = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  async function startCamera() {
    if (!ready) { status('Face models are still loading, one moment…', 'warn'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status('No camera access here. Open this page from an https:// address.', 'bad'); return;
    }
    stopCamera(); cancelEnrol(); mode = 'camera'; photo = null;
    var h = parseInt(S.res, 10) || 720;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: facing, width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h } } });
    } catch (e) {
      status('Camera could not start: ' + (e && e.name === 'NotAllowedError' ? 'permission was refused.' : (e && e.message) || e), 'bad'); return;
    }
    video.style.display = ''; video.srcObject = stream; video.classList.toggle('mirror', facing === 'user');
    try { await video.play(); } catch (e) {}
    $('placeholder').style.display = 'none'; $('startBtn').textContent = 'Restart camera'; $('flipBtn').disabled = false;
    faces = []; tracks = []; lastFrame = 0; fps = 0; running = true; renderPeople();
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    loop();
  }

  /* ---------- photo mode ---------- */
  async function openPhoto(file) {
    if (!ready) { status('Face models are still loading, one moment…', 'warn'); return; }
    stopCamera(); cancelEnrol(); tracks = []; video.style.display = 'none'; $('placeholder').style.display = 'none';
    var url = URL.createObjectURL(file), img = new Image();
    try { await new Promise(function (ok, bad) { img.onload = ok; img.onerror = bad; img.src = url; }); }
    catch (e) { status('That file could not be opened as an image.', 'bad'); URL.revokeObjectURL(url); return; }
    var max = 1600, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    mode = 'photo'; photo = { img: c }; canvas.width = c.width; canvas.height = c.height;
    stage.style.aspectRatio = c.width + ' / ' + c.height;
    status('Analysing photo…');
    try {
      var res = await human.detect(c, { cacheSensitivity: 0 });
      faces = buildFaces(res.face || [], c.width, false, true);
      logSeen(faces); render(); pill();
      $('snapBtn').disabled = false; $('enrolBtn').disabled = true; $('startBtn').textContent = 'Start camera';
      status(faces.length ? faces.length + (faces.length === 1 ? ' face' : ' faces') + ' found. Tap one to name it.' : 'No faces found in that photo.');
    } catch (e) { status('Could not analyse the photo: ' + (e && e.message ? e.message : e), 'bad'); }
  }

  /* ---------- saving faces ---------- */
  function thumbOf(d) {
    try {
      var src = mode === 'photo' ? photo.img : video, b = d.raw.box, pad = Math.max(b[2], b[3]) * 0.25;
      var sx = Math.max(0, b[0] - pad), sy = Math.max(0, b[1] - pad), sw = b[2] + pad * 2, sh = b[3] + pad * 2;
      var s = Math.max(sw, sh), c = document.createElement('canvas'); c.width = c.height = 96;
      var g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 96, 96);
      g.drawImage(src, sx, sy, sw, sh, (96 - 96 * sw / s) / 2, (96 - 96 * sh / s) / 2, 96 * sw / s, 96 * sh / s);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }
  async function addSample(name, d) {
    if (!d || !d.emb) { toast('That face has no signature yet. Hold still a moment.'); return null; }
    if (mode === 'camera' && S.requireLive && d.real != null && d.real < LIVE_MIN) { toast('That does not look like a live face. Turn off “Only save live faces” in settings to override.'); return null; }
    var p = findPerson(name);
    if (!p) { p = { id: uid(), name: name.trim(), samples: [], thumb: null, created: Date.now() }; people.push(p); }
    p.samples.push(new Float32Array(d.emb)); if (p.samples.length > MAX_SAMPLES) p.samples.shift();
    if (S.thumbs && !p.thumb) p.thumb = thumbOf(d);
    var kept = await dbPut(p); renderPeople();
    if (!kept) toast('Saved for now, but this browser would not store it permanently.');
    return p;
  }
  function pickFace(ev) {
    var r = canvas.getBoundingClientRect();
    var cw = canvas.width, ch = canvas.height, scale = Math.min(r.width / cw, r.height / ch);
    var ox = (r.width - cw * scale) / 2, oy = (r.height - ch * scale) / 2;
    var x = (ev.clientX - r.left - ox) / scale, y = (ev.clientY - r.top - oy) / scale;
    var hit = faces.filter(function (f) { return x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h; });
    return hit.sort(function (a, b) { return a.w * a.h - b.w * b.h; })[0] || null;
  }
  canvas.addEventListener('click', async function (ev) {
    if (enrol) return;
    var d = pickFace(ev); if (!d) return;
    var n = await ask({ title: d.person ? 'Add another sample of ' + d.person.name + '?' : 'Who is this?', value: d.person ? d.person.name : '',
      placeholder: 'Name', ok: 'Save face', hint: d.emb ? '' : 'No face signature yet, try again in a second.' });
    if (!n) return;
    var p = await addSample(n, d); if (p) toast('Saved ' + p.name + ' (' + p.samples.length + ' samples)');
  });

  /* ---------- guided capture ---------- */
  var STEPS = [
    { say: 'Look straight at the camera', ok: function (a) { return Math.abs(a.yaw) < 0.18 && Math.abs(a.pitch) < 0.25; } },
    { say: 'Turn your head slightly to one side', ok: function (a, e) { if (Math.abs(a.yaw) > 0.22) { e.sign = Math.sign(a.yaw); return true; } return false; } },
    { say: 'Now slightly to the other side', ok: function (a, e) { return a.yaw * (e.sign || 1) < -0.22; } },
    { say: 'Tilt your chin a little up or down', ok: function (a) { return Math.abs(a.pitch) > 0.2 && Math.abs(a.yaw) < 0.45; } }
  ];
  async function startEnrol(presetName) {
    if (!running) { toast('Start the camera first.'); return; }
    var n = presetName || await ask({ title: 'Who are you adding?', placeholder: 'Name', ok: 'Start', hint: 'Only add people who have agreed to it.' });
    if (!n) return;
    enrol = { name: n, step: 0, got: 0, stable: 0, until: 0, sign: 0, busy: false }; drawCoach();
  }
  function cancelEnrol() { if (enrol) { var n = enrol; enrol = null; $('coach').classList.remove('on'); if (n.got) toast('Saved ' + n.got + ' samples for ' + n.name); } }
  function drawCoach() {
    var c = $('coach'); if (!enrol) { c.classList.remove('on'); return; }
    c.classList.add('on');
    $('coachText').textContent = enrol.name + ': ' + (STEPS[enrol.step] ? STEPS[enrol.step].say : 'All done');
    var dots = $('coachDots'); dots.textContent = '';
    STEPS.forEach(function (s, i) { var e = document.createElement('i'); e.className = i < enrol.step ? 'done' : (i === enrol.step ? 'now' : ''); dots.appendChild(e); });
  }
  function biggest(list) { return list.slice().sort(function (a, b) { return b.w * b.h - a.w * a.h; })[0]; }
  async function takeEnrol(d) {
    if (enrol.busy) return; enrol.busy = true;
    var p = await addSample(enrol.name, d);
    if (p) { enrol.got++; enrol.step++; enrol.stable = 0; enrol.until = performance.now() + 700; status('Captured ' + enrol.got + ' of ' + STEPS.length + '.'); }
    enrol.busy = false;
    if (enrol && enrol.step >= STEPS.length) { var n = enrol.name, g = enrol.got; enrol = null; $('coach').classList.remove('on'); toast('Saved ' + g + ' samples for ' + n); }
    else drawCoach();
  }
  function stepEnrol(list) {
    if (!enrol || enrol.busy || performance.now() < enrol.until) return;
    var d = biggest(list); if (!d) { enrol.stable = 0; return; }
    var f = d.raw, a = f.rotation && f.rotation.angle, step = STEPS[enrol.step];
    var good = d.emb && d.w > 110 && (f.faceScore || f.score || 0) > 0.6 && !(S.requireLive && d.real != null && d.real < LIVE_MIN);
    if (good && a && step.ok(a, enrol)) enrol.stable++; else enrol.stable = 0;
    if (enrol.stable >= 4) takeEnrol(d);
  }
  $('coachNow').addEventListener('click', function () { if (enrol) { var d = biggest(faces); if (d) takeEnrol(d); else toast('No face in view.'); } });
  $('coachCancel').addEventListener('click', cancelEnrol);

  /* ---------- snapshot ---------- */
  function snapshot() {
    var c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    var g = c.getContext('2d');
    if (mode === 'camera') {
      g.save(); if (facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
      g.drawImage(video, 0, 0, c.width, c.height); g.restore();
    }
    g.drawImage(canvas, 0, 0);
    c.toBlob(function (b) {
      if (!b) { toast('Could not make the snapshot.'); return; }
      var a = document.createElement('a'); a.href = URL.createObjectURL(b);
      a.download = 'facetag-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }, 'image/png');
  }

  /* ---------- backup (optionally encrypted) ---------- */
  function b64(buf) { var s = '', u = new Uint8Array(buf); for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }
  function unb64(s) { var r = atob(s), u = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; }
  async function keyFrom(pass, salt) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function exportBackup() {
    if (!people.length) { toast('Nobody to export yet.'); return; }
    var pass = await ask({ title: 'Passphrase to lock the backup', type: 'password', optional: true, ok: 'Export',
      hint: 'Leave empty for an unencrypted file. A face signature can identify a person, so a passphrase is wise.' });
    if (pass === null) return;
    var body = JSON.stringify({ app: 'face-tag', v: 2, people: people.map(function (p) {
      return { name: p.name, created: p.created, thumb: p.thumb, samples: p.samples.map(function (s) { return Array.from(s, function (v) { return Math.round(v * 1e5) / 1e5; }); }) };
    }) });
    var out;
    if (pass) {
      var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      var key = await keyFrom(pass, salt);
      var enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(body));
      out = JSON.stringify({ app: 'face-tag', v: 2, enc: true, salt: b64(salt), iv: b64(iv), data: b64(enc) });
    } else out = body;
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'application/json' }));
    a.download = 'facetag-backup.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000); toast('Backup exported.');
  }
  async function importBackup(file) {
    try {
      var j = JSON.parse(await file.text());
      if (j.enc) {
        var pass = await ask({ title: 'Passphrase for this backup', type: 'password', ok: 'Unlock' });
        if (!pass) return;
        var key = await keyFrom(pass, unb64(j.salt));
        var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data));
        j = JSON.parse(new TextDecoder().decode(plain));
      }
      if (j.app !== 'face-tag' || !Array.isArray(j.people)) throw new Error('not a Face Tag backup');
      var added = 0;
      for (var i = 0; i < j.people.length; i++) {
        var r = j.people[i]; if (!r.name || !Array.isArray(r.samples)) continue;
        var p = findPerson(r.name);
        if (!p) { p = { id: uid(), name: r.name, samples: [], thumb: r.thumb || null, created: r.created || Date.now() }; people.push(p); }
        r.samples.forEach(function (s) { p.samples.push(new Float32Array(s)); }); added++;
        while (p.samples.length > MAX_SAMPLES) p.samples.shift();
        await dbPut(p);
      }
      renderPeople(); toast('Imported ' + added + (added === 1 ? ' person.' : ' people.'));
    } catch (e) { toast('Import failed: ' + (e && e.name === 'OperationError' ? 'wrong passphrase.' : (e && e.message) || e)); }
  }

  /* ---------- wiring ---------- */
  $('startBtn').addEventListener('click', startCamera);
  $('flipBtn').addEventListener('click', function () { facing = facing === 'user' ? 'environment' : 'user'; startCamera(); });
  $('enrolBtn').addEventListener('click', function () { startEnrol(); });
  $('snapBtn').addEventListener('click', snapshot);
  $('photoIn').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) openPhoto(f); });
  $('expBtn').addEventListener('click', exportBackup);
  $('impIn').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });
  $('clearBtn').addEventListener('click', async function () {
    var b = $('clearBtn');
    if (b.dataset.sure) {
      for (var i = 0; i < people.length; i++) await dbDel(people[i].id);
      people = []; seen = {}; renderPeople(); renderSeen(); delete b.dataset.sure; b.textContent = 'Forget everyone';
    } else { b.dataset.sure = '1'; b.textContent = 'Tap again to forget everyone'; setTimeout(function () { delete b.dataset.sure; b.textContent = 'Forget everyone'; }, 3000); }
  });
  document.querySelectorAll('[data-set]').forEach(function (el) {
    el.checked = !!S[el.dataset.set];
    el.addEventListener('change', function () { S[el.dataset.set] = el.checked; saveSettings(); if (mode === 'photo') render(); });
  });
  $('thr').value = S.threshold; $('thr').addEventListener('input', function () { S.threshold = parseFloat($('thr').value); saveSettings(); });
  $('res').value = S.res; $('res').addEventListener('change', function () { S.res = $('res').value; saveSettings(); if (running) startCamera(); });
  document.addEventListener('visibilitychange', async function () {
    if (!document.hidden && running && !wakeLock) { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }
  });

  /* ---------- boot ---------- */
  (async function boot() {
    renderPeople();
    if (typeof window.Human === 'undefined') { status('The face engine did not load. Check the connection and reload.', 'bad'); return; }
    db = await idb(); people = (await dbAll()).map(function (p) { p.samples = p.samples.map(function (s) { return s instanceof Float32Array ? s : new Float32Array(s); }); return p; });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    renderPeople();
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(function () {});
    try { await initHuman(); status('Ready. Press “Start camera” or open a photo.'); }
    catch (e) { status('Face models could not load: ' + (e && e.message ? e.message : e), 'bad'); }
    window.FaceTag = { get faces() { return faces; }, get people() { return people; }, get human() { return human; }, openPhoto: openPhoto, addSample: addSample };
  })();
})();
