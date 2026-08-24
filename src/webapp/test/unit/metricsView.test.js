import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('metrics chart legend wiring', () => {
  it('adds an explicit legend click handler that toggles dataset visibility', () => {
    expect(view).toContain('onClick: function(_event, legendItem, legend)');
    expect(view).toContain('chart.setDatasetVisibility(index, !chart.isDatasetVisible(index));');
    expect(view).toContain('chart.update();');
  });
});
