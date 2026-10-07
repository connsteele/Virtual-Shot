// Outliner (Blender Outliner / Unreal World Outliner): everything in the scene document, by kind. Click to select;
// a dot marks objects with animated properties.
const ICON = { model: '▣', empty: '✛', camera: '◳', card: '▭', led: '●', layer: '▤', event: '◆', look: '◐', scene: '◇' };

export class Outliner {
  constructor(E, el) {
    this.E = E; this.el = el;
    E.on('change', () => this.draw()); E.on('select', () => this.mark());
    el.addEventListener('click', e => { const r = e.target.closest('[data-sel]'); if (r) E.select(JSON.parse(r.dataset.sel)); });
    el.addEventListener('dblclick', e => { const r = e.target.closest('[data-sel]'); if (!r) return; const s = JSON.parse(r.dataset.sel);
      if (s.kind === 'object' && E.view === 'free') E.emit('frameSelected', s.id); });
  }
  draw() {
    const { doc } = this.E, animated = new Set(doc.tracks.filter(t => t.keys.length).map(t => t.target));
    const row = (sel, icon, label, depth, extra = '') => `<li><div class="row" data-sel='${JSON.stringify(sel)}' style="--depth:${depth}"><span class="ico">${icon}</span><span>${esc(label)}</span>${extra}</div></li>`;
    const objs = doc.objects.map(o => row({ kind: 'object', id: o.id }, ICON[o.type] || '·', o.name || o.id, 1,
      animated.has(o.id) ? '<span class="anim" title="Animated">●</span>' : '')).join('');
    const chat = doc.layers.find(l => l.type === 'chat2d');
    this.el.innerHTML = `<ul class="tree">
      ${row({ kind: 'scene' }, ICON.scene, 'Scene', 0, animated.has('scene') ? '<span class="anim" title="Animated">●</span>' : '')}
      ${objs}
      ${row({ kind: 'layer', id: chat.id }, ICON.layer, 'Chat layer (2D)', 0, `<span class="count">${chat.script.messages.length}</span>`)}
      ${row({ kind: 'events', id: 'ghosts' }, ICON.event, 'Ghost flashes', 0, `<span class="count">${doc.events.ghosts.length}</span>`)}
      ${row({ kind: 'events', id: 'pops' }, ICON.event, 'Pops (2D)', 0, `<span class="count">${doc.events.pops.length}</span>`)}
      ${row({ kind: 'look', id: 'lighting' }, ICON.look, 'Lighting', 0)}
      ${row({ kind: 'look', id: 'haze' }, ICON.look, 'Haze', 0)}
    </ul>`;
    this.mark();
  }
  mark() { const s = JSON.stringify(this.E.sel); this.el.querySelectorAll('[data-sel]').forEach(r => r.setAttribute('aria-selected', String(r.dataset.sel === s))); }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };
