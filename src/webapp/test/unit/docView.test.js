// Regression guard for the doc-viewer link navigation. The internal
// `](….md)` links in a rendered doc must be intercepted and routed through the
// socket viewer instead of a browser navigation. That handler has to be
// delegated on `document`: #doc-viewer is created lazily (first docs:list
// response), so a direct `$('#doc-viewer').on(...)` bound at page load attaches
// to nothing and every click 404s ("Cannot GET /path.md").
//
// There is no DOM/jsdom harness in this repo (jQuery is browser-only), so this
// asserts the view's wiring contract rather than simulating a click.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('doc link navigation wiring (uponlanxyz-web.ejs)', () => {
  it('delegates the internal .md handler on document, not #doc-viewer', () => {
    // The fix: document-level delegation so the handler survives the lazy
    // #doc-viewer creation.
    expect(view).toContain("$(document).on('click', '#doc-viewer a'");
    // The bug: a direct binding on the not-yet-existing element.
    expect(view).not.toContain("$('#doc-viewer').on('click', 'a'");
  });

  it('intercepts .md links and loads them through the viewer', () => {
    // preventDefault stops the browser navigation; loaddoc() re-routes through
    // the docs:get socket event.
    expect(view).toContain('e.preventDefault()');
    expect(view).toContain("loaddoc(decodeURIComponent(href.split('#')[0]))");
  });
});
