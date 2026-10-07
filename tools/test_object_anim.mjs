// Object animation checks, in Node (no GPU): node tools/test_object_anim.mjs
// 1. Shots that don't animate objects evaluate exactly as before (every frame of Black Page against the spike's
//    evaluate at commit 65b061b, read from git).
// 2. Keys, typed values, parenting, constraints, behaviours and clips do what the document says, purely in t.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { evaluate, indexDoc } from '../src/core/evaluate.js';
import { createCommandStack, COMMANDS } from '../src/core/commands.js';
import { xf, nrm, sub, dot, M4, quatFromEuler, eulerFromQuat, decompose, invAffine, trsOf } from '../src/core/vec.js';

let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) passes++; else { fails++; console.log('FAIL', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const nearV = (a, b, e = 1e-6) => a.every((v, i) => near(v, b[i], e));
const load = () => JSON.parse(fs.readFileSync(new URL('../scenes/black_page.scene.json', import.meta.url)));
// geometry the renderer would derive from the assets (stand-in values; both evaluates get the same)
const geo = { centres: { monitor: [0, 0.2, 0], desk: [0, -0.5, 0.1], keyboard: [0, 0, 0.34], pad: [0.4, 0, 0.35], wii: [0.38, 0.03, 0.33] },
  local: { monitor: [0, 0.2, 0], desk: [0, 0.47, -0.03], keyboard: [0.05, 0, 0], pad: [0, 0, 0], wii: [0, 0.01, 0] }, wiiId: 'wii',
  wii: { M: Array.from(trsOf(load().objects.find(o => o.id === 'wii').transform)), ctr: [0.38, 0.03, 0.33], up: [0, 1, 0], leds: [[0.01, 0.02, 0.03], [0.02, 0.02, 0.03]] }, clips: {} };

// ---- 1. parity with the previous evaluate
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-old-'));
  for (const f of ['evaluate.js', 'tracks.js', 'curves.js', 'vec.js']) fs.writeFileSync(path.join(tmp, f), execSync(`git show 65b061b:src/core/${f}`));
  const old = await import('file:///' + path.join(tmp, 'evaluate.js').replace(/\\/g, '/'));
  const doc = load(), ix = indexDoc(doc), oix = old.indexDoc(doc); let diff = 0;
  for (let f = 0; f < Math.round(doc.duration * doc.fps); f++) {
    const a = evaluate(doc, f / doc.fps, geo, ix), b = old.evaluate(doc, f / doc.fps, geo, oix);
    ok(Object.keys(a.objects).length === 0, 'no animated objects in Black Page'); delete a.objects;
    if (JSON.stringify(a) !== JSON.stringify(b)) diff++;
  }
  ok(diff === 0, `evaluate differs from 65b061b on ${diff} frames`);
  fs.rmSync(tmp, { recursive: true });
}

// ---- 2. features
const mk = () => { const doc = load(); const cmd = createCommandStack(() => doc, () => {}); return { doc, cmd, ev: t => evaluate(doc, t, geo) }; };
const pos = (st, id) => st.objects[id].matrix.slice(12, 15);
const axis = (st, id, c) => nrm(st.objects[id].matrix.slice(c * 4, c * 4 + 3));

{ // keys on transform components; unkeyed components keep the document's values
  const { doc, cmd, ev } = mk(), p0 = doc.objects.find(o => o.id === 'pad').transform.position;
  cmd.run('setKey', { target: 'pad', prop: 'position.x', t: 1, v: 0, curve: 'linear' }).run('setKey', { target: 'pad', prop: 'position.x', t: 3, v: 1, curve: 'linear' });
  ok(nearV(pos(ev(2), 'pad'), [0.5, p0[1], p0[2]]), 'position.x linear midpoint');
  ok(nearV(pos(ev(0), 'pad'), [0, p0[1], p0[2]]) && nearV(pos(ev(9), 'pad'), [1, p0[1], p0[2]]), 'holds outside keys');
  cmd.run('setKey', { target: 'pad', prop: 'rotation.y', t: 0, v: 0 }).run('setKey', { target: 'pad', prop: 'rotation.y', t: 1, v: 90, curve: 'linear' });
  ok(nearV(axis(ev(1), 'pad', 2), [1, 0, 0]), 'rotation.y 90° turns +Z to +X');
  cmd.undo(); cmd.undo(); cmd.undo(); cmd.undo();
  ok(!doc.tracks.some(t => t.target === 'pad') && Object.keys(ev(1).objects).length === 0, 'undo removes the animation');
  // the stopwatch off writes the value at t back to the transform record
  cmd.run('setAnimated', { target: 'pad', prop: 'position.y', t: 0, v: 0.25, on: true }).run('setAnimated', { target: 'pad', prop: 'position.y', t: 0, v: 0.5, on: false });
  ok(doc.objects.find(o => o.id === 'pad').transform.position[1] === 0.5 && !doc.tracks.some(t => t.target === 'pad'), 'stopwatch off keeps the value statically');
}
{ // euler <-> quaternion round trip (the inspector's XYZ order)
  let worst = 0; for (let i = 0; i < 200; i++) { const e = [Math.random() * 170 - 85, Math.random() * 170 - 85, Math.random() * 340 - 170];
    worst = Math.max(worst, ...eulerFromQuat(quatFromEuler(e)).map((v, k) => Math.abs(v - e[k]))); }
  ok(worst < 1e-9, `euler round trip ${worst}`);
}
{ // typed values: visibility steps, colours blend
  const { cmd, ev } = mk();
  cmd.run('setKey', { target: 'keyboard', prop: 'visible', t: 0, v: true }).run('setKey', { target: 'keyboard', prop: 'visible', t: 2, v: false });
  ok(ev(1.99).objects.keyboard.visible === true && ev(2).objects.keyboard.visible === false, 'visible holds until the next key');
  cmd.run('setKey', { target: 'led', prop: 'color', t: 0, v: '#000000' }).run('setKey', { target: 'led', prop: 'color', t: 1, v: '#ff8040', curve: 'linear' });
  ok(ev(0.5).objects.led.props.color === '#804020', 'colour blends: ' + ev(0.5).objects.led.props.color);
  ok(nearV(ev(0.5).led.color, [128 / 255, 32 / 255, 64 / 255].slice(0, 3).map((v, i) => [128, 64, 32][i] / 255)), 'evaluate reads the keyed LED colour');
  cmd.run('setKey', { target: 'wii', prop: 'ring.intensity', t: 10, v: 0 }).run('setKey', { target: 'wii', prop: 'ring.intensity', t: 11, v: 6, curve: 'linear' });
  ok(ev(10.5).objects.wii.props['ring.intensity'] === 3, 'ring intensity keyed');
}
{ // parenting: the child follows its parent; setParent keeps the world transform
  const { doc, cmd, ev } = mk();
  const w0 = Array.from(trsOf(doc.objects.find(o => o.id === 'wii').transform));
  cmd.run('setParent', { id: 'wii', parent: 'pad' });
  ok(nearV(ev(0).objects.wii.matrix, w0, 1e-6), 'setParent keeps the world transform');
  cmd.run('setKey', { target: 'pad', prop: 'position.y', t: 0, v: 0 }).run('setKey', { target: 'pad', prop: 'position.y', t: 1, v: 0.1, curve: 'linear' });
  ok(near(pos(ev(1), 'wii')[1] - pos(ev(0), 'wii')[1], 0.1), 'child rises with its parent');
  // the focus target and the ringing LEDs follow the remote
  const st = ev(1); ok(nearV(st.objects.wii.matrix.slice(12, 15).map((v, i) => v), pos(st, 'wii')) && near(st.ring === null ? 0 : 1, 0), 'ring is off before 9.8 s');
  const st2 = ev(12); ok(st2.ring && near(st2.ring.leds[0][1] - evaluate(load(), 12, geo).ring.leds[0][1], 0.1 - load().objects.find(o => o.id === 'pad').transform.position[1], 1e-3), 'ring LEDs move with the parent');
  cmd.run('setParent', { id: 'wii', parent: null }); ok(nearV(ev(0).objects.pad.matrix, ev(0).objects.pad.matrix) && !doc.objects.find(o => o.id === 'wii').parent, 'unparent');
  let threw = false; try { cmd.run('setParent', { id: 'pad', parent: 'pad' }); } catch { threw = true; } ok(threw, 'no self-parenting');
}
{ // lookAt and attach
  const { doc, cmd, ev } = mk();
  cmd.run('addEmpty', { id: 'aim', transform: { position: [1, 0.5, 2] } });
  const a = { id: 'pad', constraint: { type: 'lookAt', target: 'aim' } }; cmd.run('addConstraint', a);
  const st = ev(0), p = pos(st, 'pad'); ok(nearV(axis(st, 'pad', 2), nrm(sub([1, 0.5, 2], p))), 'lookAt points +Z at the target');
  cmd.run('setConstraint', { id: 'pad', cid: a.cid, patch: { axis: '-z' } }); ok(nearV(axis(ev(0), 'pad', 2), nrm(sub(p, [1, 0.5, 2]))), 'lookAt with -Z');
  cmd.run('removeConstraint', { id: 'pad', cid: a.cid });
  // pick up: attach the remote to the hand empty from 2 s (influence hold keys)
  cmd.run('addEmpty', { id: 'hand', transform: { position: [0, 1, 0] } });
  const b = { id: 'wii', constraint: { type: 'attach', target: 'hand' } }; cmd.run('addConstraint', b);
  cmd.run('setKey', { target: 'wii', prop: `constraints.${b.cid}.influence`, t: 0, v: 0 }).run('setKey', { target: 'wii', prop: `constraints.${b.cid}.influence`, t: 2, v: 1, curve: 'hold' });
  cmd.run('setKey', { target: 'hand', prop: 'position.x', t: 2, v: 0 }).run('setKey', { target: 'hand', prop: 'position.x', t: 4, v: 1, curve: 'linear' });
  ok(nearV(pos(ev(1), 'wii'), doc.objects.find(o => o.id === 'wii').transform.position), 'before the attach the remote stays');
  ok(nearV(pos(ev(3), 'wii'), [0.5, 1, 0]), 'attached, it rides the hand');
  cmd.run('removeConstraint', { id: 'wii', cid: b.cid }); ok(!doc.tracks.some(t => t.prop.startsWith('constraints.')), 'removing a constraint drops its tracks');
}
{ // follow path by arc length
  const { cmd, ev } = mk();
  cmd.run('addPath', { id: 'rail', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], transform: { position: [0, 1, 0] } });
  const a = { id: 'pad', constraint: { type: 'followPath', path: 'rail' } }; cmd.run('addConstraint', a);
  cmd.run('setKey', { target: 'pad', prop: `constraints.${a.cid}.u`, t: 0, v: 0 }).run('setKey', { target: 'pad', prop: `constraints.${a.cid}.u`, t: 1, v: 1, curve: 'linear' });
  ok(nearV(pos(ev(0), 'pad'), [0, 1, 0]) && nearV(pos(ev(1), 'pad'), [3, 1, 0]) && nearV(pos(ev(0.5), 'pad'), [1.5, 1, 0], 1e-4), 'follows the rail by arc length');
  ok(nearV(axis(ev(0.5), 'pad', 2), [1, 0, 0], 1e-6), 'faces along the rail');
}
{ // behaviours: deterministic, bounded, seeded by stable ids, parameters keyable
  const { doc, cmd, ev } = mk();
  const a = { id: 'wii', type: 'shake', params: { amp: 0.01, rot: 0 } }; cmd.run('addBehaviour', a);
  const base = doc.objects.find(o => o.id === 'wii').transform.position;
  let worst = 0, moved = 0; for (let f = 0; f < 600; f++) { const d = sub(pos(ev(f / 60), 'wii'), base); worst = Math.max(worst, ...d.map(Math.abs)); moved += Math.hypot(...d) > 1e-4; }
  ok(worst <= 0.0101 && moved > 500, `shake stays within amp (${worst.toFixed(4)}), moves on ${moved}/600 frames`);
  ok(JSON.stringify(ev(3.21).objects) === JSON.stringify(ev(3.21).objects), 'pure in t');
  const b = { id: 'pad', type: 'shake', params: { amp: 0.01, rot: 0 } }; cmd.run('addBehaviour', b);
  ok(!nearV(sub(pos(ev(1), 'wii'), base), sub(pos(ev(1), 'pad'), doc.objects.find(o => o.id === 'pad').transform.position), 1e-5), 'different objects shake differently');
  cmd.run('setKey', { target: 'wii', prop: `behaviours.${a.bid}.weight`, t: 0, v: 0 });
  ok(nearV(pos(ev(1), 'wii'), base), 'weight 0 switches it off');
  cmd.run('removeBehaviour', { id: 'wii', bid: a.bid });
  const s = { id: 'pad', type: 'spin', params: { rpm: 60 } }; cmd.run('removeBehaviour', { id: 'pad', bid: b.bid }); cmd.run('addBehaviour', s);
  const q0 = decompose(ev(0).objects.pad.matrix).quaternion, q1 = decompose(ev(0.25).objects.pad.matrix).quaternion;
  ok(near(Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]), Math.cos(Math.PI / 4), 1e-9), 'spin: 60 rpm turns 90° in 0.25 s');
  const f = { id: 'wii', type: 'flicker', params: { rate: 10, depth: 0.5, dropout: 0 } }; cmd.run('addBehaviour', f);
  const em = [0, 0.05, 0.1, 0.15, 0.2].map(t => ev(t).objects.wii.props.emission);
  ok(em[0] === em[1] && em[1] !== em[2] && em.every(v => v >= 0.75 && v <= 1.5), 'flicker steps emission at its rate: ' + em.map(v => v.toFixed(3)));
  const bob = { id: 'keyboard', type: 'bob', params: { amp: 0.02, freq: 1 } }; cmd.run('addBehaviour', bob);
  const k0 = doc.objects.find(o => o.id === 'keyboard').transform.position[1]; ok(near(pos(ev(0.25), 'keyboard')[1] - k0, 0.02), 'bob peaks at a quarter cycle');
}
{ // glTF clips: looping, once, ping-pong, fade-in layering
  const { cmd, ev } = mk(); geo.clips.wii = { Wave: 2, Idle: 1 };
  cmd.run('addClip', { id: 'wii', clip: { name: 'Idle', start: 0 } });
  ok(near(ev(2.5).objects.wii.clips[0].time, 0.5), 'repeat wraps');
  const k = { id: 'wii', clip: { name: 'Wave', start: 3, loop: 'once', fadeIn: 0.5 } }; cmd.run('addClip', k);
  const c = ev(3.25).objects.wii.clips; ok(c.length === 2 && near(c[0].weight, 0.5) && near(c[1].weight, 0.5) && c[0].name === 'Wave', 'fade-in blends over the earlier clip');
  ok(ev(4).objects.wii.clips.length === 1 && near(ev(9).objects.wii.clips[0].time, 2), 'once holds its last frame');
  cmd.run('setClip', { id: 'wii', kid: k.kid, patch: { loop: 'pingpong' } }); ok(near(ev(3 + 3).objects.wii.clips[0].time, 1), 'ping-pong');
  ok(ev(0).objects.wii.clips[0].name === 'Idle', 'before the second clip starts, the first plays');
  delete geo.clips.wii;
}
{ // a dependency cycle is an error, not a hang
  const { doc } = mk(); doc.objects.find(o => o.id === 'pad').parent = 'wii'; doc.objects.find(o => o.id === 'wii').parent = 'pad';
  let msg = ''; try { indexDoc(doc); } catch (e) { msg = e.message; } ok(/cycle/.test(msg), 'cycle detected');
}
{ // inverse and decompose
  const m = M4.mul(M4.trs([1, 2, 3], quatFromEuler([10, 20, 30]), [1, 2, 0.5]), M4.trs([0.3, -1, 2]));
  ok(nearV(Array.from(M4.mul(m, invAffine(m))), Array.from(M4.id()), 1e-12), 'invAffine');
  const d = decompose(M4.trs([1, 2, 3], quatFromEuler([10, 20, 30]), [1, 2, 0.5])); ok(nearV(d.scale, [1, 2, 0.5]) && nearV(eulerFromQuat(d.quaternion), [10, 20, 30], 1e-9), 'decompose');
}
console.log(`${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
