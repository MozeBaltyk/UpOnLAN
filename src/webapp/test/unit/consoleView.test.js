// Wiring contract for the VM Console toolbar (copy/paste/font, scrollback). No
// DOM harness; assert the view source wiring.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('VM console toolbar wiring', () => {
  it('keeps scrollback across re-renders', () => {
    expect(view).toContain('let vmScrollback = \'\'');
    expect(view).toContain('if (vmScrollback) vmTerm.write(vmScrollback)');
  });

  it('does not tear down + re-attach the serial session on tab switches', () => {
    // renderconsole must NOT stop the console; it recreates the xterm and
    // attaches only once via the guarded startVmConsole().
    expect(view).toContain('function startVmConsole(force)');
    expect(view).toContain('if (!force && vmConsoleAttached) return;');
    expect(view).toContain('function stopVmConsole()');
    expect(view).toContain('vmTerm = null;');
    // No unconditional stop inside renderconsole (regression guard).
    expect(view).toContain('// Refresh VM state, but do NOT touch the serial session');
  });

  it('wires copy/paste/font controls', () => {
    expect(view).toContain('function vmCopyConsole()');
    expect(view).toContain('function vmPasteConsole()');
    expect(view).toContain('function vmFontConsole(delta)');
    expect(view).toContain("socket.emit('vm:console:input', t)");
  });

  it('does not ship screenshot/clear/download controls', () => {
    expect(view).not.toContain('vmScreenshot');
    expect(view).not.toContain("socket.emit('vm:screenshot')");
    expect(view).not.toContain('function vmClearConsole()');
    expect(view).not.toContain('function vmDownloadConsole()');
  });
});