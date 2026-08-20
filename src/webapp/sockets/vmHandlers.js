// ../sockets/vmHandlers.js
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

// Test VM the Console tab manages (overridable, e.g. VM_NAME=pxetest).
const VM_NAME = process.env.VM_NAME || 'uponlan-client';
// Host network the VM boots PXE from. If it does not exist on the host, the
// webapp defines it from buildNetworkXml().
const VM_NETWORK = process.env.VM_NETWORK || 'uponlan';
// Host IP that serves the iPXE ROMs (nginx in the container, published on the
// host). Used in the network's dhcp-boot answer; empty falls back to the DHCP
// server's own address.
const BOOT_SERVER_IP = process.env.BOOT_SERVER_IP || '';
// Host-side file QEMU loads as the NIC's option ROM. Without it the e1000 has
// no PXE ROM on Ubuntu hosts (qemu no longer bundles one) and the guest never
// attempts network boot. Built by scripts/build_ipxe_roms.sh.
const PXE_ROM = process.env.PXE_ROM || '/usr/lib/ipxe/qemu/uponlan-e1000.rom';
// Firmware used for VMs created via the UI (overrideable per-create). BIOS
// boots iPXE through the e1000 PCI option ROM above; UEFI/OVMF uses its own
// network stack and fetches rom/ipxe/uponlan.xyz.efi from the DHCP answer.
const VM_FIRMWARE = process.env.VM_FIRMWARE || 'bios';

// Guard: firmware flows into the XML but only ever takes two values.
function normalizeFirmware(firmware) {
  return firmware === 'efi' ? 'efi' : 'bios';
}

// virsh subcommands the container sudoers whitelist allows (restart is a
// power cycle — destroy + start — handled separately below).
const POWER_ACTIONS = { on: 'start', off: 'destroy' };

// `virsh console` is exclusive per domain; keep one attachment per VM so a
// second tab doesn't fight the first. Map: VM name -> child process.
const activeConsoles = new Map();

// Guard: VM names flow into `sudo virsh` argv, so only allow safe identifiers.
function isValidVmName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name) && name.length <= 64;
}

function runVirsh(args) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const proc = spawn('sudo', ['virsh', ...args]);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
    proc.on('error', (e) => resolve({ ok: false, out: '', err: String(e) }));
  });
}

async function getVmState() {
  if (!isValidVmName(VM_NAME)) return 'invalid';
  const res = await runVirsh(['domstate', VM_NAME]);
  if (!res.ok) {
    const msg = res.err.toLowerCase();
    // libvirt variants: "error: Domain not found" / "failed to get domain 'x'"
    return msg.includes('not found') || msg.includes('failed to get domain') ? 'not found' : 'unknown';
  }
  return res.out;
}

// Whether the domain XML declares a pty serial console (`virsh console` target).
async function getVmHasConsole() {
  const res = await runVirsh(['dumpxml', VM_NAME]);
  return res.ok && /<console[^>]*type=['"]pty['"]/.test(res.out);
}

// Minimal diskless network-boot domain: it is a PXE client, not a storage
// target, so no disk, no graphics. `<boot dev='network'/>` is what makes it
// actually PXE-boot (virt-install's default left the old VM on `hd`).
//
// firmware 'bios' (default): SeaBIOS -> custom e1000 PCI option ROM
//   (uponlan-e1000.rom, built by scripts/build_ipxe_roms.sh) -> full iPXE.
//   The PCI option-ROM mechanism only applies to legacy BIOS, so the
//   `<rom file>` element is emitted for BIOS only.
// firmware 'efi': UEFI/OVMF. OVMF's built-in network stack performs PXE and
//   loads the bootloader the DHCP answer advertises (rom/ipxe/uponlan.xyz.efi),
//   so no PCI option ROM is attached. `<os firmware='efi'>` makes libvirt
//   pick OVMF and manage the NVRAM automatically.
function buildDomainXml(name, network, firmware, diskPath) {
  const fw = normalizeFirmware(firmware);
  const osTag = fw === 'efi' ? "<os firmware='efi'>" : '<os>';
  const nic = fw === 'efi'
    ? `<interface type='network'>
      <source network='${network}'/>
      <model type='e1000'/>
    </interface>`
    : `<interface type='network'>
      <source network='${network}'/>
      <model type='e1000'/>
      <rom file='${PXE_ROM}'/>
    </interface>`;
  // Optional: attach a qcow2 disk so a PXE install has somewhere to write to.
  const disk = diskPath
    ? `<disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${diskPath}'/>
      <target dev='vda' bus='virtio'/>
    </disk>`
    : '';
  return `<domain type='kvm'>
  <name>${name}</name>
  <memory unit='KiB'>2097152</memory>
  <vcpu placement='static'>2</vcpu>
  ${osTag}
    <type arch='x86_64'>hvm</type>
    <boot dev='network'/>
  </os>
  <features>
    <acpi/>
  </features>
  <cpu mode='host-passthrough' check='none'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    ${nic}
    ${disk}
    <serial type='pty'>
      <target type='isa-serial' port='0'>
        <model name='isa-serial'/>
      </target>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
  </devices>
</domain>
`;
}

// NAT+PXE network: dnsmasq advertises the container-served iPXE ROMs to the
// guest.
function buildNetworkXml(name, bootServerIp) {
  const bootIp = bootServerIp ? `,,${bootServerIp}` : '';
  return `<network xmlns:dnsmasq='http://libvirt.org/schemas/network/dnsmasq/1.0'>
  <name>${name}</name>
  <forward mode='nat'/>
  <bridge name='${name}-br0' stp='on' delay='0'/>
  <domain name="test"/>
  <ip address='192.168.7.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.7.128' end='192.168.7.254'/>
    </dhcp>
  </ip>
  <dnsmasq:options>
    <dnsmasq:option value='dhcp-no-override'/>
    <dnsmasq:option value='dhcp-match=set:ipxe-bios,175,33'/>
    <dnsmasq:option value='dhcp-match=set:ipxe-efi,175,36'/>
    <!-- UEFI/OVMF firmware is not iPXE: it matches on option 93 (client arch 7 =
         x86-64 UEFI). It gets the bootfile via dhcp-boot/option 67 below.
         NOTE: no pxe-service/pxe-prompt lines — dnsmasq's PXE processing
         (triggered only by those) injects option 60 "PXEClient" + option 43 into
         every offer, which makes EDK2/OVMF abort with PXE-E21 before any TFTP.
         dhcp-boot tags cover every client here (iPXE BIOS/EFI and UEFI firmware). -->
    <dnsmasq:option value='dhcp-match=set:uefi-fw,93,7'/>
    <dnsmasq:option value='dhcp-boot=tag:uefi-fw,rom/ipxe/uponlan.xyz.efi${bootIp}'/>
    <!-- EDK2/OVMF reads the bootfile from DHCP option 67, not the BOOTP fixed
         file field; without it the PXE driver never issues the TFTP request. -->
    <dnsmasq:option value='dhcp-option=tag:uefi-fw,67,rom/ipxe/uponlan.xyz.efi'/>
    <dnsmasq:option value='dhcp-boot=tag:ipxe-bios,rom/ipxe/uponlan.xyz.kpxe${bootIp}'/>
    <dnsmasq:option value='dhcp-boot=tag:ipxe-efi,rom/ipxe/uponlan.xyz.efi${bootIp}'/>
  </dnsmasq:options>
</network>
`;
}

module.exports = function registerVmHandlers(socket) {
  const sendStatus = async () => {
    socket.emit('vm:status', { name: VM_NAME, state: await getVmState(), hasConsole: await getVmHasConsole() });
  };

  socket.on('vm:status', sendStatus);

  socket.on('vm:power', async (action) => {
    // 'restart' is a power cycle: destroy (if running) then start. The guest
    // boots into the iPXE menu, where there is no OS to ACPI-reboot, so a clean
    // destroy+start is the reliable restart; on a stopped VM it just powers on.
    if (action === 'restart') {
      const state = await getVmState();
      if (state === 'not found') {
        socket.emit('vm:action:result', { action, ok: false, message: `VM '${VM_NAME}' is not defined on the host` });
        sendStatus();
        return;
      }
      if (state === 'running') {
        const d = await runVirsh(['destroy', VM_NAME]);
        if (!d.ok) {
          socket.emit('vm:action:result', { action, ok: false, message: d.err });
          sendStatus();
          return;
        }
      }
      const s = await runVirsh(['start', VM_NAME]);
      socket.emit('vm:action:result', { action, ok: s.ok, message: s.ok ? `VM '${VM_NAME}' restarted` : s.err });
      sendStatus();
      return;
    }

    const virshAction = POWER_ACTIONS[action];
    if (!virshAction) {
      socket.emit('vm:action:result', { action, ok: false, message: `Unknown action: ${action}` });
      return;
    }
    const state = await getVmState();
    if (action === 'on' && state === 'running') {
      socket.emit('vm:action:result', { action, ok: true, message: `VM '${VM_NAME}' is already running` });
    } else if (action !== 'on' && state !== 'running') {
      socket.emit('vm:action:result', { action, ok: false, message: `VM '${VM_NAME}' is not running (${state})` });
    } else {
      const res = await runVirsh([virshAction, VM_NAME]);
      socket.emit('vm:action:result', { action, ok: res.ok, message: res.ok ? res.out : res.err });
    }
    sendStatus();
  });

  // Provision the test VM from a Node-generated domain XML. No bash script:
  // define + start via the whitelisted virsh subcommands only. If the boot
  // network does not exist on the host it is defined first.
  socket.on('vm:create', async (payload) => {
    const opts = typeof payload === 'string' ? { firmware: payload } : (payload || {});
    const fw = normalizeFirmware(opts.firmware);
    const diskSize = Math.max(0, Number(opts.disk) || 0);
    const state = await getVmState();
    if (state !== 'not found') {
      socket.emit('vm:action:result', { action: 'create', ok: false, message: `VM '${VM_NAME}' already exists (${state})` });
      return;
    }
    let netCreated = false;
    const net = await runVirsh(['net-info', VM_NETWORK]);
    if (!net.ok) {
      const netXmlPath = `/tmp/uponlan-net-${VM_NETWORK}.xml`;
      try {
        fs.writeFileSync(netXmlPath, buildNetworkXml(VM_NETWORK, BOOT_SERVER_IP));
        const defined = await runVirsh(['net-define', netXmlPath]);
        if (!defined.ok) {
          socket.emit('vm:action:result', { action: 'create', ok: false, message: `network define failed: ${defined.err}` });
          return;
        }
        netCreated = true;
        await runVirsh(['net-start', VM_NETWORK]);
        await runVirsh(['net-autostart', VM_NETWORK]);
      } catch (e) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `network create failed: ${e.message}` });
        return;
      } finally {
        try { fs.unlinkSync(netXmlPath); } catch { /* already gone */ }
      }
    }
    // Create the requested disk as a qcow2 volume (diskless when size = 0).
    const volName = `${VM_NAME}.qcow2`;
    let diskPath = null;
    if (diskSize > 0) {
      const created = await runVirsh(['vol-create-as', 'default', volName, '--format', 'qcow2', `${diskSize}G`]);
      if (!created.ok) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `disk create failed: ${created.err}` });
        return;
      }
      const pathRes = await runVirsh(['vol-path', '--pool', 'default', volName]);
      diskPath = pathRes.ok ? pathRes.out : null;
      if (!diskPath) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `disk path lookup failed: ${pathRes.err}` });
        return;
      }
    }
    const xmlPath = `/tmp/uponlan-${VM_NAME}.xml`;
    try {
      fs.writeFileSync(xmlPath, buildDomainXml(VM_NAME, VM_NETWORK, fw, diskPath));
      const res = await runVirsh(['define', xmlPath]);
      if (!res.ok) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `virsh define failed: ${res.err}` });
        return;
      }
      const boot = await runVirsh(['start', VM_NAME]);
      socket.emit('vm:action:result', {
        action: 'create',
        ok: boot.ok,
        message: boot.ok
          ? `VM '${VM_NAME}' (${fw} firmware${diskSize > 0 ? `, ${diskSize}G disk` : ', diskless'}) created${netCreated ? ` (network '${VM_NETWORK}' recreated)` : ''} and booting (network PXE) — console will show the menu shortly`
          : `VM defined but start failed: ${boot.err}`,
      });
    } catch (e) {
      socket.emit('vm:action:result', { action: 'create', ok: false, message: `create failed: ${e.message}` });
    } finally {
      try { fs.unlinkSync(xmlPath); } catch { /* already gone */ }
    }
    sendStatus();
  });

  // Permanently remove the VM (definition; it is diskless so nothing to clean)
  // and the boot network it uses.
  socket.on('vm:destroy', async () => {
    const state = await getVmState();
    if (state === 'not found') {
      socket.emit('vm:action:result', { action: 'destroy', ok: false, message: `VM '${VM_NAME}' does not exist` });
      return;
    }
    if (state === 'running') await runVirsh(['destroy', VM_NAME]);
    // --nvram: a UEFI/OVMF guest leaves /var/lib/libvirt/qemu/nvram/<name>_VARS.fd
    // behind; without it, `virsh undefine` fails with "cannot undefine domain
    // with nvram" and re-create is blocked forever. Harmless for BIOS guests.
    const res = await runVirsh(['undefine', '--nvram', VM_NAME]);
    let msg = res.ok ? `VM '${VM_NAME}' destroyed` : `virsh undefine failed: ${res.err}`;
    if (res.ok) {
      // Best-effort disk cleanup — a diskless VM has no volume, so vol-delete
      // reports "not found" and we ignore it.
      await runVirsh(['vol-delete', '--pool', 'default', `${VM_NAME}.qcow2`]);
      // Tear the boot network down too (user request). Best-effort: other
      // guests may still be attached, then net-destroy reports it.
      const nd = await runVirsh(['net-destroy', VM_NETWORK]);
      await runVirsh(['net-undefine', VM_NETWORK]);
      msg += nd.ok ? `; network '${VM_NETWORK}' removed` : `; network '${VM_NETWORK}' left in place (${nd.err})`;
    }
    socket.emit('vm:action:result', { action: 'destroy', ok: res.ok, message: msg });
    sendStatus();
  });

  // Serial console --------------------------------------------------------
  // Terminate the console for a VM: the process group (`script` spawns
  // sh -> sudo -> virsh console), not just the `script` PID — SIGTERM to
  // `script` alone leaves virsh holding the libvirt console session. Resolves
  // once the session is released (or a timeout).
  function killConsole(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const proc = activeConsoles.get(VM_NAME);
      if (!proc) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = setTimeout(finish, timeoutMs);
      proc.once('close', finish);
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { finish(); } }
    });
  }

  socket.on('vm:console:stop', killConsole);
  socket.on('disconnect', killConsole);

  socket.on('vm:console:start', async () => {
    // A stale console from a previous visit may still be detaching (navigate
    // away/back quickly). Wait for it to release before attaching again.
    if (activeConsoles.has(VM_NAME)) await killConsole();

    const state = await getVmState();
    if (state !== 'running') {
      socket.emit('vm:console:data', `\r\n[VM '${VM_NAME}' is not running (${state}) — power it on first]\r\n`);
      return;
    }

    // `virsh console` refuses to run without a controlling TTY; `script`
    // (util-linux, added in the Containerfile) allocates one. script runs as
    // the unprivileged webapp user and execs the whitelisted
    // `sudo virsh console --force` inside the pty — never `sudo script`, which
    // would let any authed user run arbitrary shell as root. `--force` takes
    // over any stale/cockpit console session (e.g. a zombie left by a power
    // cycle), otherwise the attach fails with "Active console session exists".
    // `detached` makes it a process-group leader so killConsole() can reap the
    // whole chain.
    // `script` (util-linux) silently no-ops its `-c` command when $SHELL is
    // unset — supervisord starts the webapp with a minimal env (no SHELL), so
    // the console attach produced zero output and exited 0. Pin SHELL here.
    const proc = spawn('script', ['-q', '-c', `sudo virsh console --force '${VM_NAME}'`, '/dev/null'], { detached: true, env: { ...process.env, SHELL: process.env.SHELL || '/bin/sh' } });
    activeConsoles.set(VM_NAME, proc);
    proc.stdout.on('data', (d) => socket.emit('vm:console:data', d.toString()));
    proc.stderr.on('data', (d) => socket.emit('vm:console:data', d.toString()));
    proc.on('close', () => {
      activeConsoles.delete(VM_NAME);
      socket.emit('vm:console:close');
    });
    proc.on('error', (e) => {
      activeConsoles.delete(VM_NAME);
      socket.emit('vm:console:data', `\r\n[virsh console failed: ${e.message}]\r\n`);
    });
  });

  socket.on('vm:console:input', (data) => {
    const proc = activeConsoles.get(VM_NAME);
    if (proc && proc.stdin.writable) proc.stdin.write(data);
  });
};

module.exports.isValidVmName = isValidVmName;
module.exports.buildDomainXml = buildDomainXml;
module.exports.buildNetworkXml = buildNetworkXml;
module.exports.normalizeFirmware = normalizeFirmware;