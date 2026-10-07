// Named look presets ("styles"). The scene document picks one with look.style and may add or override presets in
// look.styles: { <name>: { label, pixel, materials, ps1 } }, merged over the built-ins below. A style is data only:
//   pixel      null (full resolution) or chunky-pixel options (see PIXEL_LOOK in shot_renderer.js)
//   materials  the material set for lit surfaces: 'default' (the Black Page body shader) or a registered set ('ps1')
//   ps1        options for the 'ps1' material set: snap (vertex snapping to the internal pixel grid), affine (no
//              perspective correction on textures), gouraud (lighting per vertex), all 0..1
// The renderer applies a resolved style with ShotRenderer.setStyle(); editor commands setLookStyle / defineLookStyle
// change the document (undoable), so renders to disk follow the document's style.

export const BUILTIN_STYLES = {
  default: { label: 'Black Page (default)', pixel: null, materials: 'default' },
  'chunky-pixels': { label: 'Chunky pixels (480, 18-bit)', pixel: { lines: 480, bits: 6, msaa: false, sharpScreen: 1080 }, materials: 'default' },
  'wii-bloom': { label: 'Wii (chunky + bloom)', pixel: { lines: 480, bits: 6, msaa: false, sharpScreen: 1080, bloom: 0.5 }, materials: 'default' },
  ps1: { label: 'PS1 (240, 15-bit, wobble)', pixel: { lines: 240, bits: 5, msaa: false, sharpScreen: 480 }, materials: 'ps1',
    ps1: { snap: 1, affine: 1, gouraud: 1 } },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { if (!isObj(a) || !isObj(b)) return b === undefined ? a : b; const o = { ...a }; for (const k of Object.keys(b)) o[k] = merge(a[k], b[k]); return o; };

/** Every style the document can use: built-ins merged with the document's own (look.styles). */
export function listStyles(doc) {
  const own = doc.look?.styles || {}, out = {};
  for (const k of new Set([...Object.keys(BUILTIN_STYLES), ...Object.keys(own)])) out[k] = merge(BUILTIN_STYLES[k] || {}, own[k] || {});
  return out;
}
/** The style named `name` (default: the document's look.style), resolved; unknown names fall back to 'default'. */
export function resolveStyle(doc, name = doc.look?.style || 'default') {
  const all = listStyles(doc), s = all[name] || all.default;
  return { name: all[name] ? name : 'default', label: s.label || name, pixel: s.pixel || null, materials: s.materials || 'default', ps1: s.ps1 || null };
}
