// Wiring contract for the WOL add-host form in the rendered client JS. No DOM
// harness here; assert the relevant view code is present/absent.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('WOL add-host form wiring', () => {
  it('escapes every persisted value used in a table row', () => {
    const source = view.slice(view.indexOf('function wolStatusBadge'), view.indexOf("socket.on('renderwol'"));
    const row = new Function(`${view.slice(view.indexOf('function okdAttr'), view.indexOf('function okdDiskHintParts'))}${source}; return wolHostRow;`)();
    const rendered = row({ hostname: '<img src=x onerror=alert(1)>', default_mac: '\" onmouseover=alert(1)', ip: '<script>x</script>', wake_at: "' autofocus onfocus=x", status: '<svg/onload=x>' });
    expect(rendered).not.toMatch(/<img|<script|<svg|data-mac=""/);
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered).toContain('&quot; onmouseover=alert(1)');
  });

  it('shows explicit client-side errors for missing host name or MAC', () => {
    expect(view).toContain("Host name is required");
    expect(view).toContain("MAC address is required");
  });

  it('keeps the add form open until addwol succeeds', () => {
    expect(view).toContain("socket.emit('addwol', payload)");
    expect(view).not.toContain("$('#add-wol-form').hide();");
  });

  it('re-shows the form when a socket error targets #wol-error', () => {
    expect(view).toContain("$('#add-wol-form').show();");
    expect(view).toContain("$('#wol-error').text(msg).show();");
  });
});
