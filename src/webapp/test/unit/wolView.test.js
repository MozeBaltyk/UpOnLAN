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
