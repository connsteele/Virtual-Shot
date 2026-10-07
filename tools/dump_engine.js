/* Run inside the Black Page engine page (bp/final/test.html, engine v4.8.1) after BP.ready().
   Dumps everything the engine places in code (prop transforms, glass frame, LED, polaroid, Wii model) so the
   importer can write it into the scene document as plain data. Returns the dump object. */
(async () => {
  await BP.ready();
  const inv = m => { // general 4x4 inverse, column-major
    const a = Array.from(m), o = new Array(16);
    const [a00,a01,a02,a03,a10,a11,a12,a13,a20,a21,a22,a23,a30,a31,a32,a33] = a;
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,
      b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    const d = 1/(b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06);
    o[0]=(a11*b11-a12*b10+a13*b09)*d; o[1]=(a02*b10-a01*b11-a03*b09)*d; o[2]=(a31*b05-a32*b04+a33*b03)*d; o[3]=(a22*b04-a21*b05-a23*b03)*d;
    o[4]=(a12*b08-a10*b11-a13*b07)*d; o[5]=(a00*b11-a02*b08+a03*b07)*d; o[6]=(a32*b02-a30*b05-a33*b01)*d; o[7]=(a20*b05-a22*b02+a23*b01)*d;
    o[8]=(a10*b10-a11*b08+a13*b06)*d; o[9]=(a01*b08-a00*b10-a03*b06)*d; o[10]=(a30*b04-a31*b02+a33*b00)*d; o[11]=(a21*b02-a20*b04-a23*b00)*d;
    o[12]=(a11*b07-a10*b09-a12*b06)*d; o[13]=(a00*b09-a01*b07+a02*b06)*d; o[14]=(a31*b01-a30*b03-a32*b00)*d; o[15]=(a20*b03-a21*b01+a22*b00)*d;
    return o;
  };
  const parts = G3.parts.map((p, i) => ({ i, group: p.group || null, name: p.name || null, isScreen: !!p.isScreen, wii: !!p.wii, led: !!p.led,
    hasTex: !!p.tex, hasEm: !!p.emTex, count: p.count, wm: Array.from(p.wm), lwm: p.lwm ? Array.from(p.lwm) : null,
    placement: p.lwm ? M4.mul(p.wm, new Float32Array(inv(p.lwm))) : null }));
  // polaroid + tape matrices, exactly as render3D builds them (export_frame.js polaroid())
  const scr = G3.scr, PL = S.polaroid, W_ = scr.glassW, a = (PL.rot || 0) * Math.PI / 180;
  const rr = add(scl(scr.r, Math.cos(a)), scl(scr.u, Math.sin(a))), uu = add(scl(scr.r, -Math.sin(a)), scl(scr.u, Math.cos(a)));
  const ctr = add(scr.ctr, add(scl(scr.r, (PL.x || 0) * W_), scl(scr.u, (PL.y || 0) * W_))), pw = (PL.width || 0.25) * W_, ph = pw * 156 / 128;
  const tapeAt = add(ctr, scl(uu, ph * 0.5)); let dep = bezelDepth(tapeAt); if (dep === null) dep = bezelDepth(ctr); if (dep === null) dep = W_ * 0.06;
  const frame = (c, x, y, w, h, lift) => { const o = add(c, scl(scr.n, dep + lift)); return [...scl(x, w), 0, ...scl(y, h), 0, ...scr.n, 0, ...o, 1]; };
  const ta = a + ((PL.tapeRot !== undefined ? PL.tapeRot : 8) * Math.PI / 180), tr = add(scl(scr.r, Math.cos(ta)), scl(scr.u, Math.sin(ta))), tu = add(scl(scr.r, -Math.sin(ta)), scl(scr.u, Math.cos(ta)));
  const wm = G3.wiiModel;
  return {
    engine: document.querySelector('.label').textContent,
    scr: { ctr: scr.ctr, n: scr.n, r: scr.r, u: scr.u, glassW: scr.glassW, glassH: scr.glassH, ub: scr.ub, pts: scr.pts, w: scr.w },
    bodyCtr: G3.bodyCtr, size: G3.size, scene: G3.scene, led: G3.led, LED_UV, LED_RECT,
    TEX, GEO: JSON.parse(JSON.stringify(GEO)),
    wiiModel: wm ? { M: Array.from(wm.M), ctr: wm.ctr, up: wm.up, mn: wm.mn, mx: wm.mx, leds: wm.leds.map(q => ({ name: q.name, c0: q.c0 })) } : null,
    polaroid: { polaroid: frame(ctr, rr, uu, pw, ph, W_ * 0.002), tape: frame(tapeAt, tr, tu, pw * 0.3, pw * 0.48, W_ * 0.003), dep },
    ghostRects: G3.ghost ? G3.ghost.rects : null,
    parts,
  };
})()
