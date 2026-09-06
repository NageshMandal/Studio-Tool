/**
 * Inline SVG icons, exposed to every view as `icon(name, size)`.
 *
 * These live in a module rather than an EJS partial because EJS gives each
 * `include` its own scope: a function declared inside a partial is invisible
 * to the file that included it, and to any sibling partial. Hanging the
 * helper off res.locals instead makes it available everywhere — layouts,
 * pages and partials alike — with no include line to forget.
 *
 * Icons are inlined rather than fetched from a sprite or icon font so the
 * sidebar paints with the page, and `currentColor` lets each one inherit the
 * active or inactive nav colour without a second stylesheet rule.
 */

const PATHS = {
    dashboard: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
    tracker:   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    box:       '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    people:    '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="3.2"/><path d="M22 20v-2a4 4 0 0 0-3-3.85"/><path d="M16 3.6a4 4 0 0 1 0 7.75"/>',
    inbox:     '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13l2.5 8v6H3v-6Z"/>',
    cart:      '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.7 12.4a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.6-1.3L21 7H6"/>',
    report:    '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M9 17v-4"/><path d="M12 17v-6"/><path d="M15 17v-2"/>',
    log:       '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/>',
    shield:    '<path d="M12 22s8-3.4 8-10V5.5l-8-3-8 3V12c0 6.6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.82 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.1a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
    logout:    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    building:  '<path d="M3 21h18"/><path d="M5 21V6l7-4 7 4v15"/><path d="M9.5 21v-5h5v5"/><path d="M9 9h.01"/><path d="M15 9h.01"/><path d="M9 12.5h.01"/><path d="M15 12.5h.01"/>',
    globe:     '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17"/><path d="M3.5 15h17"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/>',
    crown:     '<path d="m3 18 1.8-11L9.5 12 12 4.5 14.5 12l4.7-5L21 18Z"/><path d="M3.5 21h17"/>',
    user:      '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    lock:      '<rect x="4" y="10.5" width="16" height="11" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    eye:       '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff:    '<path d="m3 3 18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 4"/><path d="M6.3 8.3A16.6 16.6 0 0 0 2 12s3.6 6 10 6a9.8 9.8 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    check:     '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
    alert:     '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.2h.01"/>',
    plus:      '<path d="M12 5v14"/><path d="M5 12h14"/>',
    arrow:     '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    search:    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    download:  '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/>',
    link:      '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7l-1.5 1.5"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.5-1.5"/>',
    pin:       '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
    edit:      '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z"/>',
    archive:   '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5"/><path d="M10 12.5h4"/>'
};

function icon(name, size) {
  const s = size || 17;
  const body = PATHS[name] || PATHS.dashboard;
  return (
    `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`
  );
}

module.exports = { icon, PATHS };
