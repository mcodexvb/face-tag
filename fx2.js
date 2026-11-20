/* Face Tag studio effects: GPU (WebGL2) shaders on the face mesh and the whole picture, plus a person mask
   for background effects. Three layers per frame:
     1. a full-screen shader (toon, glitch, smooth lens warp, portrait blur, space, gold, dark stage),
     2. the face mesh drawn in its own texture space (neon wireframe, hologram, alpona and glow paint),
     3. a 2D particle layer (fire breath, clone trails). */
(function () {
  'use strict';
  var LIST = [
    ['none', '⭕', 'None'], ['neon', '🕸️', 'Neon mesh'], ['holo', '💠', 'Hologram'], ['alpona', '🌸', 'Alpona art'], ['tribal', '✨', 'Glow paint'],
    ['toon', '🎨', 'Comic'], ['lens', '🔮', 'Big eyes'], ['glitch', '📺', 'Glitch'], ['portrait', '📷', 'Portrait'], ['space', '🌌', 'Space'],
    ['gold', '🏆', 'Gold statue'], ['clones', '👥', 'Clones'], ['fire', '🔥', 'Fire breath']
  ];
  var MODE = { none: 0, lens: 1, toon: 2, glitch: 3, portrait: 4, space: 5, gold: 6, neon: 7, holo: 7, alpona: 0, tribal: 8, clones: 0, fire: 0 };
  var MESH = { neon: 1, holo: 2, alpona: 3, tribal: 4 };
  var SEG = { portrait: 1, space: 1, gold: 1, clones: 1 };

  var gl = null, cv = document.createElement('canvas'), progBG = null, progMesh = null, quad = null, meshBuf = null, texFrame = null, texMask = null, ok = null;
  var mask = null, maskW = 0, maskH = 0, maskFresh = false, maskCan = document.createElement('canvas'), maskCtx = maskCan.getContext('2d');

  var VS_Q = '#version 300 es\nin vec2 a;out vec2 v;void main(){v=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}';
  var FS_BG = [
    '#version 300 es', 'precision highp float;', 'in vec2 v;out vec4 o;',
    'uniform sampler2D uTex,uMask;uniform vec2 uRes;uniform float uTime;uniform int uMode,uHasMask,uN;uniform vec4 uEye[4];uniform vec4 uFace[4];',
    'float lum(vec3 c){return dot(c,vec3(.299,.587,.114));}',
    'float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}',
    'float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vn(p);p*=2.03;a*=.5;}return s;}',
    // smooth magnifying lens around each eye: sample nearer the centre, easing back to normal at the rim
    'vec2 lens(vec2 p,float k){for(int i=0;i<4;i++){if(i>=uN)break;for(int e=0;e<2;e++){vec2 c=e==0?uEye[i].xy:uEye[i].zw;float r=uFace[i].z*.5;vec2 d=p-c;float l=length(d);if(l<r){float t=l/r;t=t*t*(3.-2.*t);p=c+d*mix(k,1.,t);}}}return p;}',
    'vec3 blur(vec2 uv,float r){vec3 s=vec3(0);float w=0.;for(int i=0;i<24;i++){float a=float(i)*2.39996,rr=sqrt(float(i)/24.)*r;vec2 o=vec2(cos(a),sin(a))*rr/uRes;s+=texture(uTex,uv+o).rgb;w+=1.;}return s/w;}',
    'vec3 space(vec2 q){vec2 p=q*vec2(uRes.x/uRes.y,1.)*3.;float n=fbm(p+vec2(uTime*.03,0.)),m=fbm(p*1.7-vec2(0.,uTime*.02)+n);',
    ' vec3 c=mix(vec3(.02,.01,.06),vec3(.35,.08,.45),smoothstep(.35,.85,n))+vec3(.05,.25,.5)*smoothstep(.45,.9,m);',
    ' vec2 g=floor(q*uRes/3.);float s=h21(g);float tw=.6+.4*sin(uTime*3.+s*40.);c+=vec3(1.)*step(.996,s)*tw;return c;}',
    'vec3 gold(float L){L=clamp(L*1.25-.08,0.,1.);vec3 a=vec3(.13,.07,.02),b=vec3(.78,.53,.13),c=vec3(1.,.93,.62);return L<.55?mix(a,b,L/.55):mix(b,c,(L-.55)/.45);}',
    'void main(){',
    ' vec2 p=v*uRes;',
    ' if(uMode==1)p=lens(p,.55);else if(uMode==2)p=lens(p,.72);',
    ' vec2 uv=p/uRes;vec3 c=texture(uTex,uv).rgb;',
    ' float a=uHasMask==1?smoothstep(.3,.7,texture(uMask,v).r):1.;',
    ' if(uMode==2){vec2 px=1./uRes;float tl=lum(texture(uTex,uv+px*vec2(-1,-1)).rgb),t=lum(texture(uTex,uv+px*vec2(0,-1)).rgb),tr=lum(texture(uTex,uv+px*vec2(1,-1)).rgb),',
    '  l=lum(texture(uTex,uv+px*vec2(-1,0)).rgb),r=lum(texture(uTex,uv+px*vec2(1,0)).rgb),bl=lum(texture(uTex,uv+px*vec2(-1,1)).rgb),b=lum(texture(uTex,uv+px*vec2(0,1)).rgb),br=lum(texture(uTex,uv+px*vec2(1,1)).rgb);',
    '  float gx=tr+2.*r+br-tl-2.*l-bl,gy=bl+2.*b+br-tl-2.*t-tr,e=length(vec2(gx,gy));',
    '  vec3 q=blur(uv,3.);float L=lum(q);q=mix(vec3(L),q,1.6);q=floor(q*5.+.5)/5.;',
    '  float dots=step(.5,fract((gl_FragCoord.x+gl_FragCoord.y)*.25))*step(L,.35)*.15;',
    '  c=mix(q-dots,vec3(.04),smoothstep(.22,.5,e));}',
    ' else if(uMode==3){float t=floor(uTime*14.),row=floor(v.y*28.),band=step(.8,h21(vec2(row,t)));float off=(h21(vec2(t,row))-.5)*.09*band,sp=.004+.014*band;',
    '  c=vec3(texture(uTex,uv+vec2(off+sp,0)).r,texture(uTex,uv+vec2(off,0)).g,texture(uTex,uv+vec2(off-sp,0)).b);',
    '  c*=.86+.14*sin(gl_FragCoord.y*1.6);c+=(h21(gl_FragCoord.xy+t)-.5)*.08;if(h21(vec2(t,7.))>.94)c=mix(c,vec3(1.)-c,.8);}',
    ' else if(uMode==4){vec3 bg=blur(uv,uRes.y*.035);c=mix(bg*.9,c,a);float vg=1.-.35*length(v-.5);c*=vg;}',
    ' else if(uMode==5){float e=a*(1.-a)*4.;c=mix(space(v),c,a)+vec3(.35,.8,1.)*e;}',
    ' else if(uMode==6){float L=lum(c);float sw=exp(-pow((v.x+v.y*.6-fract(uTime*.22)*2.4+.4)*7.,2.));vec3 g=gold(L)+vec3(1.,.95,.75)*sw*.45;c=mix(vec3(lum(c))*.42,g,a);}',
    ' else if(uMode==7)c=vec3(lum(c))*.22+c*.06;',
    ' else if(uMode==8)c=c*.72;',
    ' o=vec4(c,1.);}'
  ].join('\n');
  var VS_M = '#version 300 es\nin vec2 aP;in vec2 aU;in vec3 aB;in float aR;uniform vec2 uRes;out vec2 vU;out vec3 vB;out float vR;' +
    'void main(){vU=aU;vB=aB;vR=aR;gl_Position=vec4(aP.x/uRes.x*2.-1.,1.-aP.y/uRes.y*2.,0.,1.);}';
  var FS_M = [
    '#version 300 es', 'precision highp float;', 'in vec2 vU;in vec3 vB;in float vR;out vec4 o;uniform int uMode;uniform float uTime;',
    'vec3 hsv(float h,float s,float v){vec3 k=clamp(abs(mod(h*6.+vec3(0,4,2),6.)-3.)-1.,0.,1.);return v*mix(vec3(1),k,s);}',
    'float ring(float d,float w){float f=fwidth(d)*1.2;return 1.-smoothstep(w-f,w+f,abs(d));}',
    'float dotf(vec2 p,vec2 c,float r){float d=length(p-c);float f=fwidth(d)*1.2;return 1.-smoothstep(r-f,r+f,d);}',
    // alpona motifs, laid out in the face's own texture space (mirrored left and right)
    'float alpona(vec2 uv){vec2 q=vec2(abs(uv.x-.5),uv.y);float s=0.;',
    ' vec2 F=vec2(.5,.19);float r=length(uv-F),a=atan(uv.y-F.y,uv.x-F.x);',
    ' s=max(s,ring(r-.078,.005));s=max(s,ring(r-.078*(.42+.38*abs(cos(4.*a))),.0045));s=max(s,ring(r-.03,.004));s=max(s,dotf(uv,F,.013));',
    ' for(int i=0;i<12;i++){float t=float(i)*.5236;s=max(s,dotf(uv,F+.098*vec2(cos(t),sin(t)),.0085));}',
    ' vec2 C=vec2(.24,.61);float rc=length(q-C),ac=atan(q.y-C.y,q.x-C.x);',
    ' if(rc<.085){float sp=abs(fract(rc/.021-ac/6.2832)-.5)*.021;s=max(s,1.-smoothstep(.0035,.0035+fwidth(sp)*1.5,sp));}',
    ' s=max(s,ring(rc-.095,.0045));for(int i=0;i<10;i++){float t=float(i)*.6283;s=max(s,dotf(q,C+.112*vec2(cos(t),sin(t)),.0065));}',
    ' for(int i=0;i<5;i++){float x=.07+.045*float(i);s=max(s,dotf(q,vec2(x,.222-.18*x*x),.009-.0008*float(i)));}',
    ' for(int i=0;i<9;i++){float t=.35+.2725*float(i)*.5;s=max(s,dotf(q,vec2(.5,.52)+vec2(-.41*cos(t)+.5,.41*sin(t))-vec2(.5,0.),.0075));}',
    ' vec2 Ch=vec2(.5,.875);s=max(s,dotf(uv,Ch,.015));s=max(s,ring(length(uv-Ch)-.038,.004)*step(uv.y,Ch.y+.005));s=max(s,dotf(q,vec2(.05,.89),.009));',
    ' return clamp(s,0.,1.);}',
    'void main(){float d=min(min(vB.x,vB.y),vB.z),w=fwidth(d);float line=1.-smoothstep(w*.4,w*1.6,d),glow=1.-smoothstep(0.,w*6.,d);',
    ' if(uMode==1){vec3 c=hsv(fract(vU.y*.9+vU.x*.3-uTime*.12),.75,1.);o=vec4(c*(line*1.25+glow*.08),1.);}',
    ' else if(uMode==2){float sc=.55+.45*sin(gl_FragCoord.y*1.3+uTime*18.),fl=.85+.15*sin(uTime*47.);vec3 c=vec3(.25,.9,1.)*(.12+vR*.95)*sc*fl+vec3(.6,1.,1.)*line*.22;o=vec4(c,1.);}',
    ' else if(uMode==3){float s=alpona(vU);o=vec4(vec3(1.,.985,.95)*s,s);}',
    ' else{float s=alpona(vU);vec3 c=hsv(fract(vU.y*.6-uTime*.15),.8,1.);float pulse=.7+.3*sin(uTime*4.+vU.y*20.);o=vec4(c*s*1.4*pulse+c*s*.3,1.);}}'
  ].join('\n');

  function shader(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function program(vs, fs) {
    var p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i), nm = info.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, info.name); }
    return { p: p, u: u };
  }
  function tex() { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(function (k) { gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE); }); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); return t; }
  function init() {
    if (ok !== null) return ok;
    try {
      gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl || !window.FaceMeshData) { ok = false; return ok; }
      progBG = program(VS_Q, FS_BG); progMesh = program(VS_M, FS_M);
      quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      meshBuf = gl.createBuffer(); texFrame = tex(); texMask = tex();
      ok = true;
    } catch (e) { console.warn('studio effects unavailable', e); ok = false; }
    return ok;
  }

  /* Per face: 880 triangles, each vertex with screen position, texture-space position, barycentric corner and rim light. */
  var TRI = null, UV = null, vbo = null;
  function meshVerts(m) {
    if (!TRI) { TRI = window.FaceMeshData.tri; UV = window.FaceMeshData.uv; vbo = new Float32Array(TRI.length * 8); }
    var nrm = new Float32Array(468 * 3), i, a, b, c;
    for (i = 0; i < TRI.length; i += 3) {                                    // vertex normals from the mesh's depth, for the hologram's rim light
      a = m[TRI[i]]; b = m[TRI[i + 1]]; c = m[TRI[i + 2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = (b[2] || 0) - (a[2] || 0), vx = c[0] - a[0], vy = c[1] - a[1], vz = (c[2] || 0) - (a[2] || 0);
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      [TRI[i], TRI[i + 1], TRI[i + 2]].forEach(function (k) { nrm[k * 3] += nx; nrm[k * 3 + 1] += ny; nrm[k * 3 + 2] += nz; });
    }
    var BAR = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (i = 0; i < TRI.length; i++) {
      var k = TRI[i], o = i * 8, l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]) || 1;
      vbo[o] = m[k][0]; vbo[o + 1] = m[k][1]; vbo[o + 2] = UV[k * 2]; vbo[o + 3] = UV[k * 2 + 1];
      vbo[o + 4] = BAR[i % 3][0]; vbo[o + 5] = BAR[i % 3][1]; vbo[o + 6] = BAR[i % 3][2];
      vbo[o + 7] = Math.pow(1 - Math.abs(nrm[k * 3 + 2]) / l, 1.5);
    }
    return vbo;
  }

  function eyeUnits(m) {
    var a = [(m[33][0] + m[133][0]) / 2, (m[33][1] + m[133][1]) / 2], b = [(m[263][0] + m[362][0]) / 2, (m[263][1] + m[362][1]) / 2];
    return { a: a, b: b, u: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  }

  /* ---------- 2D layer: fire breath and clone trails ---------- */
  var fire = [], sprite = null, clones = [], cloneAt = 0, pool = [], cut = document.createElement('canvas'), cutCtx = cut.getContext('2d');
  function glowSprite() {
    if (sprite) return sprite;
    sprite = document.createElement('canvas'); sprite.width = sprite.height = 64; var g = sprite.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,.5)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return sprite;
  }
  var FLAME = [[255, 250, 220], [255, 214, 90], [255, 140, 30], [230, 60, 20], [90, 70, 70]];
  var tinted = {};
  function tintSprite(i) {
    if (tinted[i]) return tinted[i];
    var c = document.createElement('canvas'); c.width = c.height = 64; var g = c.getContext('2d');
    g.drawImage(glowSprite(), 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgb(' + FLAME[i].join(',') + ')'; g.fillRect(0, 0, 64, 64);
    return (tinted[i] = c);
  }
  function fireLayer(ctx, faces, dt) {
    faces.forEach(function (f) {
      var m = f.mesh, up = m[13], lo = m[14], e = eyeUnits(m), open = Math.hypot(up[0] - lo[0], up[1] - lo[1]) / e.u;
      if (open < 0.16) return;                                                // open your mouth to breathe fire
      var mouth = [(up[0] + lo[0]) / 2, (up[1] + lo[1]) / 2], chin = m[152], dir = [chin[0] - mouth[0], chin[1] - mouth[1]], l = Math.hypot(dir[0], dir[1]) || 1;
      dir = [dir[0] / l, dir[1] / l];
      var n = Math.round(10 + open * 30);
      for (var i = 0; i < n && fire.length < 900; i++) {
        var sp = e.u * (5 + Math.random() * 5) * (0.7 + open), ang = (Math.random() - 0.5) * 0.6, c = Math.cos(ang), s = Math.sin(ang);
        fire.push({ x: mouth[0], y: mouth[1], vx: (dir[0] * c - dir[1] * s) * sp, vy: (dir[0] * s + dir[1] * c) * sp, life: 0, max: 0.55 + Math.random() * 0.45, size: e.u * (0.25 + Math.random() * 0.25) });
      }
    });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    fire = fire.filter(function (p) { return p.life < p.max; });
    fire.forEach(function (p) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.97; p.vy = p.vy * 0.97 - 260 * dt;     // flames rise
      var k = p.life / p.max, stage = Math.min(4, Math.floor(k * 5)), sz = p.size * (1 + k * 2.6);
      ctx.globalAlpha = Math.max(0, (1 - k) * (stage === 4 ? 0.35 : 0.85));
      ctx.drawImage(tintSprite(stage), p.x - sz, p.y - sz, sz * 2, sz * 2);
    });
    ctx.restore();
  }
  function cutout(src, W, H, scale) {                                          // the person, cut out with the mask
    var w = Math.round(W * scale), h = Math.round(H * scale);
    if (cut.width !== w || cut.height !== h) { cut.width = w; cut.height = h; }
    cutCtx.globalCompositeOperation = 'source-over'; cutCtx.clearRect(0, 0, w, h); cutCtx.drawImage(src, 0, 0, w, h);
    cutCtx.globalCompositeOperation = 'destination-in'; cutCtx.drawImage(maskCan, 0, 0, w, h); cutCtx.globalCompositeOperation = 'source-over';
    return cut;
  }
  function cloneLayer(ctx, src, W, H, now) {
    ctx.drawImage(src, 0, 0, W, H);
    if (!mask) return;
    if (now - cloneAt > 120) {                                                // remember where you were, every 120 ms
      cloneAt = now; var c = pool.pop() || document.createElement('canvas'), part = cutout(src, W, H, 0.5);
      c.width = part.width; c.height = part.height; var g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.drawImage(part, 0, 0);
      clones.push({ c: c, t: now, hue: (now / 12) % 360 }); while (clones.length > 7) pool.push(clones.shift().c);
    }
    clones.forEach(function (k, i) {                                       // older copies fainter, each tinted its own colour
      var a = 0.15 + 0.45 * (i + 1) / clones.length;
      if (cut.width !== k.c.width || cut.height !== k.c.height) { cut.width = k.c.width; cut.height = k.c.height; }
      cutCtx.globalCompositeOperation = 'source-over'; cutCtx.clearRect(0, 0, cut.width, cut.height); cutCtx.drawImage(k.c, 0, 0);
      cutCtx.globalCompositeOperation = 'source-atop'; cutCtx.fillStyle = 'hsla(' + k.hue + ',100%,55%,.55)'; cutCtx.fillRect(0, 0, cut.width, cut.height);
      cutCtx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.globalAlpha = a; ctx.drawImage(cut, 0, 0, W, H); ctx.restore();
    });
    ctx.drawImage(cutout(src, W, H, 1), 0, 0, W, H);
  }

  var lastT = 0;
  /* faces: [{ mesh: 468 [x, y, z] points in canvas coordinates }]. Draws the finished picture onto ctx. */
  function render(ctx, src, W, H, faces, effect, now) {
    var dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016; lastT = now;
    faces = faces.filter(function (f) { return f.mesh && f.mesh.length >= 468; });
    if (effect === 'clones') { cloneLayer(ctx, src, W, H, now); return mask ? '' : 'Finding you…'; }
    if (!init()) { ctx.drawImage(src, 0, 0, W, H); return 'This effect needs WebGL 2, which this browser does not offer.'; }
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFrame); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    var hasMask = !!(mask && SEG[effect]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texMask);
    if (hasMask && maskFresh) { gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskW, maskH, 0, gl.RED, gl.UNSIGNED_BYTE, mask); maskFresh = false; }
    var P = progBG, u = P.u; gl.useProgram(P.p);
    gl.uniform1i(u.uTex, 0); gl.uniform1i(u.uMask, 1); gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uTime, now / 1000);
    gl.uniform1i(u.uMode, MODE[effect] || 0); gl.uniform1i(u.uHasMask, hasMask ? 1 : 0);
    var eyes = new Float32Array(16), fd = new Float32Array(16), n = Math.min(4, faces.length);
    for (var i = 0; i < n; i++) { var e = eyeUnits(faces[i].mesh); eyes.set([e.a[0], e.a[1], e.b[0], e.b[1]], i * 4); fd.set([0, 0, e.u, 0], i * 4); }
    gl.uniform1i(u.uN, n); gl.uniform4fv(u.uEye, eyes); gl.uniform4fv(u.uFace, fd);
    var loc = gl.getAttribLocation(P.p, 'a'); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(loc);
    if (MESH[effect] && n) {
      var M = progMesh; gl.useProgram(M.p); gl.uniform2f(M.u.uRes, W, H); gl.uniform1f(M.u.uTime, now / 1000); gl.uniform1i(M.u.uMode, MESH[effect]);
      gl.enable(gl.BLEND);
      if (effect === 'alpona') gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE);   // paint covers, light adds
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
      var names = [['aP', 2, 0], ['aU', 2, 2], ['aB', 3, 4], ['aR', 1, 7]], locs = names.map(function (a) { return gl.getAttribLocation(M.p, a[0]); });
      faces.slice(0, 4).forEach(function (f) {
        gl.bufferData(gl.ARRAY_BUFFER, meshVerts(f.mesh), gl.DYNAMIC_DRAW);
        names.forEach(function (a, j) { if (locs[j] < 0) return; gl.enableVertexAttribArray(locs[j]); gl.vertexAttribPointer(locs[j], a[1], gl.FLOAT, false, 32, a[2] * 4); });
        gl.drawArrays(gl.TRIANGLES, 0, TRI.length);
      });
      locs.forEach(function (l) { if (l >= 0) gl.disableVertexAttribArray(l); });
      gl.disable(gl.BLEND);
    }
    ctx.drawImage(cv, 0, 0, W, H);
    if (effect === 'fire') { fireLayer(ctx, faces, dt); if (faces.length && !fire.length) return 'Open your mouth wide to breathe fire.'; }
    if (SEG[effect] && !mask) return 'Finding you…';
    return '';
  }
  /* The person mask from segmentation: one byte per pixel, top row first, already in the picture's orientation. */
  function setMask(data, w, h) {
    if (!mask || mask.length !== data.length) { mask = new Uint8Array(data.length); for (var i = 0; i < data.length; i++) mask[i] = data[i]; }
    else for (var j = 0; j < data.length; j++) mask[j] = (mask[j] * 0.35 + data[j] * 0.65) | 0;   // a little smoothing over time: no flicker at the edges
    maskW = w; maskH = h; maskFresh = true;
    if (maskCan.width !== w || maskCan.height !== h) { maskCan.width = w; maskCan.height = h; }
    var img = maskCtx.createImageData(w, h); for (var k = 0; k < w * h; k++) { img.data[k * 4 + 3] = mask[k]; }
    maskCtx.putImageData(img, 0, 0);
  }
  function clearMask() { mask = null; clones.forEach(function (c) { pool.push(c.c); }); clones = []; }
  window.FaceFX2 = { list: LIST, has: function (e) { return MODE.hasOwnProperty(e) && e !== 'none'; }, needsSeg: function (e) { return !!SEG[e]; }, render: render, setMask: setMask, clearMask: clearMask, supported: function () { return init(); } };
})();
