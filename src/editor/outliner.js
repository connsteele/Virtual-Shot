// Outliner (Blender Outliner / Unreal World Outliner): everything in the scene document, by kind. Click to select;
// a dot marks objects with animated properties. The eye hides an object, or a part of the look, in the viewport only
// (Blender's eye; H hides the selection, Alt+H reveals all).
const EYE = on => on
  ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>'
  : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7.5c1.6 2.2 3.6 3.3 6 3.3s4.4-1.1 6-3.3M4.4 9.8 3.3 11.6M8 10.8v2M11.6 9.8l1.1 1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON = { model: '▣', empty: '✛', camera: '◳', card: '▭', led: '●', layer: '▤', event: '◆', look: '◐', scene: '◇' };

export class Outliner {
  constructor(E, el) {
    this.E = E; this.el = el;
    E.on('change', () => this.draw()); E.on('select', () => this.mark());
    el.addEventListener('click', e => {
      const eye = e.target.closest('[data-eye]');
      if (eye) { const [kind, id] = eye.dataset.eye.split(':'), on = eye.getAttribute('aria-pressed') === 'true';
        if (kind === 'obj') E.setHidden(id, on); else E.setShow(id, !on); return; }
      const r = e.target.closest('[data-sel]'); if (r) E.select(JSON.parse(r.dataset.sel)); });
    E.on('show', () => this.draw());
    el.addEventListener('dblclick', e => { const r = e.target.closest('[data-sel]'); if (!r) return; const s = JSON.parse(r.dataset.sel);
      if (s.kind === 'object' && E.view === 'free') E.emit('frameSelected', s.id); });
  }
  draw() {
    const { doc } = this.E, animated = new Set(doc.tracks.filter(t => t.keys.length).map(t => t.target));
    const E = this.E, placed = E.shot.placed;
    const eye = (key, on, label) => `<button type="button" class="eye" data-eye="${key}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(label)} in the viewport" aria-label="Show ${esc(label)} in the viewport">${EYE(on)}</button>`;
    const row = (sel, icon, label, depth, extra = '', vis = null) => `<li><div class="row${vis && !vis.on ? ' off' : ''}" data-sel='${JSON.stringify(sel)}' style="--depth:${depth}"><span class="ico">${icon}</span><span class="lbl">${esc(label)}</span>${extra}${vis ? eye(vis.key, vis.on, label) : ''}</div></li>`;
    const objs = doc.objects.map(o => row({ kind: 'object', id: o.id }, ICON[o.type] || '·', o.name || o.id, 1,
      animated.has(o.id) ? '<span class="anim" title="Animated">●</span>' : '', placed[o.id] ? { key: 'obj:' + o.id, on: !E.hidden.has(o.id) } : null)).join('');
    const look = k => ({ key: 'show:' + k, on: !!E.show[k] });
    const chat = doc.layers.find(l => l.type === 'chat2d');
    this.el.innerHTML = `<ul class="tree">
      ${row({ kind: 'scene' }, ICON.scene, 'Scene', 0, animated.has('scene') ? '<span class="anim" title="Animated">●</span>' : '')}
      ${objs}
      ${row({ kind: 'layer', id: chat.id }, ICON.layer, 'Chat layer (2D)', 0, `<span class="count">${chat.script.messages.length}</span>`)}
      ${row({ kind: 'events', id: 'ghosts' }, ICON.event, 'Ghost flashes', 0, `<span class="count">${doc.events.ghosts.length}</span>`, look('ghosts'))}
      ${row({ kind: 'events', id: 'pops' }, ICON.event, 'Pops (2D)', 0, `<span class="count">${doc.events.pops.length}</span>`, look('pops'))}
      ${row({ kind: 'look', id: 'lighting' }, ICON.look, 'Lighting', 0)}
      ${row({ kind: 'look', id: 'haze' }, ICON.look, 'Haze', 0, '', look('haze'))}
    </ul>`;
    this.mark();
  }
  mark() { const s = JSON.stringify(this.E.sel); this.el.querySelectorAll('[data-sel]').forEach(r => r.setAttribute('aria-selected', String(r.dataset.sel === s))); }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { esc };
