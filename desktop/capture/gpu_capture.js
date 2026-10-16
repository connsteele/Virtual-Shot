// WebGPU capture for the native replay (desktop/replay): records every WebGPU call the page makes (resources, shader
// code, pipelines, uploads, passes, submits) with its data, so desktop/replay can run exactly the same GPU work through
// wgpu natively. Injected before the page loads (drive.mjs INJECT=...); nothing in the app changes.
//   GPUCAP.note(text)        a marker in the log (frame and pass names)
//   await GPUCAP.dump(name)  POSTs <name>.json (ops) and <name>.bin (data) to /save/rust_tauri/capture/
(() => {
  const C = window.GPUCAP = { ops: [], chunks: [], bytes: 0, next: 1, ids: new WeakMap(), mappedAtCreation: new WeakSet(), mapped: new WeakMap(), writeMaps: new WeakSet() };
  const GPU_TYPES = ['GPUBuffer', 'GPUTexture', 'GPUTextureView', 'GPUSampler', 'GPUBindGroupLayout', 'GPUPipelineLayout', 'GPUShaderModule',
    'GPURenderPipeline', 'GPUComputePipeline', 'GPUBindGroup', 'GPUQuerySet', 'GPUCommandBuffer', 'GPURenderBundle', 'GPUCommandEncoder',
    'GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder', 'GPUQueue', 'GPUDevice', 'GPUExternalTexture'];
  const isGpu = v => v && typeof v === 'object' && GPU_TYPES.some(t => window[t] && v instanceof window[t]);
  const id = o => { if (!o || typeof o !== 'object') return null; let i = C.ids.get(o); if (!i) { i = C.next++; C.ids.set(o, i); } return i; };
  // data is stored once: a repeated upload (an unchanged chat canvas, the same uniforms) points at the earlier copy
  const seen = new Map();
  const hash = u8 => { let h = 2166136261 >>> 0; const n = u8.byteLength, w = new Uint32Array(u8.buffer, u8.byteOffset, n >> 2);
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619) >>> 0; for (let i = w.length * 4; i < n; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0; return `${h}:${n}`; };
  const blob = u8 => { const copy = new Uint8Array(u8); const k = hash(copy), prev = seen.get(k); if (prev !== undefined) return { $blob: prev, n: copy.byteLength };
    const off = C.bytes; C.chunks.push(copy); C.bytes += copy.byteLength; seen.set(k, off); return { $blob: off, n: copy.byteLength }; };
  const pixels = src => {   // any image source -> RGBA8 (straight alpha), via a 2D canvas
    const w = src.width ?? src.displayWidth ?? src.videoWidth, h = src.height ?? src.displayHeight ?? src.videoHeight;
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0);
    return { $image: blob(new Uint8Array(x.getImageData(0, 0, w, h).data.buffer)), w, h };
  };
  const ser = v => {
    if (v == null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (isGpu(v)) return { $: id(v) };
    if (v instanceof ArrayBuffer) return blob(new Uint8Array(v));
    if (ArrayBuffer.isView(v)) {
      if (v.byteLength <= 256 && !(v instanceof DataView)) return { $arr: Array.from(v), type: v.constructor.name };
      return { ...blob(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), bpe: v.BYTES_PER_ELEMENT || 1 };
    }
    if ((window.HTMLCanvasElement && v instanceof HTMLCanvasElement) || (window.OffscreenCanvas && v instanceof OffscreenCanvas) ||
        (window.ImageBitmap && v instanceof ImageBitmap) || (window.HTMLImageElement && v instanceof HTMLImageElement) || (window.ImageData && v instanceof ImageData)) return pixels(v);
    if (Array.isArray(v)) return v.map(ser);
    if (v instanceof Set || v instanceof Map) return [...v].map(ser);
    const o = {}; for (const k in v) { const s = ser(v[k]); if (s !== undefined) o[k] = s; } return o;
  };
  const rec = (t, self, args, r) => { C.ops.push({ t, s: self ? id(self) : null, a: ser(args), r: r && typeof r === 'object' ? id(r) : undefined }); };
  const wrap = (cls, name, opts = {}) => {
    const P = window[cls]?.prototype; if (!P || !P[name]) return; const orig = P[name];
    P[name] = function (...args) {
      if (opts.async) { const placeholder = C.next++; rec(`${cls}.${name}`, this, args, null); C.ops[C.ops.length - 1].r = placeholder;
        return orig.apply(this, args).then(obj => { C.ids.set(obj, placeholder); return obj; }); }
      const r = orig.apply(this, args);
      if (opts.pre) opts.pre.call(this, args, r);
      if (!opts.skip) rec(`${cls}.${name}`, this, args, r);
      return r;
    };
  };
  // device: resources and pipelines
  for (const m of ['createBuffer', 'createTexture', 'createSampler', 'createShaderModule', 'createBindGroupLayout', 'createPipelineLayout', 'createBindGroup',
    'createRenderPipeline', 'createComputePipeline', 'createCommandEncoder', 'createQuerySet', 'createRenderBundleEncoder']) wrap('GPUDevice', m,
    m === 'createBuffer' ? { pre(args, r) { if (args[0]?.mappedAtCreation) C.mappedAtCreation.add(r); } } : {});
  wrap('GPUDevice', 'createRenderPipelineAsync', { async: true }); wrap('GPUDevice', 'createComputePipelineAsync', { async: true });
  for (const m of ['submit', 'writeBuffer', 'writeTexture', 'copyExternalImageToTexture']) wrap('GPUQueue', m);
  wrap('GPUTexture', 'createView'); wrap('GPUTexture', 'destroy'); wrap('GPUBuffer', 'destroy');
  wrap('GPURenderPipeline', 'getBindGroupLayout'); wrap('GPUComputePipeline', 'getBindGroupLayout');
  // buffers written through mapping: record the bytes when unmapped
  { const P = GPUBuffer.prototype, gmr = P.getMappedRange, um = P.unmap, ma = P.mapAsync;
    P.mapAsync = function (mode, ...rest) { if (mode & GPUMapMode.WRITE) C.writeMaps.add(this); else C.writeMaps.delete(this); return ma.call(this, mode, ...rest); };
    P.getMappedRange = function (offset = 0, size) { const ab = gmr.call(this, offset, size); const l = C.mapped.get(this) || []; l.push({ offset, ab }); C.mapped.set(this, l); return ab; };
    P.unmap = function () { if (C.mappedAtCreation.has(this) || C.writeMaps.has(this)) for (const { offset, ab } of C.mapped.get(this) || [])
        C.ops.push({ t: 'mappedWrite', s: id(this), a: [offset, blob(new Uint8Array(ab))] });
      C.mapped.delete(this); C.mappedAtCreation.delete(this); C.writeMaps.delete(this); return um.call(this); }; }
  for (const m of ['beginRenderPass', 'beginComputePass', 'copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer', 'resolveQuerySet', 'finish'])
    wrap('GPUCommandEncoder', m);
  for (const m of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'setViewport',
    'setScissorRect', 'setBlendConstant', 'setStencilReference', 'executeBundles', 'beginOcclusionQuery', 'endOcclusionQuery', 'end']) wrap('GPURenderPassEncoder', m);
  for (const m of ['setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'end']) wrap('GPUComputePassEncoder', m);
  for (const m of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed', 'finish']) wrap('GPURenderBundleEncoder', m);
  // the canvas: its configuration and the texture handed out each frame
  { const P = GPUCanvasContext.prototype, cfg = P.configure, gct = P.getCurrentTexture;
    P.configure = function (d) { this.__cfg = d; C.ops.push({ t: 'canvas.configure', a: { format: d.format, alphaMode: d.alphaMode, usage: d.usage, w: this.canvas.width, h: this.canvas.height } }); return cfg.call(this, d); };
    P.getCurrentTexture = function () { const t = gct.call(this); C.ops.push({ t: 'canvas.texture', r: id(t), a: { w: t.width, h: t.height, format: t.format, usage: t.usage } }); return t; }; }
  // the device's features, so the replay asks for the same
  { const P = GPUAdapter.prototype, rd = P.requestDevice;
    P.requestDevice = async function (d = {}) { const dev = await rd.call(this, d);
      C.ops.push({ t: 'device', a: { features: [...(d.requiredFeatures || [])], limits: d.requiredLimits || {} }, r: id(dev) }); id(dev.queue); return dev; }; }
  C.note = text => C.ops.push({ t: 'note', a: text });
  C.dump = async (name, dir = 'rust_tauri/capture') => {
    const total = new Uint8Array(C.bytes); let o = 0; for (const c of C.chunks) { total.set(c, o); o += c.byteLength; }
    const post = (p, body) => fetch('/save/' + p, { method: 'POST', body }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); });
    await post(`${dir}/${name}.bin`, new Blob([total]));
    await post(`${dir}/${name}.json`, new Blob([JSON.stringify({ version: 1, ua: navigator.userAgent, ops: C.ops })]));
    return { ops: C.ops.length, mb: Math.round(C.bytes / 1e5) / 10 };
  };
})();
