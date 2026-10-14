'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { isDeepStrictEqual } = require('util');
const { PUBLIC_PULL_SECRET } = require('./okdPullSecretServices');

const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
const ASSETS_ROOT = process.env.UPONLAN_ASSETS || '/assets';
const PROFILES_ROOT = path.join(CONFIG_ROOT, 'okd', 'profiles');
const TEMPLATE_LIMIT = 256 * 1024;
const PULL_SECRET_PLACEHOLDER = '__UPONLAN_PULL_SECRET__';
const RELEASE = '5.0.0-okd-scos.1';
// Keep release-specific combinations here until a second release justifies compatibility files.
const RELEASE_RECORD = Object.freeze({
  release: RELEASE,
  platforms: { none: ['sno', 'compact', 'standard'], baremetal: ['sno', 'compact', 'standard'] },
  maxWorkers: 20,
  maxHosts: 23,
});
const RELEASE_DIGEST = 'sha256:a5e956045b37dc8c3d2fa78f43b33ae4da38dd99662c7b0deb81151f3359b612';
const RELEASE_BASE_URL = `https://github.com/okd-project/okd/releases/download/${RELEASE}`;
const COMPATIBILITY_RECORD = Object.freeze({
  revision: '5',
  release: RELEASE,
  architecture: 'linux/amd64',
  releaseImage: `quay.io/okd/scos-release@${RELEASE_DIGEST}`,
  releaseDigest: RELEASE_DIGEST,
  releaseMetadataUrl: `${RELEASE_BASE_URL}/release.txt`,
  checksumMetadataUrl: `${RELEASE_BASE_URL}/sha256sum.txt`,
  commands: Object.freeze({
    monitor: Object.freeze(['agent', 'wait-for', 'install-complete', '--dir']),
  }),
  outputs: Object.freeze({
    pxe: Object.freeze({
      kernel: 'agent.x86_64-vmlinuz',
      initrd: 'agent.x86_64-initrd.img',
      rootfs: 'agent.x86_64-rootfs.img',
      ipxe: 'agent.x86_64.ipxe',
    }),
    iso: Object.freeze({ iso: 'agent.x86_64.iso' }),
  }),
  schemas: Object.freeze({
    installConfigApiVersion: 'v1',
    agentConfigApiVersion: 'v1alpha1',
    agentConfigKind: 'AgentConfig',
    controlPlaneRole: 'master',
    baremetalVipFields: Object.freeze({ api: 'apiVIPs', ingress: 'ingressVIPs' }),
  }),
  tools: Object.freeze({
    installer: Object.freeze({
      required: true,
      binary: 'openshift-install',
      archive: `openshift-install-linux-${RELEASE}.tar.gz`,
      archiveSha256: '2b1b15c4df45e77895a7e4c8f3e0f28d9e81cf2b34127a772f6159134e2bff24',
      sourceUrl: `${RELEASE_BASE_URL}/openshift-install-linux-${RELEASE}.tar.gz`,
      maxBytes: 600 * 1024 * 1024,
    }),
    oc: Object.freeze({
      required: true,
      binary: 'oc',
      archive: `openshift-client-linux-${RELEASE}.tar.gz`,
      archiveSha256: '49a71dc4b86c619bbf23e831c86d8e61be6d72b144669b00a819f6c0153e0f3e',
      sourceUrl: `${RELEASE_BASE_URL}/openshift-client-linux-${RELEASE}.tar.gz`,
      maxBytes: 300 * 1024 * 1024,
    }),
  }),
});
const PROFILE_KEYS = new Set(['id', 'release', 'platform', 'topology', 'cluster_name', 'base_domain', 'machine_network', 'rendezvous_ip', 'ssh_public_key', 'worker_count', 'api_vip', 'ingress_vip', 'hosts', 'revision', 'saved_at']);
const HOST_KEYS = new Set(['hostname', 'role', 'mac', 'ipv4', 'interface', 'disk_hint']);
const SECRET_KEY = /secret|password|token|private.?key|credential/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAC = /^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const IFACE = /^[a-zA-Z0-9_.:-]{1,15}$/;
const DISK_HINT = /^(?:wwn:[A-Za-z0-9._:+-]+|serial:[A-Za-z0-9._:+-]+|deviceName:(?:\/dev\/disk\/by-path\/[A-Za-z0-9._:+-]+|\/dev\/(?:[hsv]d[a-z]{1,3}|xvd[a-z]{1,3}|nvme\d{1,3}n\d{1,3}|mmcblk\d{1,3})))$/;
const profileMutations = new Map();

function serializeProfile(id, fn) {
  const key = typeof id === 'string' ? id : '__invalid__';
  const previous = profileMutations.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => {});
  profileMutations.set(key, tail);
  return next.finally(() => { if (profileMutations.get(key) === tail) profileMutations.delete(key); });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeProfile(input) {
  if (!plain(input)) return null;
  const hosts = Array.isArray(input.hosts) ? input.hosts.slice(0, RELEASE_RECORD.maxHosts + 1).map((value) => {
    const host = plain(value) ? value : {};
    return {
      hostname: text(host.hostname),
      role: text(host.role),
      mac: text(host.mac).toLowerCase(),
      ipv4: text(host.ipv4),
      interface: text(host.interface),
      disk_hint: text(host.disk_hint),
    };
  }) : [];
  const profile = {
    id: text(input.id),
    release: text(input.release),
    platform: text(input.platform),
    topology: text(input.topology),
    cluster_name: text(input.cluster_name),
    base_domain: text(input.base_domain),
    machine_network: text(input.machine_network),
    rendezvous_ip: text(input.rendezvous_ip),
    ssh_public_key: text(input.ssh_public_key),
    worker_count: Number.isInteger(input.worker_count) ? input.worker_count : Number(input.worker_count),
    api_vip: text(input.api_vip),
    ingress_vip: text(input.ingress_vip),
    hosts,
  };
  if (typeof input.saved_at === 'string') profile.saved_at = input.saved_at;
  if (typeof input.revision === 'string') profile.revision = input.revision;
  return profile;
}

function ipv4Number(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split('.').map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function parseCidr(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  const ip = ipv4Number(parts[0]);
  if (!/^\d{1,2}$/.test(parts[1] || '')) return null;
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

function inCidr(ip, cidr) {
  const n = ipv4Number(ip);
  return n !== null && cidr && ((n & cidr.mask) >>> 0) === cidr.network;
}

function dnsName(value, multiple) {
  if (typeof value !== 'string' || value.length > 253) return false;
  const labels = value.split('.');
  return (multiple ? labels.length >= 2 : labels.length === 1) && labels.every((label) => DNS_LABEL.test(label));
}

function validateProfile(input) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!plain(input)) return [{ field: 'profile', message: 'Profile must be an object.' }];
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.has(key)) add(key, SECRET_KEY.test(key) ? 'Secret-like fields are not allowed in profiles.' : 'Unknown profile field.');
  }
  if (!Array.isArray(input.hosts)) add('hosts', 'Hosts must be an array.');
  else {
    if (input.hosts.length > RELEASE_RECORD.maxHosts) add('hosts', `At most ${RELEASE_RECORD.maxHosts} hosts are supported in V1.`);
    input.hosts.slice(0, RELEASE_RECORD.maxHosts + 1).forEach((host, i) => {
      if (!plain(host)) add(`hosts.${i}`, 'Host must be an object.');
      else for (const key of Object.keys(host)) {
        if (!HOST_KEYS.has(key)) add(`hosts.${i}.${key}`, SECRET_KEY.test(key) ? 'Secret-like fields are not allowed in hosts.' : 'Unknown host field.');
      }
    });
  }
  const p = sanitizeProfile(input);
  if (!SLUG.test(p.id) || p.id.length > 63) add('id', 'Use a lowercase slug (letters, numbers, and single hyphens).');
  const release = p.release === RELEASE_RECORD.release ? RELEASE_RECORD : null;
  if (!release) add('release', `Select the supported release ${RELEASE}.`);
  if (!release || !Object.hasOwn(release.platforms, p.platform)) add('platform', 'Select a platform supported by this release: none or baremetal.');
  if (!release || !release.platforms[p.platform] || !release.platforms[p.platform].includes(p.topology)) add('topology', 'Select a topology supported by this release and platform.');
  if (!dnsName(p.cluster_name, false)) add('cluster_name', 'Use a lowercase DNS label.');
  if (!dnsName(p.base_domain, true)) add('base_domain', 'Use a lowercase DNS domain such as example.com.');
  const cidr = parseCidr(p.machine_network);
  if (!cidr) add('machine_network', 'Enter a valid IPv4 CIDR such as 192.168.7.0/24.');
  if (ipv4Number(p.rendezvous_ip) === null) add('rendezvous_ip', 'Enter a valid IPv4 address.');
  else if (cidr && !inCidr(p.rendezvous_ip, cidr)) add('rendezvous_ip', 'Rendezvous IP must be inside the machine network.');
  if (!/^(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/]+={0,3}(?: .*)?$/.test(p.ssh_public_key)) {
    add('ssh_public_key', 'Enter an SSH public key (ssh-rsa, ssh-ed25519, or ssh-ecdsa).');
  }
  if (!Number.isInteger(p.worker_count) || p.worker_count < 0) add('worker_count', 'Worker count must be a non-negative integer.');
  if (p.worker_count > RELEASE_RECORD.maxWorkers) add('worker_count', `V1 supports at most ${RELEASE_RECORD.maxWorkers} workers.`);

  const expectedCp = p.topology === 'sno' ? 1 : 3;
  const expectedWorkers = p.topology === 'standard' ? p.worker_count : 0;
  if (p.topology !== 'standard' && p.worker_count !== 0) add('worker_count', 'Worker count must be 0 for sno and compact.');
  if (p.topology === 'standard' && (!Number.isInteger(p.worker_count) || p.worker_count < 1)) add('worker_count', 'Standard topology requires at least one worker.');
  const cp = p.hosts.filter((h) => h.role === 'control-plane').length;
  const workers = p.hosts.filter((h) => h.role === 'worker').length;
  if (cp !== expectedCp || workers !== expectedWorkers || p.hosts.length !== expectedCp + expectedWorkers) {
    add('hosts', `${p.topology || 'Selected'} topology requires ${expectedCp} control-plane and ${expectedWorkers} worker host(s).`);
  }

  const seen = { hostname: new Set(), mac: new Set(), ipv4: new Set() };
  p.hosts.forEach((host, i) => {
    const field = `hosts.${i}`;
    if (!dnsName(host.hostname, false)) add(`${field}.hostname`, 'Use a lowercase DNS label.');
    if (!['control-plane', 'worker'].includes(host.role)) add(`${field}.role`, 'Role must be control-plane or worker.');
    if (!MAC.test(host.mac)) add(`${field}.mac`, 'Enter a colon-separated MAC address.');
    if (ipv4Number(host.ipv4) === null) add(`${field}.ipv4`, 'Enter a valid IPv4 address.');
    else if (cidr && !inCidr(host.ipv4, cidr)) add(`${field}.ipv4`, 'Host IPv4 must be inside the machine network.');
    if (!IFACE.test(host.interface)) add(`${field}.interface`, 'Enter a valid interface name (15 characters maximum).');
    if (!DISK_HINT.test(host.disk_hint)) {
      add(`${field}.disk_hint`, 'Use wwn:<value>, serial:<value>, or deviceName: followed by /dev/disk/by-path/<value> or a whole device such as /dev/vda, /dev/sda, or /dev/nvme0n1.');
    }
    for (const key of ['hostname', 'mac', 'ipv4']) {
      const value = host[key].toLowerCase();
      if (value && seen[key].has(value)) add(`${field}.${key}`, `${key} must be unique.`);
      seen[key].add(value);
    }
  });
  if (!p.hosts.some((host) => host.role === 'control-plane' && host.ipv4 === p.rendezvous_ip)) {
    add('rendezvous_ip', 'Rendezvous IP must belong to a control-plane host.');
  }
  if (p.platform === 'none' && (p.api_vip || p.ingress_vip)) add('platform', 'Platform none does not accept API or ingress VIPs.');
  if (p.platform === 'baremetal') {
    if (ipv4Number(p.api_vip) === null) add('api_vip', 'Baremetal requires a valid API VIP.');
    else if (cidr && !inCidr(p.api_vip, cidr)) add('api_vip', 'API VIP must be inside the machine network.');
    if (ipv4Number(p.ingress_vip) === null) add('ingress_vip', 'Baremetal requires a valid ingress VIP.');
    else if (cidr && !inCidr(p.ingress_vip, cidr)) add('ingress_vip', 'Ingress VIP must be inside the machine network.');
    const used = new Set([p.rendezvous_ip, ...p.hosts.map((host) => host.ipv4)]);
    if (p.api_vip && used.has(p.api_vip)) add('api_vip', 'API VIP must differ from rendezvous and host IPs.');
    if (p.ingress_vip && (used.has(p.ingress_vip) || p.ingress_vip === p.api_vip)) add('ingress_vip', 'Ingress VIP must differ from API, rendezvous, and host IPs.');
  }
  if (cidr) {
    const declared = new Set([p.rendezvous_ip, ...p.hosts.map((host) => host.ipv4)]);
    if (p.platform === 'baremetal') { declared.add(p.api_vip); declared.add(p.ingress_vip); }
    declared.delete('');
    const prefix = Number(p.machine_network.split('/')[1]);
    const total = 2 ** (32 - prefix);
    const capacity = prefix <= 30 ? Math.max(0, total - 2) : total;
    if (declared.size > capacity) add('machine_network', `CIDR has capacity for ${capacity} address(es), fewer than declared.`);
  }
  return errors;
}

function profileFile(id) {
  if (!SLUG.test(id) || id.length > 63) throw Object.assign(new Error('Invalid profile ID.'), { code: 'INVALID_ID' });
  const file = path.resolve(PROFILES_ROOT, id, 'profile.yml');
  if (!file.startsWith(path.resolve(PROFILES_ROOT) + path.sep)) throw Object.assign(new Error('Invalid profile path.'), { code: 'INVALID_ID' });
  return file;
}

function unsafePath(message) {
  return Object.assign(new Error(message), { code: 'UNSAFE_PATH' });
}

async function lstatOrNull(target) {
  try { return await fs.promises.lstat(target); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function guardDirectory(root, dir) {
  const stat = await lstatOrNull(dir);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafePath('Refusing unsafe OKD directory.');
  const rootStat = await lstatOrNull(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw unsafePath('Refusing unsafe OKD root directory.');
  const [realRoot, realDir] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(dir)]);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw unsafePath('OKD directory escapes its storage root.');
  return true;
}

async function guardProfile(id, requireFile = true) {
  const file = profileFile(id);
  const dir = path.dirname(file);
  if (!await guardDirectory(PROFILES_ROOT, dir)) return false;
  const stat = await lstatOrNull(file);
  if (!stat) return !requireFile;
  if (stat.isSymbolicLink() || !stat.isFile()) throw unsafePath('Refusing unsafe OKD profile file.');
  return true;
}

function rootDeviceHint(value) {
  const split = value.indexOf(':');
  const type = value.slice(0, split);
  return { [type === 'serial' ? 'serialNumber' : type]: value.slice(split + 1) };
}

function renderConfigs(profile, pullSecret = PUBLIC_PULL_SECRET, record = COMPATIBILITY_RECORD) {
  const schema = record.schemas;
  const install = {
    apiVersion: schema.installConfigApiVersion,
    baseDomain: profile.base_domain,
    metadata: { name: profile.cluster_name },
    compute: [{ architecture: 'amd64', hyperthreading: 'Enabled', name: 'worker', replicas: profile.worker_count }],
    controlPlane: { architecture: 'amd64', hyperthreading: 'Enabled', name: 'master', replicas: profile.topology === 'sno' ? 1 : 3 },
    networking: { machineNetwork: [{ cidr: profile.machine_network }], networkType: 'OVNKubernetes' },
    platform: profile.platform === 'none' ? { none: {} } : { baremetal: {
      [schema.baremetalVipFields.api]: [profile.api_vip], [schema.baremetalVipFields.ingress]: [profile.ingress_vip],
    } },
    publish: 'External', pullSecret, sshKey: profile.ssh_public_key,
  };
  const agent = {
    apiVersion: schema.agentConfigApiVersion, kind: schema.agentConfigKind,
    metadata: { name: profile.cluster_name }, rendezvousIP: profile.rendezvous_ip,
    hosts: profile.hosts.map((host) => ({
      hostname: host.hostname, role: host.role === 'control-plane' ? schema.controlPlaneRole : host.role,
      interfaces: [{ name: host.interface, macAddress: host.mac }], rootDeviceHints: rootDeviceHint(host.disk_hint),
    })),
  };
  const options = { noRefs: true, lineWidth: -1, sortKeys: false };
  return { installConfig: yaml.dump(install, options), agentConfig: yaml.dump(agent, options) };
}

function validateTemplate(name, content) {
  if (typeof content !== 'string') throw Object.assign(new Error(`${name} must be text.`), { code: 'BAD_REQUEST' });
  if (!content.length || Buffer.byteLength(content) > TEMPLATE_LIMIT) throw Object.assign(new Error(`${name} is empty or exceeds 256 KiB.`), { code: 'TEMPLATE_INVALID' });
  let value;
  try { value = yaml.load(content, { schema: yaml.JSON_SCHEMA }); }
  catch { throw Object.assign(new Error(`${name} is malformed YAML.`), { code: 'TEMPLATE_INVALID' }); }
  if (!plain(value) || typeof value.apiVersion !== 'string' || !plain(value.metadata)) {
    throw Object.assign(new Error(`${name} must be a YAML object with apiVersion and metadata.`), { code: 'TEMPLATE_INVALID' });
  }
  if (name === 'install-config.yaml' && ![PUBLIC_PULL_SECRET, PULL_SECRET_PLACEHOLDER].includes(value.pullSecret)) {
    throw Object.assign(new Error('install-config.yaml pullSecret must remain the public fallback or legacy placeholder. Manage custom credentials in Edit → Pull Secret, not YAML.'), { code: 'TEMPLATE_INVALID' });
  }
  if (name === 'agent-config.yaml' && typeof value.kind !== 'string') {
    throw Object.assign(new Error('agent-config.yaml must include kind.'), { code: 'TEMPLATE_INVALID' });
  }
  return value;
}

function effectiveRevision(profile, templates) {
  const content = { ...profile }; delete content.revision; delete content.saved_at;
  return crypto.createHash('sha256').update(JSON.stringify(content)).update('\0').update(templates.installConfig).update('\0').update(templates.agentConfig).digest('hex');
}

function effectiveContext(profile, templates) {
  const install = validateTemplate('install-config.yaml', templates.installConfig);
  const agent = validateTemplate('agent-config.yaml', templates.agentConfig);
  const generated = renderConfigs(profile);
  const expectedInstall = yaml.load(generated.installConfig, { schema: yaml.JSON_SCHEMA });
  const expectedAgent = yaml.load(generated.agentConfig, { schema: yaml.JSON_SCHEMA });
  const reject = (field) => { throw Object.assign(new Error(`Safety-critical YAML field ${field} must match the profile. Change it in the form and Save; supplemental NMState/mirror settings remain editable.`), { code: 'TEMPLATE_INVALID' }); };
  for (const key of Object.keys(install)) if (!Object.hasOwn(expectedInstall, key) && !['additionalTrustBundle', 'imageContentSources', 'imageDigestSources', 'imageTagSources', 'proxy'].includes(key)) reject(`install.${key}`);
  for (const key of ['apiVersion', 'metadata', 'baseDomain', 'compute', 'controlPlane', 'networking', 'platform', 'publish', 'sshKey']) {
    if (!isDeepStrictEqual(install[key], expectedInstall[key])) reject(`install.${key}`);
  }
  for (const key of ['apiVersion', 'kind', 'metadata', 'rendezvousIP']) {
    if (!isDeepStrictEqual(agent[key], expectedAgent[key])) reject(`agent.${key}`);
  }
  for (const key of Object.keys(agent)) if (!Object.hasOwn(expectedAgent, key) && key !== 'additionalNTPSources') reject(`agent.${key}`);
  if (agent.bootArtifactsBaseURL !== undefined) reject('agent.bootArtifactsBaseURL (job-managed)');
  if (!Array.isArray(agent.hosts) || agent.hosts.length !== expectedAgent.hosts.length) reject('agent.hosts');
  agent.hosts.forEach((host, i) => {
    if (!plain(host)) reject(`agent.hosts.${i}`);
    for (const key of Object.keys(host)) if (!['hostname', 'role', 'interfaces', 'rootDeviceHints', 'networkConfig'].includes(key)) reject(`agent.hosts.${i}.${key}`);
    for (const key of ['hostname', 'role', 'interfaces', 'rootDeviceHints']) {
      if (!isDeepStrictEqual(host[key], expectedAgent.hosts[i][key])) reject(`agent.hosts.${i}.${key}`);
    }
    if (host.networkConfig !== undefined && !plain(host.networkConfig)) reject(`agent.hosts.${i}.networkConfig`);
  });
  return { clusterName: install.metadata.name, baseDomain: install.baseDomain, topology: profile.topology,
    hosts: agent.hosts.map((host) => ({ hostname: host.hostname, role: host.role, rootDeviceHints: host.rootDeviceHints })) };
}

function legacyRevision(profile) {
  const content = { ...profile }; delete content.revision; delete content.saved_at;
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

async function writeProfileFiles(dir, writes, removeDirOnFailure = false) {
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const entries = writes.map(([target, content]) => ({
    target, content,
    temp: path.join(dir, `.${path.basename(target)}.tmp-${suffix}`),
    backup: path.join(dir, `.${path.basename(target)}.bak-${suffix}`),
  }));
  const backedUp = []; const promoted = [];
  let cleanupBackups = false;
  try {
    await Promise.all(entries.map((entry) => fs.promises.writeFile(entry.temp, entry.content, { flag: 'wx', mode: 0o600 })));
    for (const entry of entries) {
      if (await lstatOrNull(entry.target)) { await fs.promises.rename(entry.target, entry.backup); backedUp.push(entry); }
    }
    for (const entry of entries) { await fs.promises.rename(entry.temp, entry.target); promoted.push(entry); }
    cleanupBackups = true;
  } catch (err) {
    try {
      for (const entry of promoted.reverse()) await fs.promises.rm(entry.target, { force: true });
      for (const entry of backedUp.reverse()) await fs.promises.rename(entry.backup, entry.target);
      cleanupBackups = true;
      if (removeDirOnFailure) await fs.promises.rm(dir, { recursive: true, force: true });
    } catch { /* retain backups for manual recovery rather than deleting the last good copy */ }
    throw err;
  } finally {
    await Promise.all(entries.map((entry) => fs.promises.rm(entry.temp, { force: true })));
    if (cleanupBackups) await Promise.all(entries.map((entry) => fs.promises.rm(entry.backup, { force: true })));
  }
}

async function readTemplateFile(id, name) {
  const dir = path.dirname(profileFile(id));
  if (!await guardProfile(id)) throw Object.assign(new Error('Profile not found.'), { code: 'NOT_FOUND' });
  const file = path.join(dir, name);
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > TEMPLATE_LIMIT) throw unsafePath(`Refusing unsafe ${name}.`);
    await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } catch (err) {
    if (err.code === 'ELOOP') throw unsafePath(`Refusing unsafe ${name}.`);
    throw err;
  } finally { if (handle) await handle.close(); }
}

async function readTemplates(id) {
  const [installConfig, agentConfig] = await Promise.all([
    readTemplateFile(id, 'install-config.yaml'), readTemplateFile(id, 'agent-config.yaml'),
  ]);
  validateTemplate('install-config.yaml', installConfig); validateTemplate('agent-config.yaml', agentConfig);
  return { installConfig, agentConfig };
}

async function getProfileUnlocked(id) {
  let value;
  try {
    if (!await guardProfile(id)) throw Object.assign(new Error('Profile not found.'), { code: 'NOT_FOUND' });
    value = yaml.load(await fs.promises.readFile(profileFile(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw Object.assign(new Error('Profile not found.'), { code: 'NOT_FOUND' });
    throw err;
  }
  const profile = sanitizeProfile(value);
  const errors = validateProfile(value);
  if (!profile || profile.id !== id) errors.push({ field: 'id', message: 'Stored profile ID does not match its directory.' });
  if (!profile || typeof profile.saved_at !== 'string' || Number.isNaN(Date.parse(profile.saved_at))) errors.push({ field: 'saved_at', message: 'Stored profile timestamp is invalid.' });
  const dir = path.dirname(profileFile(id));
  const [installStat, agentStat] = await Promise.all([
    lstatOrNull(path.join(dir, 'install-config.yaml')), lstatOrNull(path.join(dir, 'agent-config.yaml')),
  ]);
  if (!installStat && !agentStat) {
    if (!profile || !/^[a-f0-9]{64}$/.test(profile.revision || '') || profile.revision !== legacyRevision(profile)) errors.push({ field: 'revision', message: 'Stored legacy profile revision is invalid.' });
    if (errors.length) throw Object.assign(new Error('Stored profile is invalid.'), { code: 'INVALID_PROFILE', errors });
    const templates = renderConfigs(profile);
    profile.revision = effectiveRevision(profile, templates); profile.saved_at = new Date().toISOString();
    await writeProfileFiles(dir, [
      [path.join(dir, 'install-config.yaml'), templates.installConfig],
      [path.join(dir, 'agent-config.yaml'), templates.agentConfig],
      [profileFile(id), yaml.dump(profile, { noRefs: true })],
    ]);
    return profile;
  }
  let templates;
  try {
    if (!installStat || !agentStat) throw Object.assign(new Error('Profile templates are incomplete.'), { code: 'TEMPLATE_INVALID' });
    templates = await readTemplates(id);
    effectiveContext(profile, templates);
  } catch (err) {
    if (err.code === 'UNSAFE_PATH') throw err;
    errors.push({ field: 'templates', message: 'Stored profile templates are invalid.' });
  }
  if (!profile || !templates || !/^[a-f0-9]{64}$/.test(profile.revision || '') || profile.revision !== effectiveRevision(profile, templates)) errors.push({ field: 'revision', message: 'Stored profile revision is invalid.' });
  if (errors.length) throw Object.assign(new Error('Stored profile is invalid.'), { code: 'INVALID_PROFILE', errors });
  return profile;
}

function getProfile(id) { return serializeProfile(id, () => getProfileUnlocked(id)); }

async function listProfiles() {
  let ids;
  try { ids = await fs.promises.readdir(PROFILES_ROOT); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const profiles = [];
  for (const id of ids.sort()) {
    if (!SLUG.test(id)) continue;
    try { profiles.push(await getProfile(id)); } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err;
    }
  }
  return profiles;
}

async function saveProfileUnlocked(input, existingId = null, expectedRevision = null) {
  if (existingId !== null && (!SLUG.test(existingId) || !plain(input) || input.id !== existingId)) {
    throw Object.assign(new Error('Profile ID cannot be changed.'), { code: 'IMMUTABLE_ID', errors: [{ field: 'id', message: 'Profile ID cannot be changed.' }] });
  }
  const errors = validateProfile(input);
  if (errors.length) throw Object.assign(new Error('Profile validation failed.'), { code: 'VALIDATION', errors });
  const profile = sanitizeProfile(input);
  delete profile.saved_at;
  delete profile.revision;
  const templates = renderConfigs(profile);
  profile.revision = effectiveRevision(profile, templates);
  profile.saved_at = new Date().toISOString();
  const file = profileFile(profile.id);
  await fs.promises.mkdir(PROFILES_ROOT, { recursive: true });
  if ((await fs.promises.lstat(PROFILES_ROOT)).isSymbolicLink()) throw unsafePath('Refusing unsafe OKD root directory.');
  const dir = path.dirname(file);
  const exists = await guardDirectory(PROFILES_ROOT, dir);
  if (existingId === null) {
    if (exists) throw Object.assign(new Error('Profile ID already exists.'), { code: 'ALREADY_EXISTS', errors: [{ field: 'id', message: 'Choose a different profile ID.' }] });
    try { await fs.promises.mkdir(dir); } catch (err) {
      if (err.code === 'EEXIST') throw Object.assign(new Error('Profile ID already exists.'), { code: 'ALREADY_EXISTS' });
      throw err;
    }
    await guardDirectory(PROFILES_ROOT, dir);
  } else {
    if (!exists || !await guardProfile(existingId)) throw Object.assign(new Error('Profile not found.'), { code: 'NOT_FOUND' });
    const current = await getProfileUnlocked(existingId);
    if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) {
      throw Object.assign(new Error('Profile changed since it was loaded. Reload it before saving.'), { code: 'STALE_REVISION' });
    }
  }
  const writes = [
    [path.join(dir, 'install-config.yaml'), templates.installConfig],
    [path.join(dir, 'agent-config.yaml'), templates.agentConfig],
    [file, yaml.dump(profile, { noRefs: true })],
  ];
  await writeProfileFiles(dir, writes, existingId === null);
  return profile;
}

function saveProfile(input, existingId = null, expectedRevision = null) {
  return serializeProfile(existingId === null && plain(input) ? input.id : existingId, () => saveProfileUnlocked(input, existingId, expectedRevision));
}

async function getTemplatesUnlocked(id, expectedRevision = null) {
  const profile = await getProfileUnlocked(id);
  if (expectedRevision !== null && expectedRevision !== profile.revision) throw Object.assign(new Error('Profile templates changed since they were loaded.'), { code: 'STALE_REVISION' });
  return { ...(await readTemplates(id)), revision: profile.revision };
}

function getTemplates(id, expectedRevision = null) {
  return serializeProfile(id, () => getTemplatesUnlocked(id, expectedRevision));
}

async function saveTemplatesUnlocked(id, expectedRevision, installConfig, agentConfig) {
  const profile = await getProfileUnlocked(id);
  if (typeof expectedRevision !== 'string' || expectedRevision !== profile.revision) throw Object.assign(new Error('Profile templates changed since they were loaded.'), { code: 'STALE_REVISION' });
  validateTemplate('install-config.yaml', installConfig); validateTemplate('agent-config.yaml', agentConfig);
  const templates = { installConfig, agentConfig };
  effectiveContext(profile, templates);
  profile.revision = effectiveRevision(profile, templates); profile.saved_at = new Date().toISOString();
  const dir = path.dirname(profileFile(id));
  const writes = [[path.join(dir, 'install-config.yaml'), installConfig], [path.join(dir, 'agent-config.yaml'), agentConfig], [profileFile(id), yaml.dump(profile, { noRefs: true })]];
  await writeProfileFiles(dir, writes);
  return { ...templates, revision: profile.revision, savedAt: profile.saved_at };
}

function saveTemplates(id, expectedRevision, installConfig, agentConfig) {
  return serializeProfile(id, () => saveTemplatesUnlocked(id, expectedRevision, installConfig, agentConfig));
}

async function deleteProfileUnlocked(id, isProfileActive) {
  const file = profileFile(id);
  if (!await guardProfile(id)) throw Object.assign(new Error('Profile not found.'), { code: 'NOT_FOUND' });
  if (isProfileActive()) throw Object.assign(new Error('Cancel or wait for the active generation job before deleting this profile.'), { code: 'PROFILE_ACTIVE' });
  const artifacts = path.resolve(ASSETS_ROOT, 'okd', id);
  if (!artifacts.startsWith(path.resolve(ASSETS_ROOT, 'okd') + path.sep)) throw Object.assign(new Error('Invalid artifact path.'), { code: 'INVALID_ID' });
  try {
    if (await guardDirectory(path.resolve(ASSETS_ROOT, 'okd'), artifacts) && (await fs.promises.readdir(artifacts)).length) {
      throw Object.assign(new Error('Delete artifact versions before deleting this profile.'), { code: 'HAS_ARTIFACTS' });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.promises.rm(path.dirname(file), { recursive: true });
  return { id };
}

function deleteProfile(id, isProfileActive = () => false) {
  return serializeProfile(id, () => deleteProfileUnlocked(id, isProfileActive));
}

module.exports = {
  RELEASE, RELEASE_RECORD, COMPATIBILITY_RECORD, PULL_SECRET_PLACEHOLDER,
  sanitizeProfile, validateProfile, renderConfigs, effectiveContext, listProfiles, getProfile, saveProfile, getTemplates, saveTemplates, deleteProfile,
};
