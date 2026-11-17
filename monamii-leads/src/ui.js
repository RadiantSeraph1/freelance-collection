// View helpers shared by templates: inline SVG icons (Lucide, ISC licence).
const ICONS = require('./icons');

function icon(name, extra = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

module.exports = { icon, initials };
