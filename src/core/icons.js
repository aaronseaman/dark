// 24px icons, 1.5px strokes, drawn for this app. currentColor everywhere.

const P = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  capture: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16"/>',
  torch: '<path d="M8 3h8l-1.5 5h-5zM9.5 8v12h5V8"/><path d="M12 12v3"/>',
  torchOn: '<path d="M8 3h8l-1.5 5h-5zM9.5 8v12h5V8" fill="currentColor" fill-opacity=".18"/><path d="M12 12v3"/>',
  aspect: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><rect x="8" y="7" width="8" height="10" rx="1"/>',
  rotateSession: '<path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5"/><path d="M20 4v4.5h-4.5"/><rect x="8" y="10" width="8" height="10" rx="1" transform="rotate(-90 12 15)"/>',
  rotate: '<path d="M19 12a7 7 0 1 1-2.05-4.95L19 9"/><path d="M19 4.5V9h-4.5"/>',
  crop: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
  shadow: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7 11H5.5v9.5h13V11H17"/>',
  text: '<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>',
  night: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  photos: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4.5 4"/>',
  files: '<path d="M3.5 7V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9a1.5 1.5 0 0 0-1.5-1.5h-7.5L9.5 5H5a1.5 1.5 0 0 0-1.5 1.5z"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  select: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
  rename: '<path d="M4 7h10M4 12h7M4 17h5"/><path d="M14 20l1-3.5 5-5 2.5 2.5-5 5z"/>',
  addpage: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M12 9v6M9 12h6"/>',
  copy: '<rect x="8" y="8" width="11.5" height="12.5" rx="1.5"/><path d="M16 8V5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5v10.5A1.5 1.5 0 0 0 5.5 17H8"/>',
  merge: '<path d="M6 4v5a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v3M18 4v5a4 4 0 0 1-4 4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
};

export function icon(name, size = 24, extra = '') {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${P[name] || ''}</svg>`;
  return span.firstChild;
}
