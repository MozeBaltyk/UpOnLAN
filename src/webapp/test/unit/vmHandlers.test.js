// Unit tests: VM name validation (the guard in front of `sudo virsh` argv).
import { describe, expect, it } from 'vitest';
import vmHandlers from '../../sockets/vmHandlers.js';

describe('vmHandlers.isValidVmName', () => {
  it('accepts safe VM identifiers', () => {
    expect(vmHandlers.isValidVmName('testpxe')).toBe(true);
    expect(vmHandlers.isValidVmName('pxe-test_1.2')).toBe(true);
  });

  it('rejects anything that could break out of the virsh command', () => {
    expect(vmHandlers.isValidVmName('a; rm -rf /')).toBe(false);
    expect(vmHandlers.isValidVmName('$(id)')).toBe(false);
    expect(vmHandlers.isValidVmName('a b')).toBe(false);
    expect(vmHandlers.isValidVmName('')).toBe(false);
    expect(vmHandlers.isValidVmName(null)).toBe(false);
    expect(vmHandlers.isValidVmName(undefined)).toBe(false);
    expect(vmHandlers.isValidVmName(123)).toBe(false);
    // XML metacharacters: buildDomainXml interpolates the name unescaped, so
    // the validation charset is the only thing preventing XML/argv injection.
    expect(vmHandlers.isValidVmName('<foo>')).toBe(false);
    expect(vmHandlers.isValidVmName('a&b')).toBe(false);
    expect(vmHandlers.isValidVmName('a"b')).toBe(false);
    expect(vmHandlers.isValidVmName("a'b")).toBe(false);
  });
});

describe('vmHandlers.buildDomainXml', () => {
  const xml = vmHandlers.buildDomainXml('uponlan-client', 'uponlan');

  it('is a PXE network-boot domain with a serial console and no disk', () => {
    // Structural contract, not just substring presence: a template that was
    // truncated or reordered would fail these.
    expect(xml.startsWith("<domain type='kvm'>")).toBe(true);
    expect(xml.endsWith('</domain>\n')).toBe(true);
    expect(xml).toContain("<name>uponlan-client</name>");
    expect(xml).toContain("<boot dev='network'/>");
    expect(xml).not.toContain("<boot dev='hd'/>");
    expect(xml).toContain("<source network='uponlan'/>");
    expect(xml).toContain("<model type='e1000'/>");
    expect(xml).toContain("<rom file='/usr/lib/ipxe/qemu/uponlan-e1000.rom'/>");
    expect(xml).toContain('<emulator>/usr/bin/qemu-system-x86_64</emulator>');
    expect(xml).toContain("<target type='isa-serial' port='0'>");
    expect(xml).toContain("<console type='pty'>");
    expect(xml).not.toContain('<disk');
    expect(xml).not.toContain('<graphics');
    // Every non-void opening tag we emit must have a matching close.
    for (const tag of ['domain', 'os', 'features', 'devices', 'interface', 'serial', 'console']) {
      const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
      const close = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      expect(open, `balanced <${tag}>`).toBe(close);
    }
  });

  it('keeps the serial console as the only console device', () => {
    expect(xml).not.toContain("<console type='serial'>");
    expect(xml).not.toContain('virtio-serial');
  });
});

describe('vmHandlers.buildDomainXml (UEFI)', () => {
  const efi = vmHandlers.buildDomainXml('uponlan-client', 'uponlan', 'efi');

  it('selects OVMF firmware and drops the BIOS PCI option ROM', () => {
    expect(efi).toContain("<os firmware='efi'>");
    expect(efi).not.toContain('<rom file=');
    expect(efi).toContain("<boot dev='network'/>");
    expect(efi).toContain("<model type='e1000'/>");
    expect(efi).not.toContain('<disk');
    expect(efi).not.toContain('<graphics');
    expect(efi).toContain("<console type='pty'>");
  });

  it('defaults BIOS domain XML when firmware is unknown or omitted', () => {
    expect(vmHandlers.buildDomainXml('v', 'n', 'bogus')).toContain("<rom file='");
    expect(vmHandlers.buildDomainXml('v', 'n', undefined)).toContain("<rom file='");
    expect(vmHandlers.normalizeFirmware('efi')).toBe('efi');
    expect(vmHandlers.normalizeFirmware('bios')).toBe('bios');
    expect(vmHandlers.normalizeFirmware('anything-else')).toBe('bios');
    expect(vmHandlers.normalizeFirmware(undefined)).toBe('bios');
  });
});

describe('vmHandlers.buildDomainXml (with disk)', () => {
  const xml = vmHandlers.buildDomainXml('uponlan-client', 'uponlan', 'bios', '/var/lib/libvirt/images/uponlan-client.qcow2');

  it('attaches the qcow2 as a virtio disk', () => {
    expect(xml).toContain("<disk type='file' device='disk'>");
    expect(xml).toContain("<driver name='qemu' type='qcow2'/>");
    expect(xml).toContain("<source file='/var/lib/libvirt/images/uponlan-client.qcow2'/>");
    expect(xml).toContain("<target dev='vda' bus='virtio'/>");
    expect(xml).toContain("<boot dev='network'/>");
    expect(xml).toContain("<console type='pty'>");
  });
});

describe('vmHandlers.buildNetworkXml', () => {
  const net = vmHandlers.buildNetworkXml('uponlan', '192.168.1.50');

  it('is a NAT PXE network advertising the container-served iPXE ROMs', () => {
    expect(net.startsWith("<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>")).toBe(true);
    expect(net.endsWith('</network>\n')).toBe(true);
    expect(net).toContain('<name>uponlan</name>');
    expect(net).toContain("<forward mode='nat'/>");
    expect(net).toContain("<bridge name='uponlan-br0' stp='on' delay='0'/>");
    expect(net).toContain("<ip address='192.168.7.1' netmask='255.255.255.0'>");
    expect(net).toContain("<range start='192.168.7.128' end='192.168.7.254'/>");
    expect(net).toContain('dhcp-match=set:ipxe-bios,175,33');
    // UEFI firmware (OVMF) gets its bootfile via option 93 (arch 7) — without
    // this it never receives a bootfile and loops on DHCP.
    expect(net).toContain("dhcp-match=set:uefi-fw,93,7");
    expect(net).toContain('dhcp-boot=tag:uefi-fw,rom/ipxe/uponlan.xyz.efi');
    // EDK2/OVMF reads the bootfile from DHCP option 67, not the BOOTP fixed
    // file field.
    expect(net).toContain("dhcp-option=tag:uefi-fw,67,rom/ipxe/uponlan.xyz.efi");
    // No pxe-service/pxe-prompt lines: dnsmasq's PXE processing (only enabled
    // by those) injects option 60 "PXEClient" + option 43 into every offer,
    // which makes EDK2/OVMF abort with PXE-E21 before issuing a TFTP request.
    expect(net).not.toMatch(/pxe-(service|prompt)=/);
    expect(net).not.toContain('vendor:PXEClient,6,2b');
    // dhcp-boot answers carry the boot server IP when provided...
    expect(net).toContain('rom/ipxe/uponlan.xyz.kpxe,,192.168.1.50');
    // ...and fall back to the DHCP server itself when not.
    const noIp = vmHandlers.buildNetworkXml('uponlan', '');
    expect(noIp).not.toContain(',,;');
    expect(noIp).toContain("dhcp-boot=tag:ipxe-bios,rom/ipxe/uponlan.xyz.kpxe");
  });
});