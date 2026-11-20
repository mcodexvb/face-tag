/* SCRFD fixed 640x640, three strides, two anchors, post-sigmoid scores.
 * Runtime and weights are deliberately local; see SCRFD.md. */
(function () {
  'use strict';
  const size = 640, strides = [8,16,32], canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  let session, pending, backend, runtime, modelBytes;
  async function init() {
    if (session) return session;
    if (!pending) pending = (async () => {
      runtime = await import('./lib/ort.webgpu.min.mjs');
      runtime.env.wasm.wasmPaths = new URL('./lib/', document.baseURI).href;
      runtime.env.wasm.numThreads = 1;
      const response = await fetch('./models/scrfd_500m.onnx');
      if (!response.ok) throw Error('SCRFD model HTTP ' + response.status);
      modelBytes = await response.arrayBuffer();
      for (const ep of (navigator.gpu ? ['webgpu','wasm'] : ['wasm'])) {
        try {
          session = await runtime.InferenceSession.create(modelBytes, {executionProviders:[ep]});
          backend = ep; return session;
        } catch (e) { if (ep === 'wasm') throw e; }
      }
    })().catch(e => { pending = null; throw e; });
    return pending;
  }
  function overlap(a,b) {
    const i = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) *
      Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
    return i / ((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i || 1);
  }
  function decode(outputs,w,h,sx,sy,limit,threshold) {
    const tensors = Object.values(outputs), candidates = [];
    for (const stride of strides) {
      const grid = size/stride, n = grid*grid*2;
      const scores = tensors.filter(t=>t.data.length===n);
      const boxes = tensors.filter(t=>t.data.length===n*4);
      // At adjacent scales these lengths can collide. Use trailing feature dimension.
      const score = scores.find(t=>t.dims[t.dims.length-1]===1) || (scores.length===1 ? scores[0] : null);
      const box = boxes.find(t=>t.dims[t.dims.length-1]===4);
      if (!score || !box) throw Error('Unsupported SCRFD output layout at stride '+stride);
      for (let i=0;i<n;i++) {
        const p=score.data[i]; if (!Number.isFinite(p) || p<threshold || p>1) continue;
        const cell=Math.floor(i/2), x=(cell%grid)*stride, y=Math.floor(cell/grid)*stride;
        const k=i*4, b=box.data;
        const rect=[Math.max(0,(x-b[k]*stride)/sx),Math.max(0,(y-b[k+1]*stride)/sy),
          Math.min(w,(x+b[k+2]*stride)/sx),Math.min(h,(y+b[k+3]*stride)/sy)];
        if (rect.every(Number.isFinite) && rect[2]>rect[0] && rect[3]>rect[1]) candidates.push({rect,p});
      }
    }
    candidates.sort((a,b)=>b.p-a.p);
    const kept=[];
    for (const c of candidates) {
      if (kept.some(k=>overlap(k.rect,c.rect)>0.4)) continue;
      kept.push(c); if (kept.length>=limit) break;
    }
    return kept.map(({rect:r,p})=>({box:[r[0],r[1],r[2]-r[0],r[3]-r[1]],boxScore:p,score:p}));
  }
  async function detect(source,{limit=12,threshold=0.35}={}) {
    await init();
    const w=source.videoWidth||source.naturalWidth||source.width, h=source.videoHeight||source.naturalHeight||source.height;
    if (!w||!h) throw Error('Empty frame');
    const ratio=Math.min(size/w,size/h), rw=Math.max(1,Math.round(w*ratio)), rh=Math.max(1,Math.round(h*ratio));
    ctx.fillStyle='#000'; ctx.fillRect(0,0,size,size); ctx.drawImage(source,0,0,rw,rh);
    const pixels=ctx.getImageData(0,0,size,size).data, plane=size*size, data=new Float32Array(plane*3);
    for(let i=0;i<plane;i++) for(let c=0;c<3;c++) data[c*plane+i]=(pixels[i*4+c]-127.5)/128;
    const input=new runtime.Tensor('float32',data,[1,3,size,size]);
    let outputs;
    try {
      try { outputs=await session.run({[session.inputNames[0]]:input}); }
      catch(e) {
        if(backend!=='webgpu') throw e;
        await session.release(); session=null; pending=null;
        session=await runtime.InferenceSession.create(modelBytes,{executionProviders:['wasm']});
        backend='wasm'; outputs=await session.run({[session.inputNames[0]]:input});
      }
      return {face:decode(outputs,w,h,rw/w,rh/h,limit,threshold)};
    } finally { input.dispose(); if(outputs) Object.values(outputs).forEach(t=>t.dispose()); }
  }
  window.SCRFD = {detect, decode, get backend(){return backend;}};
})();
