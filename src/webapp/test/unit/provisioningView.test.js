// Wiring contract for the Menus-page provisioning sidebar/editor reuse.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../views/uponlanxyz-web.ejs'),
  'utf-8',
);

describe('Menus provisioning editor wiring', () => {
  it('still parses as client-side JavaScript after rendering the baseurl placeholders', () => {
    const rendered = view.replaceAll('<%= baseurl %>', '/');
    expect(() => new Function(rendered)).not.toThrow();
  });

  it('adds a Provisioning Profiles sidebar section that requests backend data', () => {
    expect(view).toContain('Provisioning Profiles');
    expect(view).toContain("id=\"provisioning-file-list\"");
    expect(view).toContain("socket.emit('getprovisioning')");
  });

  it('reuses the shared editor flow for provisioning files', () => {
    expect(view).toContain('function renderEditorFile(filename, response, buttons, toolbar)');
    expect(view).toContain("socket.on('renderprovisioningfile'");
    expect(view).toContain("socket.emit('getprovisioningfile', relativePath)");
    expect(view).toContain("[data-provisioning-open]");
  });

  it('wires create, save, and delete provisioning actions through sockets', () => {
    expect(view).toContain("socket.emit('createkickstart',profile)");
    expect(view).toContain("socket.emit('createcloudinit',profile)");
    expect(view).toContain("socket.emit('saveprovisioningfile',filename,text)");
    expect(view).toContain("socket.emit('deleteprovisioningfile',filename)");
    expect(view).toContain("[data-provisioning-save]");
    expect(view).toContain("[data-provisioning-delete]");
  });

  it('wires version input, save-version, and validate actions', () => {
    expect(view).toContain('id="provisioning-version"');
    expect(view).toContain("socket.emit('saveprovisioningversion', filename, version)");
    expect(view).toContain("socket.emit('validateprovisioning', filename, version)");
    expect(view).toContain("socket.on('renderprovisioningvalidation'");
    expect(view).toContain("[data-provisioning-version]");
    expect(view).toContain("[data-provisioning-validate]");
  });

  it('shows validation results in a modal popup', () => {
    expect(view).toContain('id="validationModal"');
    expect(view).toContain('id="validationModalBody"');
    expect(view).toContain("$('#validationModal').modal('show')");
    expect(view).toContain("$('#validationModalLabel').text(title)");
  });

  it('omits the redundant category badge in the provisioning table', () => {
    expect(view).not.toContain('badge badge-info">${value.category}');
  });

  it('color-codes the kind badge in the provisioning table', () => {
    expect(view).toContain("value.kind === 'Kickstart'");
    expect(view).toContain('background-color:#f8d7da');
    expect(view).toContain('background-color:#d4edda');
  });

  it('shows a distro dropdown for kickstart profiles', () => {
    expect(view).toContain('function provisioningVersionControl(filename, version)');
    expect(view).toContain("['', 'Select distro…']");
    expect(view).toContain("['RHEL9', 'RHEL 9']");
    expect(view).toContain("['F41', 'Fedora 41']");
    expect(view).toContain("v === current ? ' selected' : ''");
  });

  it('renders the provisioning editor title in a smaller heading', () => {
    expect(view).toContain('<h4 class="m-3 mb-0 text-break">');
  });

  it('surfaces provisioning rows in the Assets page with filter/copy/open wiring', () => {
    expect(view).toContain('nav nav-tabs');
    expect(view).toContain('aria-label="Assets filter"');
    expect(view).toContain('>Boot <span');
    expect(view).toContain('>Provisioning <span');
    expect(view).toContain('<th>Type</th>');
    expect(view).toContain('data-asset-filter="provisioning"');
    expect(view).toContain('function openProvisioningFromAssets(relativePath)');
    expect(view).toContain('[data-copy-url]');
    expect(view).toContain('[data-asset-provisioning-open]');
    expect(view).toContain('>Edit</button>');
  });
});
