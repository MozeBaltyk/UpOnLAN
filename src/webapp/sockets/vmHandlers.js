// ../sockets/vmHandlers.js
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { mintVncToken } = require('./vncProxy');

// Test VM the Console tab manages (overridable, e.g. VM_NAME=pxetest).
const VM_NAME = process.env.VM_NAME || 'uponlan-client';
// Host network the VM boots PXE from. If it does not exist on the host, the
// webapp defines it from buildNetworkXml().
const VM_NETWORK = process.env.VM_NETWORK || 'uponlan';
// Host IP that serves the iPXE ROMs (nginx in the container, published on the
// host). Used in the network's dhcp-boot answer; empty falls back to the DHCP
// server's own address.
const BOOT_SERVER_IP = process.env.BOOT_SERVER_IP || '';
// Dedicated storage pool for the test VM's disks — created on demand, removed
// with the VM, so UpOnLAN never touches the host's other pools.
const VM_STORAGE_POOL = process.env.VM_STORAGE_POOL || 'uponlan';
const VM_STORAGE_POOL_PATH = process.env.VM_STORAGE_POOL_PATH || '/var/lib/libvirt/images/uponlan';
// Default sizing for the diskless PXE test VM (the UI overrides per-create).
const VM_DEFAULTS = { cpus: 2, memory: 4096 }; // memory in MiB
// Where the generated VNC password is persisted so the webapp can hand it to
// noVNC on later visits (the domain XML stores it too, but only as a one-way
// hash in the running QEMU; this file is the plaintext source of truth).
const VNC_PASSWORD_FILE = (process.env.UPONLAN_CONFIG || '/config') + '/vm-vnc-password';

// Boot-trust drift guardrail: a running VM can outlive a redeploy that
// regenerates the TLS cert and rebuilds the trusted ROMs, leaving it on a stale
// in-memory iPXE session (HTTPS boot then fails 0216eb8f "No usable
// certificates"). We stamp when the managed VM last booted and compare it to the
// cert/ROM mtimes so the operator gets an active "restart me" warning (console
// open + power actions), not just passive status text.
const TLS_CRT = `${process.env.UPONLAN_CONFIG || '/config'}/tls/server.crt`;
const ROM_EFI = `${process.env.UPONLAN_CONFIG || '/config'}/menus/rom/ipxe/uponlan.xyz.efi`;
const VM_BOOT_STAMP = `${process.env.UPONLAN_CONFIG || '/config'}/vm-boot-stamp.json`;
const TRUST_WARNING = 'PXE boot trust may be out of date — restart the VM to reload the current certificate/ROM.';
const TRUST_RELOADED = 'Reloaded boot trust — the previous VM session was on an older certificate/ROM.';

// The VM is UEFI/OVMF only: its network stack fetches rom/ipxe/uponlan.xyz.efi
// directly from the DHCP answer, so no host-side PCI option ROM is involved.
// BIOS was removed — it depended on a stale-prone /usr/lib/ipxe/qemu/uponlan-e1000.rom
// that the container could never refresh.

// Coerce user-supplied VM sizing into safe integers (they flow into the domain
// XML, so anything non-numeric or out of range falls back to a sane default).
function sanitizeVmOpts(opts = {}) {
  const clamp = (n, min, max, fallback) => {
    const v = Number(n);
    return Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  };
  return {
    cpus: clamp(opts.cpus, 1, 32, VM_DEFAULTS.cpus),
    memory: clamp(opts.memory, 512, 65536, VM_DEFAULTS.memory),
    graphics: opts.graphics === true,
  };
}

// 8-char alphanumeric VNC password (classic VNC auth keys on 8 bytes, so a
// hex/random string truncated to 8 is the safe ceiling).
function generateVncPassword() {
  return crypto.randomBytes(4).toString('hex');
}

// virsh subcommands the virsh-safe wrapper allows (restart is a power cycle —
// destroy + start — handled separately below).
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
    const proc = spawn('sudo', ['/usr/local/bin/virsh-safe', ...args]);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }));
    proc.on('error', (e) => resolve({ ok: false, out: '', err: String(e) }));
  });
}

// VNC password persisted at create time (null when the VM is serial-only).
function getVncPassword() {
  try {
    const p = fs.readFileSync(VNC_PASSWORD_FILE, 'utf8').trim();
    return /^[a-zA-Z0-9]{8}$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

// Parse `virsh domdisplay` output into the TCP port. VNC reports a *display
// number* ("vnc://host:0" = port 5900), spice a port. Some libvirt builds emit
// the port directly for VNC, so accept both: values < 5900 are display numbers.
function parseVncPort(domdisplay) {
  const m = /^(?:vnc|spice):\/\/[^:]+:(\d+)$/.exec(domdisplay);
  if (!m) return 0;
  const n = Number(m[1]);
  return n >= 5900 ? n : 5900 + n;
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

function recordVmBootTime() {
  try {
    fs.writeFileSync(VM_BOOT_STAMP, JSON.stringify({ bootedAt: Date.now() }));
  } catch (e) {
    console.warn('Failed to persist VM boot stamp:', e.message);
  }
}

// Trust freshness is derived from the cert + ROM file mtimes (not a persisted
// generation). Both are read independently and a missing side contributes 0, so
// a redeploy that regenerates the cert but leaves ROMs untouched still flags a
// running VM as stale. If mtime proves unreliable (cp -p on deploy, skewed
// clocks), switch to a generation counter written on every cert/ROM change.
function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function isTrustStale() {
  let bootedAt = NaN;
  try {
    bootedAt = Number(JSON.parse(fs.readFileSync(VM_BOOT_STAMP, 'utf8')).bootedAt);
  } catch {
    /* no stamp yet — handled below */
  }
  const trustMs = Math.max(mtimeMs(TLS_CRT), mtimeMs(ROM_EFI));
  if (Number.isFinite(bootedAt)) {
    return trustMs > bootedAt; // nothing bootable yet => trustMs 0 => false
  }
  // No boot stamp: a running VM reaches this only when it booted before tracking
  // existed (or was started outside the webapp), so its boot time is unknown.
  // Assume stale when trust material exists — one restart records a stamp.
  return trustMs > 0;
}

// `virsh pool-info` prints "State: inactive" for a defined-but-not-started
// dir pool; only an active pool accepts vol-create-as.
function isInactivePoolInfo(poolInfoOut) {
  return /State:\s*inactive/i.test(poolInfoOut);
}

// Ensure the dedicated storage pool exists (define + start + autostart).
async function ensureStoragePool() {
  const info = await runVirsh(['pool-info', VM_STORAGE_POOL]);
  if (info.ok) {
    // pool-info succeeds for a defined-but-inactive pool too (e.g. left over
    // after a destroy where pool-undefine failed, or a host reboot before
    // autostart). pool-build (re)creates the target directory (idempotent for
    // a dir pool — succeeds whether the dir already exists or not), then
    // pool-start activates it.
    if (isInactivePoolInfo(info.out)) {
      await runVirsh(['pool-build', VM_STORAGE_POOL]);
      await runVirsh(['pool-start', VM_STORAGE_POOL]);
    }
    return true;
  }
  const defined = await runVirsh(['pool-define-as', VM_STORAGE_POOL, 'dir', '--target', VM_STORAGE_POOL_PATH]);
  if (!defined.ok) return false;
  await runVirsh(['pool-build', VM_STORAGE_POOL]);
  await runVirsh(['pool-start', VM_STORAGE_POOL]);
  await runVirsh(['pool-autostart', VM_STORAGE_POOL]);
  return true;
}

// Tear down the dedicated pool (best-effort; call after deleting the volume).
async function removeStoragePool() {
  await runVirsh(['pool-destroy', VM_STORAGE_POOL]);
  await runVirsh(['pool-undefine', VM_STORAGE_POOL]);
}

// Minimal diskless network-boot domain: it is a PXE client, not a storage
// target, so no disk and (by default) no graphics — serial console only.
// `<boot dev='network'/>` is what makes it actually PXE-boot (virt-install's
// default left the old VM on `hd`). The guest is always UEFI/OVMF: its network
// stack PXE-boots and fetches rom/ipxe/uponlan.xyz.efi from the DHCP answer, so
// no PCI option ROM is attached.
//
// opts.cpus / opts.memory (MiB) / opts.graphics are the per-create knobs; a
// graphics toggle adds a VNC display + VGA video for GUI installers (the webapp
// console itself remains the serial pty).
function buildDomainXml(name, network, diskPath, opts = {}) {
  const { cpus, memory, graphics } = sanitizeVmOpts(opts);
  const nic = `<interface type='network'>
      <source network='${network}'/>
      <model type='virtio'/>
    </interface>`;
  // Optional: attach a qcow2 disk so a PXE install has somewhere to write to.
  const disk = diskPath
    ? `<disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${diskPath}'/>
      <target dev='vda' bus='virtio'/>
    </disk>`
    : '';
  // Optional: graphical console (VNC) for GUI installers, on top of serial.
  // listen='0.0.0.0' so the container can reach QEMU's VNC via the podman
  // bridge (host.containers.internal); the random password (persisted at
  // create time) is what stops the raw VNC port from being open to the LAN.
  const video = graphics
    ? `<graphics type='vnc' port='-1' autoport='yes' listen='0.0.0.0' passwd='${opts.vncPassword || ''}'>
      <listen type='address' address='0.0.0.0'/>
    </graphics>
    <video>
      <model type='vga' heads='1' primary='yes'/>
    </video>`
    : '';
  return `<domain type='kvm'>
  <name>${name}</name>
  <memory unit='MiB'>${memory}</memory>
  <vcpu placement='static'>${cpus}</vcpu>
  <os firmware='efi'>
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
    ${video}
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
    const state = await getVmState();
    const status = { name: VM_NAME, state, hasConsole: await getVmHasConsole() };
    if (state === 'running' && isTrustStale()) {
      status.trustStale = true;
      status.trustMessage = TRUST_WARNING;
    }
    socket.emit('vm:status', status);
  };

  socket.on('vm:status', sendStatus);

  // VNC connection info for the graphical console: the port QEMU bound and the
  // generated password. The browser connects to /novnc/ws (the Node proxy)
  // which forwards to host:port; noVNC does the VNC auth with this password.
  socket.on('vm:vnc:info', async () => {
    const disp = await runVirsh(['domdisplay', VM_NAME]);
    const port = disp.ok ? parseVncPort(disp.out) : 0;
    const password = port > 0 ? getVncPassword() : null;
    socket.emit('vm:vnc:info', { port, password, token: port > 0 ? mintVncToken() : null });
  });

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
      const wasStale = state === 'running' && isTrustStale();
      if (state === 'running') {
        const d = await runVirsh(['destroy', VM_NAME]);
        if (!d.ok) {
          socket.emit('vm:action:result', { action, ok: false, message: d.err });
          sendStatus();
          return;
        }
      }
      const s = await runVirsh(['start', VM_NAME]);
      if (s.ok) recordVmBootTime();
      socket.emit('vm:action:result', {
        action,
        ok: s.ok,
        message: s.ok ? `VM '${VM_NAME}' restarted` : s.err,
        warning: s.ok && wasStale ? TRUST_RELOADED : undefined,
      });
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
      const wasStale = action === 'on' && isTrustStale();
      const res = await runVirsh([virshAction, VM_NAME]);
      if (action === 'on' && res.ok) recordVmBootTime();
      socket.emit('vm:action:result', {
        action,
        ok: res.ok,
        message: res.ok ? res.out : res.err,
        warning: res.ok && wasStale ? TRUST_RELOADED : undefined,
      });
    }
    sendStatus();
  });

  // Provision the test VM from a Node-generated domain XML. No bash script:
  // define + start via the whitelisted virsh subcommands only. If the boot
  // network does not exist on the host it is defined first.
  socket.on('vm:create', async (payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    const spec = sanitizeVmOpts(opts);
    const diskSize = Math.max(0, Number(opts.disk) || 0);
    // Fresh random VNC password per create, persisted so noVNC can read it back.
    if (spec.graphics) {
      spec.vncPassword = generateVncPassword();
      try { fs.writeFileSync(VNC_PASSWORD_FILE, spec.vncPassword); } catch (e) {
        console.warn('Failed to persist VNC password:', e.message);
      }
    }
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
      // Dedicated `uponlan` pool: created on demand, removed with the VM.
      if (!(await ensureStoragePool())) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `storage pool '${VM_STORAGE_POOL}' create failed` });
        return;
      }
      const created = await runVirsh(['vol-create-as', VM_STORAGE_POOL, volName, '--format', 'qcow2', `${diskSize}G`]);
      if (!created.ok) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `disk create failed: ${created.err}` });
        return;
      }
      const pathRes = await runVirsh(['vol-path', '--pool', VM_STORAGE_POOL, volName]);
      diskPath = pathRes.ok ? pathRes.out : null;
      if (!diskPath) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `disk path lookup failed: ${pathRes.err}` });
        return;
      }
    }
    const xmlPath = `/tmp/uponlan-${VM_NAME}.xml`;
    try {
      fs.writeFileSync(xmlPath, buildDomainXml(VM_NAME, VM_NETWORK, diskPath, spec));
      const res = await runVirsh(['define', xmlPath]);
      if (!res.ok) {
        socket.emit('vm:action:result', { action: 'create', ok: false, message: `virsh define failed: ${res.err}` });
        return;
      }
      const boot = await runVirsh(['start', VM_NAME]);
      if (boot.ok) recordVmBootTime();
      socket.emit('vm:action:result', {
        action: 'create',
        ok: boot.ok,
        message: boot.ok
          ? `VM '${VM_NAME}' (${spec.cpus} vCPU, ${spec.memory} MiB RAM${spec.graphics ? ', graphical console' : ', serial console'}${diskSize > 0 ? `, ${diskSize}G disk` : ', diskless'}) created${netCreated ? ` (network '${VM_NETWORK}' recreated)` : ''} and booting (network PXE) — console will show the menu shortly`
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
    // with nvram" and re-create is blocked forever.
    const res = await runVirsh(['undefine', '--nvram', VM_NAME]);
    let msg = res.ok ? `VM '${VM_NAME}' destroyed` : `virsh undefine failed: ${res.err}`;
    if (res.ok) {
      // Remove the disk volume + the dedicated pool it lives in (best-effort:
      // a diskless VM has neither, and the virsh calls then just report
      // "not found").
      await runVirsh(['vol-delete', '--pool', VM_STORAGE_POOL, `${VM_NAME}.qcow2`]);
      await removeStoragePool();
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
    if (isTrustStale()) {
      socket.emit('vm:console:data', `\r\n[warning] ${TRUST_WARNING}\r\n`);
    }

    // `virsh console` refuses to run without a controlling TTY; `script`
    // (util-linux, added in the Containerfile) allocates one. script runs as
    // the unprivileged webapp user and execs the whitelisted
    // `sudo /usr/local/bin/virsh-safe console --force` inside the pty — never `sudo script`, which
    // would let any authed user run arbitrary shell as root. `--force` takes
    // over any stale/cockpit console session (e.g. a zombie left by a power
    // cycle), otherwise the attach fails with "Active console session exists".
    // `detached` makes it a process-group leader so killConsole() can reap the
    // whole chain.
    // `script` (util-linux) silently no-ops its `-c` command when $SHELL is
    // unset — supervisord starts the webapp with a minimal env (no SHELL), so
    // the console attach produced zero output and exited 0. Pin SHELL here.
    const proc = spawn('script', ['-q', '-c', `sudo /usr/local/bin/virsh-safe console --force '${VM_NAME}'`, '/dev/null'], { detached: true, env: { ...process.env, SHELL: process.env.SHELL || '/bin/sh' } });
    activeConsoles.set(VM_NAME, proc);
    proc.stdout.on('data', (d) => socket.emit('vm:console:data', d.toString()));
    proc.stderr.on('data', (d) => socket.emit('vm:console:data', d.toString()));
    proc.on('close', () => {
      // Only act if THIS proc is still the active one. After a restart, the
      // old console process's close can fire after the new one was attached;
      // without this guard it would delete the new session from the map.
      if (activeConsoles.get(VM_NAME) !== proc) return;
      activeConsoles.delete(VM_NAME);
      socket.emit('vm:console:close');
    });
    proc.on('error', (e) => {
      if (activeConsoles.get(VM_NAME) !== proc) return;
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
module.exports.isInactivePoolInfo = isInactivePoolInfo;
module.exports.buildDomainXml = buildDomainXml;
module.exports.buildNetworkXml = buildNetworkXml;
module.exports.sanitizeVmOpts = sanitizeVmOpts;
module.exports.getVncPassword = getVncPassword;
module.exports.parseVncPort = parseVncPort;
module.exports.isTrustStale = isTrustStale;
