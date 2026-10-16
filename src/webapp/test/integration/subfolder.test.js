// A SUBFOLDER without a trailing slash must not concatenate into broken paths.
import { describe, expect, it } from 'vitest';
import { bootApp } from '../helpers/bootApp.js';

const basicHeader = 'Basic ' + Buffer.from('admin:secret').toString('base64');

describe('SUBFOLDER normalization', () => {
  it('serves static assets, the rendered client and server-owned constants under a slash-less SUBFOLDER', async () => {
    const app = await bootApp({ subfolder: '/portal' });
    try {
      const headers = { Authorization: basicHeader };
      expect((await fetch(`${app.baseUrl}/portal/`, { headers })).status).toBe(200);
      expect((await fetch(`${app.baseUrl}/portal/public/img/logo.png`, { headers })).status).toBe(200);
      expect((await fetch(`${app.baseUrl}/portalpublic/img/logo.png`, { headers })).status).toBe(404);
      const js = await (await fetch(`${app.baseUrl}/portal/uponlanxyz-web.js`, { headers })).text();
      expect(js).toContain('"/portal/socket.io"');
      expect(js).toContain("const OKD_RELEASE = '5.0.0-okd-scos.1';");
    } finally {
      await app.close();
    }
  });
});
