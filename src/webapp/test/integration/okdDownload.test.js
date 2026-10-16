import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import { bootApp } from '../helpers/bootApp.js';
const require = createRequire(import.meta.url);
const release = '5.0.0-okd-scos.1';
const profile = { id: 'lab-okd', release, revision: 'a'.repeat(64), boot_mode: 'iso', asset_url: '' };
const job = (mediaVersion) => ({ mediaVersion, installerArchiveSha256: 'b'.repeat(64), installerBinarySha256: 'c'.repeat(64) });

function pxeWorkspace(root) {
  const workspace = path.join(root, 'config/pxe-workspace'); const boot = path.join(workspace, 'boot-artifacts'); fs.mkdirSync(boot, { recursive: true });
  for (const [name, value] of [['agent.x86_64-vmlinuz', 'kernel'], ['agent.x86_64-initrd.img', 'initrd'], ['agent.x86_64-rootfs.img', 'rootfs']]) fs.writeFileSync(path.join(boot, name), value);
  fs.writeFileSync(path.join(boot, 'agent.x86_64.ipxe'), fs.readFileSync(new URL('../fixtures/agent-native-source.ipxe', import.meta.url)));
  return workspace;
}

describe('authenticated OKD media downloads', () => {
  it('serves ISO ranges and a portable PXE bundle under release/vN routes', async () => {
    const app = await bootApp({ user: 'admin', pass: 'secret', subfolder: '/portal/' });
    try {
      const artifacts = require('../../services/okdArtifactServices');
      const isoWorkspace = path.join(app.root, 'config/iso-workspace'); fs.mkdirSync(isoWorkspace); fs.writeFileSync(path.join(isoWorkspace, 'agent.x86_64.iso'), 'ISO fixture');
      await artifacts.finalizeArtifacts({ workspace: isoWorkspace, mode: 'iso', profile, job: job('v1'), publicBaseUrl: null });
      await artifacts.finalizeArtifacts({ workspace: pxeWorkspace(app.root), mode: 'pxe', profile: { ...profile, boot_mode: 'pxe', asset_url: 'https://boot.example/' }, job: job('v2'), publicBaseUrl: 'https://boot.example/' });
      const headers = { Authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64') };
      const isoUrl = `${app.baseUrl}/portal/okd/lab-okd/${release}/v1/iso`;
      expect((await fetch(isoUrl)).status).toBe(401);
      const iso = await fetch(isoUrl, { headers: { ...headers, Range: 'bytes=1-3' } }); expect(iso.status).toBe(206); expect(await iso.text()).toBe('SO ');
      expect(iso.headers.get('content-range')).toBe('bytes 1-3/11');
      const bundle = await fetch(`${app.baseUrl}/portal/okd/lab-okd/${release}/v2/pxe.tar.gz`, { headers });
      expect(bundle.status).toBe(200); expect(bundle.headers.get('content-disposition')).toBe(`attachment; filename="lab-okd-${release}-v2.tar.gz"`);
      const tar = zlib.gunzipSync(Buffer.from(await bundle.arrayBuffer())).toString('latin1');
      expect(tar).toContain(`okd/lab-okd/${release}/v2/`); expect(tar).toContain('boot.ipxe'); expect(tar).not.toMatch(/pullSecret|kubeconfig|workspace|PRIVATE KEY/);
      const legacyId = '33333333-3333-3333-3333-333333333333'; const legacyDir = path.join(app.root, 'assets/okd/lab-okd', legacyId); fs.mkdirSync(legacyDir, { recursive: true });
      const legacyContent = 'legacy route iso'; const legacyEntry = { role: 'iso', name: 'agent.iso', size: Buffer.byteLength(legacyContent), sha256: crypto.createHash('sha256').update(legacyContent).digest('hex') };
      fs.writeFileSync(path.join(legacyDir, legacyEntry.name), legacyContent); fs.writeFileSync(path.join(legacyDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profileId: 'lab-okd', versionId: legacyId, jobId: legacyId, release, mode: 'iso', publicBaseUrl: 'https://old.example/', files: [legacyEntry], createdAt: '2025-01-01T00:00:00Z' }));
      const legacy = await fetch(`${app.baseUrl}/portal/okd/lab-okd/${legacyId}/iso`, { headers }); expect(legacy.status).toBe(200); expect(await legacy.text()).toBe(legacyContent);
      const audit = fs.readFileSync(path.join(app.root, 'logs/okd/audit.jsonl'), 'utf8'); expect(audit).toContain('bundle.export'); expect(audit).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|pullSecret/);
      for (const url of [`${app.baseUrl}/portal/okd/lab-okd/${release}/v9/iso`, `${app.baseUrl}/portal/okd/lab-okd/bad%2Frelease/v1/iso`, `${app.baseUrl}/portal/okd/lab-okd/${release}/v2/kubeconfig`]) expect((await fetch(url, { headers })).status).toBe(404);
    } finally { await app.close(); fs.rmSync(app.root, { recursive: true, force: true }); }
  });
});
