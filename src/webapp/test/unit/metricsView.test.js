import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('metrics chart legend wiring', () => {
  it('toggles dataset visibility + legend hidden flag on legend click', () => {
    expect(view).toContain('onClick: function(_event, legendItem, legend)');
    expect(view).toContain('chart.hide(index)');
    expect(view).toContain('chart.show(index)');
    expect(view).toContain('legendItem.hidden = true');
    expect(view).toContain('legendItem.hidden = false');
  });
});
