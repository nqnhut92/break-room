// Lucide SVG subset. https://lucide.dev — ISC / MIT; see lucide-LICENSE.txt.
// Keep only the icons used by the controls, without loading the full icon library.
const icons = {
  settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.08 4h.01"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15"/>',
  sparkles: '<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3ZM5 3v4M3 5h4m12 12v4m-2-2h4"/>',
  'zoom-in': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6m-3-3h6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  x: '<path d="m18 6-12 12M6 6l12 12"/>',
  link: '<path d="m10 13 4-4m1-2 1-1a4.24 4.24 0 0 1 6 6l-3 3a4.24 4.24 0 0 1-6 0m-4 2-1 1a4.24 4.24 0 0 1-6-6l3-3a4.24 4.24 0 0 1 6 0"/>',
  'volume-x': '<path d="m11 5-6 4H2v6h3l6 4Zm12 4-6 6m0-6 6 6"/>',
  'volume-2': '<path d="m11 5-6 4H2v6h3l6 4Zm4.54 3.46a5 5 0 0 1 0 7.07m3.53-10.6a10 10 0 0 1 0 14.14"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Zm0 0L11 13"/>',
  'cup-soda': '<path d="m6 8 1 13h10l1-13M5 8h14M8 8V5h8v3m-4-3V2h3"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8m0-5v5h-5m5 4a9 9 0 0 1-15.36 6.36L3 16m0 5v-5h5"/>',
  hammer: '<path d="m15 12-8.5 8.5a2.12 2.12 0 0 1-3-3L12 9m6 6 4-4m-7-8 4-1 3 3-1 4-3 3-6-6Z"/>',
  zap: '<path d="m13 2-3 8H3l8 12 3-8h7Z"/>',
  'rotate-ccw': '<path d="M3 11a9 9 0 1 1 2.64 6.36M3 4v7h7"/>',
};

export function iconMarkup(name) {
  if (!Object.hasOwn(icons, name)) throw new Error('Unknown Lucide icon: ' + name);
  return '<svg class="ui-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + icons[name] + '</svg>';
}
export function renderIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) node.innerHTML = iconMarkup(node.dataset.icon);
}
export function setButtonIcon(button, name, label = '') {
  button.innerHTML = iconMarkup(name);
  if (label) button.append(document.createTextNode(' ' + label));
}
