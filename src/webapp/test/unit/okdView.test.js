import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const index = fs.readFileSync(path.join(root, 'views/index.ejs'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/uponlanxyz-web.ejs'), 'utf8');
const okd = view.slice(view.indexOf('const OKD_RELEASE'), view.indexOf('//// Render WOL page'));

describe('OKD view wiring', () => {
  it('is valid JavaScript and remains reachable from the main navigation', () => {
    const rendered = view
      .replaceAll('<%= baseurl %>', '/')
      .replaceAll('<%= okdRelease %>', '5.0.0-okd-scos.1')
      .replaceAll('<%= okdMaxWorkers %>', '20');
    expect(() => new Function(rendered)).not.toThrow();
    expect(index).toContain("navTo('renderokd','navokd')");
    expect(view).toContain('function renderokd()');
  });

  it('defaults new profiles to PXE with the profile-owned Asset URL and trust fields', () => {
    const source = view.slice(view.indexOf('function okdNewProfile'), view.indexOf('function okdNormalizeProfile'));
    const profile = new Function(`const OKD_RELEASE = '5.0.0-okd-scos.1'; ${source}; return okdNewProfile();`)();
    expect(profile).toMatchObject({
      boot_mode: 'pxe',
      asset_url: 'https://192.168.7.1:8443/',
      asset_certificate_bundle: '',
      additional_ca_bundle: '',
      ssh_public_key: '',
    });
  });

  it('renders accessible saved-mode controls below nodes with conditional PXE settings', () => {
    expect(okd.indexOf('id="okd-hosts"')).toBeLessThan(okd.indexOf('id="okd-installation-media"'));
    expect(okd.indexOf('id="okd-installation-media"')).toBeLessThan(okd.indexOf('id="okd-profile-actions"'));
    expect(okd).toContain('<fieldset><legend class="sr-only">Boot mode</legend>');
    expect(okd).toContain('name="okd-boot-mode" id="okd-boot-pxe" value="pxe"');
    expect(okd).toContain('name="okd-boot-mode" id="okd-boot-iso" value="iso"');
    expect(okd).toContain("p.boot_mode === 'iso' ? 'd-none' : ''");
    expect(okd).toContain('id="okd-asset-url"');
    expect(okd).toContain('aria-describedby="okd-certificate-status"');
    expect(okd).not.toContain('okd-asset-url-help');
    expect(okd).toContain('id="okd-add-ca"');
    expect(index).toContain('public/vendor/css/bootstrap-icons.min.css');
    expect(okd).toContain('id="okd-add-ca" type="button" class="btn btn-primary btn-sm rounded-circle p-0 d-inline-flex align-items-center justify-content-center" style="width:1.75rem;height:1.75rem" aria-label="Add CA certificate" title="Add CA certificate"><i class="bi bi-plus-lg" aria-hidden="true"></i>');
    expect(okd).not.toContain('✚');
    expect(okd).not.toContain('&#10010;');
  });

  it('includes media and trust fields in form snapshots and Save preparation', () => {
    const readForm = view.slice(view.indexOf('function okdReadForm'), view.indexOf('function okdShowResult'));
    expect(readForm).toContain('boot_mode: $(\'input[name="okd-boot-mode"]:checked\').val()');
    expect(readForm).toContain("asset_url: $('#okd-asset-url').val().trim()");
    expect(readForm).toContain('asset_certificate_bundle: okdProfile.asset_certificate_bundle');
    expect(readForm).toContain('additional_ca_bundle: okdProfile.additional_ca_bundle');
    expect(okd).toContain("emit('okd:certificates:validate', { pem: profile.additional_ca_bundle || '' }");
    expect(okd).toContain('okdInspectCertificate(profile, function(result)');
    expect(okd).toContain('okdPrepareProfileSave(profile)');
  });

  it('provides endpoint details and explicit per-profile CA validation/removal modals', () => {
    for (const text of ['default certificate', 'custom certificate', 'self-signed', 'CA-issued', 'name/address matches', 'system trusted', 'included in additionalTrustBundle', 'Subject and issuer', 'Subject alternative names', 'Valid from / valid to', 'SHA-256 fingerprint', 'Chain details', 'Inspection/trust warnings']) {
      expect(okd).toContain(text);
    }
    expect(okd).toContain('id="okd-certificate-modal"');
    expect(okd).toContain('id="okd-ca-modal"');
    expect(okd).toContain('PEM certificate or CA bundle');
    expect(okd).toContain('Validate and add');
    expect(okd).toContain("emit('okd:certificates:inspect'");
    expect(okd).toContain("emit('okd:certificates:validate'");
    expect(okd).toContain('data-okd-remove-ca');
    expect(okd).not.toContain('PRIVATE KEY-----');
  });

  it('normalizes and deduplicates additional CA state by fingerprint', () => {
    const source = view.slice(view.indexOf('function okdPemBlocks'), view.indexOf('function okdAdditionalCaRows'));
    const merge = new Function(`${source}; return okdMergeAdditionalBundle;`)();
    const block = (name) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`;
    const result = merge(block('B'), [{ fingerprint256: 'b' }], { pem: block('A') + block('B2'), certificates: [{ fingerprint256: 'a' }, { fingerprint256: 'b' }] });
    expect(result.certificates.map((cert) => cert.fingerprint256)).toEqual(['a', 'b']);
    expect(result.pem).toBe(block('A') + block('B2'));
  });

  it('shows generated trust and a pull-secret-free effective artifact URL preview in Edit', () => {
    expect(okd).toContain('aria-label="install-config.yaml"');
    expect(okd).toContain('id="okd-effective-preview"');
    expect(okd).toContain('bootArtifactsBaseURL: ${p.asset_url}okd/${p.id}/${p.release}/<next-media-version>');
    expect(okd).toContain('Read-only preview. The pull secret is never included.');
    expect(okd).toContain('okdConfigs.installConfig');
  });

  it('limits Operations to saved-mode generation, active state, bounded logs, and recent history', () => {
    const operations = view.slice(view.indexOf('function okdJobCard'), view.indexOf('function okdRenderForm'));
    expect(operations).toContain('Generate installation media');
    expect(operations).toContain('Active generation');
    expect(operations).toContain('Recent generations');
    expect(operations).toContain('Show/hide log');
    expect(operations).toContain('max-height:18rem;overflow:auto');
    expect(operations).toContain('Download PXE bundle');
    expect(operations).toContain('/pxe.tar.gz');
    expect(operations).toContain('Download ISO');
    expect(operations).toContain('data-okd-view-artifacts');
    for (const removed of ['Installation monitoring', 'Cluster health', 'Run probes', 'retention', 'Diagnostics', 'okd:operations:', 'localAssets:get', 'localAssets:save']) {
      expect(okd).not.toContain(removed);
    }
  });

  it('starts only the saved mode and identifies cancel/log actions by media identity', () => {
    const generation = view.slice(view.indexOf('function okdStartGenerate'), view.indexOf('function okdPullSecretBox'));
    expect(generation).toContain("emit('okd:jobs:start', { profileId: okdExistingId, revision: okdRevision, confirmed: true }");
    expect(generation).not.toContain('mode:');
    expect(okd).toContain("emit('okd:jobs:cancel', { profileId: job.profileId, release: job.release, mediaVersion: job.mediaVersion }");
    expect(okd).toContain("emit('okd:jobs:log', { profileId: shown.profileId, release: shown.release, mediaVersion: shown.mediaVersion, maxBytes: 65536 }");
  });

  it('shows prerequisite status in one popup and auto-starts without a second Generate button', () => {
    expect(okd).not.toContain('data-okd-generate');
    expect(okd).toContain('id="okd-generate-action"');
    expect(okd).toContain('if (!c.checking) { const problems = okdGenerateProblems(); if (!problems.errors.length && !problems.warnings.length) okdStartGenerate(); }');
    expect(okd).toContain('Checks passed — starting generation…');
  });

  it('renders the certificate inspection status as a success/warning/error banner', () => {
    expect(okd).toContain('id="okd-certificate-status" class="alert alert-${okdCertificateStatus().state}');
    expect(okd).toContain("removeClass('alert-secondary alert-success alert-warning alert-danger')");
    expect(okd).toContain('function okdCertificateStatus()');
  });

  it('uses release/media version portal routes and keeps history newest-first from the backend', () => {
    expect(okd).toContain('${encodeURIComponent(release)}/${encodeURIComponent(mediaVersion)}/pxe.tar.gz');
    expect(okd).toContain('${encodeURIComponent(release)}/${encodeURIComponent(mediaVersion)}/iso');
    expect(okd).toContain('(okdJobStatus.history || []).map');
  });

  it('retains stale-response, modal lifecycle, dirty-state, and accessibility guards', () => {
    expect(okd).toContain('epoch !== okdViewEpoch');
    expect(okd).toContain('token !== okdCertificateEpoch');
    expect(okd).toContain('requestRevision !== okdRevision');
    expect(okd).toContain("$('[id^=\"okd-\"][id$=\"-modal\"]').hasClass('show')");
    expect(okd).toContain('okdSnapshot(okdReadForm()) === okdBaseline');
    expect(okd).toContain('Discard unsaved OKD profile changes?');
    expect(okd).toContain('aria-live="polite"');
    expect(okd).toContain('aria-modal="true"');
    expect(okd).toContain('Inspected · see certificate details');
    for (const label of ['Shared pull secret help', 'Pull secret input help', 'SSH public key help']) {
      expect(okd).toContain(`aria-label="${label}"`);
    }
    expect(okd.match(/<i class="bi bi-question-lg" aria-hidden="true"><\/i>/g)).toHaveLength(3);
  });

  it('preserves generated SSH-key and pull-secret safety UI', () => {
    expect(okd).toContain('id="okd-ssh-key-help" class="sr-only"');
    expect(okd).toContain('/config/okd/keys/&lt;profile&gt;/id_ed25519');
    expect(okd).toContain('id="okd-pull-secret-auth-warning"');
    expect(okd).toContain("socket.volatile.timeout(30000).emit('okd:pull-secret:save'");
    expect(okd).toContain("input.val('');");
  });
});
