/* Face Tag fun effects. Everything is drawn from the 468-point face mesh, in a frame tied to the eyes,
   so accessories turn and scale with the head. Warps (big eyes, bobblehead, funhouse, face swap) reshape
   the real camera picture. Only the browser's 2D canvas is used. */
(function () {
  'use strict';
  var OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  var LIST = [
    ['none', '⭕', 'None'], ['sunglasses', '😎', 'Shades'], ['bigeyes', '👀', 'Big eyes'], ['bobble', '🎈', 'Bobblehead'],
    ['funhouse', '🪞', 'Funhouse'], ['swap', '🔁', 'Face swap'], ['emoji', '😀', 'Mood emoji'], ['dog', '🐶', 'Puppy'],
    ['tiger', '🐯', 'Tiger'], ['clown', '🤡', 'Clown'], ['raja', '👑', 'Raja'], ['alien', '👽', 'Alien'],
    ['laser', '🔴', 'Laser eyes'], ['party', '🥳', 'Party']
  ];
  var tmp = document.createElement('canvas'), tctx = tmp.getContext('2d');
  var state = {};                                                          // per face: confetti and the like
  var canFilter = typeof tctx.filter === 'string';

  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /* The face frame: origin between the eyes, x towards the screen-right eye, unit = eye distance. */
  function frame(m) {
    var a = mid(m[33], m[133]), b = mid(m[263], m[362]), e1 = a[0] <= b[0] ? a : b, e2 = a[0] <= b[0] ? b : a;
    var O = mid(e1, e2), u = Math.max(4, dist(e1, e2)), ang = Math.atan2(e2[1] - e1[1], e2[0] - e1[0]), c = Math.cos(ang), s = Math.sin(ang);
    function L(i) { var p = m[i], dx = p[0] - O[0], dy = p[1] - O[1]; return [(dx * c + dy * s) / u, (-dx * s + dy * c) / u]; }
    var top = L(10)[1], chin = L(152)[1], sa = L(234)[0], sb = L(454)[0], nose = L(1), up = L(13), lo = L(14);
    var right1 = sa < sb, cheekL = L(right1 ? 50 : 280), cheekR = L(right1 ? 280 : 50);
    return { O: O, u: u, ang: ang, e1: e1, e2: e2, L: L, top: top, chin: chin, left: Math.min(sa, sb), right: Math.max(sa, sb), nose: nose,
      mouth: mid(up, lo), mouthOpen: dist(up, lo), mouthW: dist(L(61), L(291)), lipLow: L(14)[1], cheekL: cheekL, cheekR: cheekR,
      W: function (x, y) { return [O[0] + (x * c - y * s) * u, O[1] + (x * s + y * c) * u]; } };
  }
  function enter(ctx, F) { ctx.save(); ctx.translate(F.O[0], F.O[1]); ctx.rotate(F.ang); ctx.scale(F.u, F.u); }
  function ovalPath(ctx, m, shrink, F) {
    ctx.beginPath();
    OVAL.forEach(function (i, n) { var p = m[i], x = F.O[0] + (p[0] - F.O[0]) * shrink, y = F.O[1] + (p[1] - F.O[1]) * shrink; if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
  }
  function ell(ctx, x, y, rx, ry, rot) { ctx.beginPath(); ctx.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot || 0, 0, 6.2832); }

  /* ---------- warps ---------- */
  function sizeTmp(W, H) { if (tmp.width !== W || tmp.height !== H) { tmp.width = W; tmp.height = H; } tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, W, H); tctx.globalCompositeOperation = 'source-over'; }
  /* Scale the picture by (sx, sy) along the face's axes about an anchor, keep only a soft ellipse of it, and lay it on top. */
  function warp(ctx, src, W, H, anchor, ang, sx, sy, center, rx, ry, soft) {
    sizeTmp(W, H);
    tctx.translate(anchor[0], anchor[1]); tctx.rotate(ang); tctx.scale(sx, sy); tctx.rotate(-ang); tctx.translate(-anchor[0], -anchor[1]);
    tctx.drawImage(src, 0, 0, W, H);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    var dx = center[0] - anchor[0], dy = center[1] - anchor[1], c = Math.cos(ang), s = Math.sin(ang);
    var lx = (dx * c + dy * s) * sx, ly = (-dx * s + dy * c) * sy, cx = anchor[0] + lx * c - ly * s, cy = anchor[1] + lx * s + ly * c;
    tctx.globalCompositeOperation = 'destination-in';
    tctx.translate(cx, cy); tctx.rotate(ang); tctx.scale(rx * sx, ry * sy);
    var g = tctx.createRadialGradient(0, 0, soft, 0, 0, 1); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    tctx.fillStyle = g; tctx.fillRect(-1.1, -1.1, 2.2, 2.2);
    tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }
  function bigEyes(ctx, src, W, H, F) {
    [F.e1, F.e2].forEach(function (e) { warp(ctx, src, W, H, e, F.ang, 1.75, 1.75, e, 0.48 * F.u, 0.4 * F.u, 0.55); });
  }
  function bobble(ctx, src, W, H, F) {
    var chin = F.W(0, F.chin), cen = F.W(0, (F.top + F.chin) / 2 - 0.15), rx = (F.right - F.left) / 2 * 1.3 * F.u, ry = (F.chin - F.top) / 2 * 1.4 * F.u;
    warp(ctx, src, W, H, chin, F.ang, 1.5, 1.5, cen, rx, ry, 0.72);
  }
  function funhouse(ctx, src, W, H, F, t) {
    var cen = F.W(0, (F.top + F.chin) / 2), rx = (F.right - F.left) / 2 * 1.25 * F.u, ry = (F.chin - F.top) / 2 * 1.3 * F.u, wob = Math.sin(t / 380) * 0.12;
    warp(ctx, src, W, H, cen, F.ang, 0.82 - wob * 0.5, 1.4 + wob, cen, rx, ry, 0.7);
  }
  /* Put face B onto face A: a similarity transform that lines up B's eyes with A's, inside A's soft face outline. */
  function swapOnto(ctx, src, W, H, A, B, mA) {
    sizeTmp(W, H);
    var sc = A.u / B.u, rot = A.ang - B.ang;
    tctx.translate(A.O[0], A.O[1]); tctx.rotate(rot); tctx.scale(sc, sc); tctx.translate(-B.O[0], -B.O[1]);
    tctx.drawImage(src, 0, 0, W, H);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    if (canFilter) tctx.filter = 'blur(' + Math.max(2, A.u * 0.12) + 'px)';
    tctx.fillStyle = '#000'; ovalPath(tctx, mA, 0.9, A); tctx.fill();
    if (canFilter) tctx.filter = 'none';
    tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }

  /* ---------- drawn effects (in eye units) ---------- */
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  function sunglasses(ctx, F) {
    enter(ctx, F);
    [-0.5, 0.5].forEach(function (cx) {
      rrect(ctx, cx - 0.42, -0.24, 0.84, 0.52, 0.2);
      var g = ctx.createLinearGradient(0, -0.24, 0, 0.28); g.addColorStop(0, 'rgba(25,25,35,.96)'); g.addColorStop(1, 'rgba(60,60,80,.94)');
      ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 0.07; ctx.strokeStyle = '#0b0b0b'; ctx.stroke();
      ctx.save(); rrect(ctx, cx - 0.42, -0.24, 0.84, 0.52, 0.2); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 0.09; ctx.beginPath(); ctx.moveTo(cx - 0.3, 0.25); ctx.lineTo(cx + 0.05, -0.3); ctx.stroke();
      ctx.lineWidth = 0.04; ctx.beginPath(); ctx.moveTo(cx - 0.12, 0.28); ctx.lineTo(cx + 0.2, -0.3); ctx.stroke(); ctx.restore();
    });
    ctx.strokeStyle = '#0b0b0b'; ctx.lineWidth = 0.07;
    ctx.beginPath(); ctx.moveTo(-0.09, -0.08); ctx.quadraticCurveTo(0, -0.18, 0.09, -0.08); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-0.92, -0.12); ctx.lineTo(F.left + 0.05, -0.1); ctx.moveTo(0.92, -0.12); ctx.lineTo(F.right - 0.05, -0.1); ctx.stroke();
    ctx.restore();
  }
  function clown(ctx, F) {
    enter(ctx, F);
    var top = F.top, n = F.nose;
    for (var i = 0; i < 11; i++) {                                         // rainbow wig
      var a = Math.PI * (1.05 + 0.9 * i / 10), x = Math.cos(a) * 1.3, y = top + 0.55 + Math.sin(a) * 0.95;
      ctx.fillStyle = 'hsl(' + (i * 33) + ',90%,58%)'; ell(ctx, x, y, 0.4, 0.4); ctx.fill();
    }
    [F.cheekL, F.cheekR].forEach(function (c) { var g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], 0.36); g.addColorStop(0, 'rgba(255,60,100,.6)'); g.addColorStop(1, 'rgba(255,60,100,0)'); ctx.fillStyle = g; ell(ctx, c[0], c[1], 0.36, 0.36); ctx.fill(); });
    var g = ctx.createRadialGradient(n[0] - 0.08, n[1] - 0.1, 0.02, n[0], n[1], 0.3); g.addColorStop(0, '#ff8a8a'); g.addColorStop(0.35, '#ff1d2d'); g.addColorStop(1, '#a3000c');
    ctx.fillStyle = g; ell(ctx, n[0], n[1], 0.28, 0.28); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ell(ctx, n[0] - 0.09, n[1] - 0.11, 0.07, 0.05, -0.5); ctx.fill();
    ctx.restore();
  }
  function dog(ctx, F, t) {
    enter(ctx, F);
    var top = F.top, n = F.nose, flop = Math.sin(t / 300) * 0.04;
    [-1, 1].forEach(function (sd) {
      var ax = sd * 0.62, ay = top + 0.25;
      ctx.fillStyle = '#6b3f1f'; ctx.beginPath(); ctx.moveTo(ax, ay);
      ctx.bezierCurveTo(sd * 1.45, ay - 0.2, sd * (1.55 + flop), ay + 1.2, sd * 1.15, ay + 1.75);
      ctx.bezierCurveTo(sd * 0.95, ay + 1.95, sd * 0.8, ay + 1.2, sd * 0.85, ay + 0.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c78a5c'; ctx.beginPath(); ctx.moveTo(sd * 0.8, ay + 0.15);
      ctx.bezierCurveTo(sd * 1.25, ay + 0.05, sd * (1.32 + flop), ay + 1.1, sd * 1.12, ay + 1.5);
      ctx.bezierCurveTo(sd * 1.0, ay + 1.55, sd * 0.92, ay + 1.0, sd * 0.92, ay + 0.6); ctx.closePath(); ctx.fill();
    });
    if (F.mouthOpen > 0.12) {                                              // open your mouth: out comes the tongue
      var len = 0.35 + Math.min(1.2, (F.mouthOpen - 0.12) * 3.2), x = F.mouth[0], y = F.lipLow - 0.05;
      ctx.fillStyle = '#ff5f8a'; ctx.beginPath(); ctx.moveTo(x - 0.2, y);
      ctx.bezierCurveTo(x - 0.24, y + len, x + 0.24, y + len, x + 0.2, y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#d63a66'; ctx.lineWidth = 0.035; ctx.beginPath(); ctx.moveTo(x, y + 0.05); ctx.lineTo(x, y + len * 0.6); ctx.stroke();
    }
    var g = ctx.createRadialGradient(n[0] - 0.06, n[1] - 0.1, 0.01, n[0], n[1] - 0.04, 0.3); g.addColorStop(0, '#555'); g.addColorStop(0.4, '#111'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ell(ctx, n[0], n[1] - 0.04, 0.27, 0.19); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ell(ctx, n[0] - 0.08, n[1] - 0.12, 0.07, 0.035, -0.3); ctx.fill();
    ctx.restore();
  }
  function tiger(ctx, F, m) {
    ctx.save(); ovalPath(ctx, m, 1.02, F); ctx.clip();
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(255,140,30,.9)'; ctx.fillRect(F.O[0] - 4 * F.u, F.O[1] - 4 * F.u, 8 * F.u, 8 * F.u);
    ctx.globalCompositeOperation = 'source-over';
    enter(ctx, F);
    var n = F.nose, top = F.top, l = F.left, r = F.right;
    ctx.fillStyle = 'rgba(255,248,235,.55)'; ell(ctx, n[0], n[1] + 0.42, 0.62, 0.4); ctx.fill();
    ell(ctx, -0.5, 0.05, 0.32, 0.2); ctx.fill(); ell(ctx, 0.5, 0.05, 0.32, 0.2); ctx.fill();
    ctx.fillStyle = 'rgba(15,10,8,.85)';
    [0, 1, 2].forEach(function (i) {                                       // forehead chevrons
      var y = top + 0.3 + i * 0.28, w = 0.5 - i * 0.12;
      ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(0, y + 0.18); ctx.lineTo(w, y); ctx.lineTo(0, y + 0.08); ctx.closePath(); ctx.fill();
    });
    [[l, 1], [r, -1]].forEach(function (s) {                               // cheek stripes from the face edge inward
      [0.15, 0.5, 0.85].forEach(function (y) {
        ctx.beginPath(); ctx.moveTo(s[0], y - 0.08); ctx.quadraticCurveTo(s[0] + s[1] * 0.35, y, s[0] + s[1] * 0.6, y + 0.05); ctx.quadraticCurveTo(s[0] + s[1] * 0.3, y + 0.08, s[0], y + 0.1); ctx.closePath(); ctx.fill();
      });
    });
    ctx.beginPath(); ctx.moveTo(n[0] - 0.17, n[1] - 0.05); ctx.lineTo(n[0] + 0.17, n[1] - 0.05); ctx.lineTo(n[0], n[1] + 0.12); ctx.closePath(); ctx.fill();
    ctx.restore(); ctx.restore();
    enter(ctx, F);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 0.025;
    [-1, 1].forEach(function (sd) { [-0.08, 0.04, 0.16].forEach(function (dy) { ctx.beginPath(); ctx.moveTo(n[0] + sd * 0.35, n[1] + 0.3 + dy); ctx.lineTo(n[0] + sd * 1.3, n[1] + 0.2 + dy * 2.2); ctx.stroke(); }); });
    [-1, 1].forEach(function (sd) {
      var x = sd * 0.95, y = top + 0.2;
      ctx.fillStyle = '#ff9a2e'; ell(ctx, x, y, 0.33, 0.33); ctx.fill(); ctx.lineWidth = 0.06; ctx.strokeStyle = '#1a120c'; ctx.stroke();
      ctx.fillStyle = '#fff3e0'; ell(ctx, x, y + 0.03, 0.17, 0.17); ctx.fill();
    });
    ctx.restore();
  }
  function raja(ctx, F) {
    enter(ctx, F);
    var b = F.top - 0.02, g = ctx.createLinearGradient(0, b - 0.8, 0, b);
    g.addColorStop(0, '#fff2a8'); g.addColorStop(0.5, '#f5c518'); g.addColorStop(1, '#b8860b');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-0.85, b);
    [[-0.95, b - 0.7], [-0.45, b - 0.38], [0, b - 0.95], [0.45, b - 0.38], [0.95, b - 0.7], [0.85, b]].forEach(function (p) { ctx.lineTo(p[0], p[1]); });
    ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#8a6400'; ctx.lineWidth = 0.04; ctx.stroke();
    [[-0.95, b - 0.7, '#e0115f'], [0, b - 0.95, '#1e90ff'], [0.95, b - 0.7, '#e0115f']].forEach(function (p) { ctx.fillStyle = '#fff2a8'; ell(ctx, p[0], p[1], 0.09, 0.09); ctx.fill(); });
    [[-0.45, b - 0.18, '#e0115f'], [0, b - 0.2, '#16c172'], [0.45, b - 0.18, '#1e90ff']].forEach(function (p) { ctx.fillStyle = p[2]; ell(ctx, p[0], p[1], 0.1, 0.1); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.6)'; ell(ctx, p[0] - 0.03, p[1] - 0.03, 0.03, 0.03); ctx.fill(); });
    var ny = (F.nose[1] + F.mouth[1]) / 2 + 0.02, nx = F.nose[0];       // the zamindar's handlebar moustache
    ctx.fillStyle = '#24160c';
    [-1, 1].forEach(function (sd) {
      ctx.beginPath(); ctx.moveTo(nx, ny - 0.06);
      ctx.bezierCurveTo(nx + sd * 0.3, ny - 0.16, nx + sd * 0.6, ny - 0.02, nx + sd * 0.78, ny - 0.22);
      ctx.bezierCurveTo(nx + sd * 0.92, ny - 0.42, nx + sd * 0.72, ny - 0.5, nx + sd * 0.68, ny - 0.36);
      ctx.bezierCurveTo(nx + sd * 0.8, ny - 0.38, nx + sd * 0.8, ny - 0.2, nx + sd * 0.62, ny + 0.06);
      ctx.bezierCurveTo(nx + sd * 0.4, ny + 0.16, nx + sd * 0.15, ny + 0.06, nx, ny + 0.06); ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  }
  function alien(ctx, F, m, t) {
    ctx.save(); ovalPath(ctx, m, 1.02, F); ctx.clip();
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(110,255,120,.95)'; ctx.fillRect(F.O[0] - 4 * F.u, F.O[1] - 4 * F.u, 8 * F.u, 8 * F.u);
    ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = 'rgba(30,110,40,.35)'; ctx.fillRect(F.O[0] - 4 * F.u, F.O[1] - 4 * F.u, 8 * F.u, 8 * F.u);
    ctx.restore();
    enter(ctx, F);
    [-1, 1].forEach(function (sd) {
      var g = ctx.createRadialGradient(sd * 0.5, -0.02, 0.05, sd * 0.5, 0.02, 0.48); g.addColorStop(0, '#2a2a3a'); g.addColorStop(1, '#000');
      ctx.fillStyle = g; ell(ctx, sd * 0.52, 0.02, 0.46, 0.27, sd * 0.42); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ell(ctx, sd * 0.42, -0.08, 0.09, 0.05, sd * 0.42); ctx.fill();
      var tip = [sd * (0.7 + 0.05 * Math.sin(t / 250 + sd)), F.top - 0.95];
      ctx.strokeStyle = '#3ad15a'; ctx.lineWidth = 0.05; ctx.beginPath(); ctx.moveTo(sd * 0.3, F.top + 0.1); ctx.quadraticCurveTo(sd * 0.55, F.top - 0.4, tip[0], tip[1]); ctx.stroke();
      var gg = ctx.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], 0.22); gg.addColorStop(0, '#eaffd0'); gg.addColorStop(0.4, '#5dff6a'); gg.addColorStop(1, 'rgba(93,255,106,0)');
      ctx.fillStyle = gg; ell(ctx, tip[0], tip[1], 0.22, 0.22); ctx.fill();
    });
    ctx.restore();
  }
  function laser(ctx, F, t) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    [F.e1, F.e2].forEach(function (e, i) {
      var R = F.u * 0.9, g = ctx.createRadialGradient(e[0], e[1], 0, e[0], e[1], R);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.12, 'rgba(255,80,80,.95)'); g.addColorStop(0.4, 'rgba(255,0,0,.35)'); g.addColorStop(1, 'rgba(255,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(e[0], e[1], R, 0, 6.2832); ctx.fill();
      ctx.save(); ctx.translate(e[0], e[1]); ctx.rotate(t / 900 * (i ? -1 : 1) + F.ang);
      for (var k = 0; k < 4; k++) {
        ctx.rotate(Math.PI / 2); var len = F.u * (2.2 + 0.4 * Math.sin(t / 120 + k));
        var lg = ctx.createLinearGradient(0, 0, len, 0); lg.addColorStop(0, 'rgba(255,220,220,.95)'); lg.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(0, -F.u * 0.05); ctx.lineTo(len, 0); ctx.lineTo(0, F.u * 0.05); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    });
    ctx.restore();
  }
  var EMO = { happy: '😄', sad: '😢', angry: '😠', surprise: '😮', fear: '😨', disgust: '🤢', neutral: '🙂' };
  function emoji(ctx, F, face) {
    var e = EMO[face.emotion] || '🙂';
    if (F.mouthOpen > 0.28) e = '😮'; else if (F.mouthW > 1.05 || face.emotion === 'happy') e = F.mouthOpen > 0.12 ? '😆' : '😄';
    var c = F.W(0, (F.top + F.chin) / 2), size = (F.chin - F.top) * F.u * 1.15;
    ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(F.ang);
    ctx.font = size + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(e, 0, size * 0.04); ctx.restore();
  }
  function party(ctx, F, face, t, dt) {
    enter(ctx, F);
    var b = F.top + 0.12, apex = [0.25, F.top - 1.55];
    ctx.save(); ctx.beginPath(); ctx.moveTo(-0.6, b); ctx.lineTo(apex[0], apex[1]); ctx.lineTo(0.62, b); ctx.closePath(); ctx.clip();
    for (var i = -6; i < 8; i++) { ctx.fillStyle = i % 2 ? '#ff4fa3' : '#ffd43b'; ctx.beginPath(); ctx.moveTo(-2, b - i * 0.28); ctx.lineTo(2, b - i * 0.28 - 0.9); ctx.lineTo(2, b - i * 0.28 - 0.75); ctx.lineTo(-2, b - i * 0.28 + 0.15); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = '#4dabf7'; [0, 1, 2, 3, 4].forEach(function (k) { ell(ctx, -0.6 + k * 0.305, b, 0.13, 0.08); ctx.fill(); });
    ctx.fillStyle = '#ffffff'; ell(ctx, apex[0], apex[1], 0.17, 0.17); ctx.fill();
    ctx.restore();
    var st = state[face.id] || (state[face.id] = { bits: [] }), happy = face.emotion === 'happy' || F.mouthW > 1.0 || F.mouthOpen > 0.2;
    var top = F.W(apex[0], apex[1]);
    if (happy && st.bits.length < 160) for (var n = 0; n < 4; n++) {     // smile for confetti
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = F.u * (3 + Math.random() * 4);
      st.bits.push({ x: top[0], y: top[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, hue: Math.random() * 360, s: F.u * (0.05 + Math.random() * 0.05), r: Math.random() * 6 });
    }
    st.bits = st.bits.filter(function (p) { return p.life < 2.2; });
    st.bits.forEach(function (p) {
      p.life += dt; p.vy += F.u * 6 * dt; p.vx *= 0.98; p.x += p.vx * dt; p.y += p.vy * dt; p.r += dt * 8;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = 'hsla(' + p.hue + ',90%,60%,' + Math.max(0, 1 - p.life / 2.2) + ')';
      ctx.fillRect(-p.s, -p.s * 0.5, p.s * 2, p.s); ctx.restore();
    });
  }

  var lastT = 0;
  /* faces: [{ id, mesh: 468 [x, y] points in canvas coordinates, emotion }]; src: the picture under the effects. */
  function draw(ctx, src, W, H, faces, effect, now) {
    var dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016; lastT = now;
    var Fs = faces.filter(function (f) { return f.mesh && f.mesh.length >= 468; }).map(function (f) { return { f: f, F: frame(f.mesh) }; });
    if (effect === 'swap') {
      var order = Fs.slice().sort(function (a, b) { return a.F.O[0] - b.F.O[0]; });
      for (var i = 0; i + 1 < order.length; i += 2) { swapOnto(ctx, src, W, H, order[i].F, order[i + 1].F, order[i].f.mesh); swapOnto(ctx, src, W, H, order[i + 1].F, order[i].F, order[i + 1].f.mesh); }
      return order.length < 2 ? 'Face swap needs two faces in view.' : '';
    }
    Fs.forEach(function (x) {
      var F = x.F, f = x.f;
      if (effect === 'bigeyes') bigEyes(ctx, src, W, H, F);
      else if (effect === 'bobble') bobble(ctx, src, W, H, F);
      else if (effect === 'funhouse') funhouse(ctx, src, W, H, F, now);
      else if (effect === 'sunglasses') sunglasses(ctx, F);
      else if (effect === 'clown') clown(ctx, F);
      else if (effect === 'dog') dog(ctx, F, now);
      else if (effect === 'tiger') tiger(ctx, F, f.mesh);
      else if (effect === 'raja') raja(ctx, F);
      else if (effect === 'alien') alien(ctx, F, f.mesh, now);
      else if (effect === 'laser') laser(ctx, F, now);
      else if (effect === 'emoji') emoji(ctx, F, f);
      else if (effect === 'party') party(ctx, F, f, now, dt);
    });
    if (effect === 'dog' && Fs.length) return 'Open your mouth wide for the tongue.';
    if (effect === 'party' && Fs.length) return 'Smile for confetti.';
    return '';
  }
  window.FaceFX = { list: LIST, draw: draw, needsPicture: function (e) { return ['bigeyes', 'bobble', 'funhouse', 'swap'].indexOf(e) >= 0; } };
})();
