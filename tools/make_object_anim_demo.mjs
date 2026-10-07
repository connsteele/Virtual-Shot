// Builds scenes/object_anim_demo.scene.json: Black Page plus a test of every object-animation feature, made only with
// the editor's commands (so it is also a script of what an MCP client would send). The Black Page scene is untouched.
//   node tools/make_object_anim_demo.mjs        then /src/editor/index.html?scene=/scenes/object_anim_demo.scene.json
import fs from 'node:fs';
import { createCommandStack } from '../src/core/commands.js';

const doc = JSON.parse(fs.readFileSync(new URL('../scenes/black_page.scene.json', import.meta.url)));
doc.name = 'Black Page · object animation demo';
const cmd = createCommandStack(() => doc, () => {}), run = (n, a) => { cmd.run(n, a); return a; };

// a prop with baked glTF clips (tools/make_test_clip_glb.mjs): hops on the desk, then spins from 11 s
doc.assets.cube = 'repo:data/test/anim_cube.glb';
doc.objects.push({ id: 'cube', name: 'Test cube (glTF clips)', type: 'model', asset: 'cube', transform: { position: [-0.24, 0, 0.36] }, material: 'screenLit' });
run('addClip', { id: 'cube', clip: { name: 'Hop', start: 0 } });
run('addClip', { id: 'cube', clip: { name: 'Spin', start: 11, fadeIn: 0.4 } });

// a rail along the front of the desk; an empty rides it from 10 s to 16 s and picks the cube up at 12.5 s
run('addPath', { id: 'rail', name: 'Desk rail', points: [[-0.3, 0.02, 0.42], [-0.1, 0.08, 0.46], [0.1, 0.08, 0.46], [0.3, 0.02, 0.42]] });
run('addEmpty', { id: 'puck', name: 'Rider', transform: { position: [0, 0, 0] } });
const ride = run('addConstraint', { id: 'puck', constraint: { type: 'followPath', path: 'rail' } });
run('setKey', { target: 'puck', prop: `constraints.${ride.cid}.u`, t: 10, v: 0 });
run('setKey', { target: 'puck', prop: `constraints.${ride.cid}.u`, t: 16, v: 1, curve: 'smooth' });
const grab = run('addConstraint', { id: 'cube', constraint: { type: 'attach', target: 'puck', offset: { position: [0, 0.01, 0] } } });
run('setKey', { target: 'cube', prop: `constraints.${grab.cid}.influence`, t: 0, v: 0 });
run('setKey', { target: 'cube', prop: `constraints.${grab.cid}.influence`, t: 12.5, v: 1, curve: 'hold' });

// the polaroid turns to watch the rider (look-at, faded in), and flickers once the ghosts start
const watch = run('addConstraint', { id: 'tape', constraint: { type: 'lookAt', target: 'puck' } });
run('setKey', { target: 'tape', prop: `constraints.${watch.cid}.influence`, t: 10, v: 0 });
run('setKey', { target: 'tape', prop: `constraints.${watch.cid}.influence`, t: 12, v: 0.35, curve: 'smooth' });
const fl = run('addBehaviour', { id: 'polaroid', type: 'flicker', prop: 'brightness', params: { rate: 14, depth: 0.4, dropout: 0.08 } });
run('setKey', { target: 'polaroid', prop: `behaviours.${fl.bid}.weight`, t: 17.9, v: 0 });
run('setKey', { target: 'polaroid', prop: `behaviours.${fl.bid}.weight`, t: 18.2, v: 1, curve: 'linear' });

// the remote: parented to the mouse pad (which slides a little), with a slow handheld-style drift
run('setParent', { id: 'wii', parent: 'pad' });
run('setKey', { target: 'pad', prop: 'position.x', t: 14, v: doc.objects.find(o => o.id === 'pad').transform.position[0] });
run('setKey', { target: 'pad', prop: 'position.x', t: 15.5, v: doc.objects.find(o => o.id === 'pad').transform.position[0] + 0.04, curve: 'settle' });
run('addBehaviour', { id: 'wii', type: 'noise', params: { amp: 0.002, freq: 0.4, rot: 0.6 } });

// lights and visibility: the power LED goes from teal to red, the keyboard disappears for the last two seconds
run('setKey', { target: 'led', prop: 'color', t: 14, v: '#3FB5A8' });
run('setKey', { target: 'led', prop: 'color', t: 15, v: '#FF2A1E', curve: 'smooth' });
run('setKey', { target: 'keyboard', prop: 'visible', t: 0, v: true });
run('setKey', { target: 'keyboard', prop: 'visible', t: 17.5, v: false });

fs.writeFileSync(new URL('../scenes/object_anim_demo.scene.json', import.meta.url), JSON.stringify(doc, null, 1));
console.log('scenes/object_anim_demo.scene.json:', cmd.history.length, 'commands:', [...new Set(cmd.history)].join(', '));
