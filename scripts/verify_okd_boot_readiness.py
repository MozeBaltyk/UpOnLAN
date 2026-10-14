#!/usr/bin/env python3
"""Read-only structural/TLS/integrity checks before manual OKD Agent boot acceptance."""
import argparse
import hashlib
import json
import os
import re
import socket
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
VERSION = re.compile(r"^[0-9a-f-]{16,64}$")
ROM_NAMES = sorted((
    "uponlan.xyz.kpxe", "uponlan.xyz.dsk", "uponlan.xyz.pdsk",
    "uponlan.xyz.lkrn", "uponlan.xyz-undionly.kpxe",
    "uponlan.xyz.efi", "uponlan.xyz-snp.efi", "uponlan.xyz-snponly.efi",
))
MAX_JSON_BYTES = 1024 * 1024
MAX_BOOT_BYTES = 1024 * 1024
REMOTE_TOTAL_SECONDS = 60


class ReadinessError(Exception):
    pass


def read_safe(path, label, max_bytes, expected_size=None):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > max_bytes or (expected_size is not None and st.st_size != expected_size):
            raise ReadinessError(f"{label} is not a safe regular file")
        chunks, remaining = [], st.st_size
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                raise ReadinessError(f"{label} changed while being read")
            chunks.append(chunk)
            remaining -= len(chunk)
        return st, b"".join(chunks)
    except OSError as exc:
        raise ReadinessError(f"cannot read {label}: {exc}") from exc
    finally:
        if fd is not None:
            os.close(fd)


def load_json(path, label):
    try:
        return json.loads(read_safe(path, label, MAX_JSON_BYTES)[1].decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ReadinessError(f"cannot read {label}: {exc}") from exc


def hash_file(path, expected_size=None, capture=False, max_bytes=None):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size < 1 or (expected_size is not None and st.st_size != expected_size) or (max_bytes is not None and st.st_size > max_bytes):
            raise ReadinessError(f"unsafe or empty file: {path.name}")
        digest, chunks = hashlib.sha256(), []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            if capture:
                chunks.append(chunk)
        result = (st.st_size, digest.hexdigest())
        return result + (b"".join(chunks),) if capture else result
    except OSError as exc:
        raise ReadinessError(f"cannot hash {path.name}: {exc}") from exc
    finally:
        if fd is not None:
            os.close(fd)


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        parsed = urllib.parse.urlsplit(target)
        if (parsed.scheme, parsed.netloc) != self.origin or parsed.username or parsed.password:
            raise ReadinessError(f"unsafe redirect to {target}")
        return super().redirect_request(req, fp, code, msg, headers, target)


def fetch_hash(opener, url, expected_size, deadline):
    digest, size = hashlib.sha256(), 0
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReadinessError("HTTPS verification deadline exceeded")
        with opener.open(url, timeout=min(20, remaining)) as response:
            final = urllib.parse.urlsplit(response.geturl())
            if final.scheme != "https":
                raise ReadinessError(f"HTTPS downgrade while fetching {url}")
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.isdigit() or int(declared) > expected_size):
                raise ReadinessError(f"served artifact exceeds expected size: {url}")
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReadinessError("HTTPS verification deadline exceeded")
                sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                if sock is not None:
                    sock.settimeout(min(5, remaining))
                chunk = response.read(min(1024 * 1024, expected_size - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_size:
                    raise ReadinessError(f"served artifact exceeds expected size: {url}")
                digest.update(chunk)
    except (OSError, urllib.error.URLError) as exc:
        raise ReadinessError(f"HTTPS fetch failed for {url}: {exc}") from exc
    return size, digest.hexdigest()


def require_keys(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ReadinessError(f"{label} has an invalid schema")


def verify(args):
    base = urllib.parse.urlsplit(args.base_url)
    if base.scheme != "https" or not base.hostname or base.username or base.password or base.path not in ("", "/") or base.query or base.fragment:
        raise ReadinessError("base URL must be a credential-free HTTPS origin")
    if not SLUG.fullmatch(args.profile) or not VERSION.fullmatch(args.version):
        raise ReadinessError("profile or version ID is invalid")

    assets, config = Path(args.assets_root), Path(args.config_root)
    pointer = load_json(config / "okd" / "publications" / f"{args.profile}.json", "active pointer")
    require_keys(pointer, ("profileId", "versionId", "activatedAt"), "active pointer")
    if pointer["profileId"] != args.profile or pointer["versionId"] != args.version:
        raise ReadinessError("requested version is not the active pointer")

    version_dir = assets / "okd" / args.profile / args.version
    manifest = load_json(version_dir / "manifest.json", "artifact manifest")
    require_keys(manifest, ("schemaVersion", "profileId", "profileRevision", "jobId", "versionId", "mode", "release", "releaseImage", "releaseDigest", "compatibilityRevision", "installer", "files", "createdAt"), "artifact manifest")
    if manifest["schemaVersion"] != 1 or manifest["profileId"] != args.profile or manifest["versionId"] != args.version or manifest["jobId"] != args.version or manifest["mode"] != "pxe":
        raise ReadinessError("artifact manifest does not identify the active PXE version")
    files = manifest.get("files")
    expected_roles = {"kernel", "initrd", "rootfs", "ipxe"}
    if not isinstance(files, list) or {entry.get("role") for entry in files if isinstance(entry, dict)} != expected_roles or len(files) != 4:
        raise ReadinessError("artifact manifest does not contain the exact PXE file roles")
    by_role, boot_bytes = {}, None
    for entry in files:
        require_keys(entry, ("role", "name", "size", "sha256"), "artifact file entry")
        if not re.fullmatch(r"[A-Za-z0-9._-]+", entry["name"]) or not isinstance(entry["size"], int) or entry["size"] < 1 or not SHA256.fullmatch(entry["sha256"]):
            raise ReadinessError("artifact file entry is invalid")
        capture = entry["role"] == "ipxe"
        actual = hash_file(version_dir / entry["name"], entry["size"], capture, MAX_BOOT_BYTES if capture else None)
        if actual[:2] != (entry["size"], entry["sha256"]):
            raise ReadinessError(f"local artifact hash/size mismatch: {entry['name']}")
        if capture:
            boot_bytes = actual[2]
        by_role[entry["role"]] = entry
    if len({entry["name"] for entry in files}) != 4:
        raise ReadinessError("artifact manifest reuses a filename across PXE roles")

    immutable = args.base_url.rstrip("/") + f"/okd/{args.profile}/{args.version}/"
    try:
        boot = boot_bytes.decode("utf-8")
    except UnicodeError as exc:
        raise ReadinessError(f"cannot read boot.ipxe: {exc}") from exc
    refs = {
        "kernel": re.findall(r"^\s*kernel\s+(\S+)", boot, re.MULTILINE),
        "initrd": re.findall(r"^\s*initrd\s+(?:--name initrd\s+)?(\S+)\s*$", boot, re.MULTILINE),
        "rootfs": re.findall(r"(?:^|\s)coreos\.live\.rootfs_url=(\S+)", boot, re.MULTILINE),
    }
    if len(re.findall(r"^\s*initrd\s+", boot, re.MULTILINE)) != 1 or (
        "--name initrd" in boot and not re.search(r"\sinitrd=initrd(?:\s|$)", boot)
    ):
        raise ReadinessError("boot.ipxe has invalid initrd naming or command count")
    for role in ("kernel", "initrd", "rootfs"):
        wanted = immutable + by_role[role]["name"]
        if refs[role] != [wanted]:
            raise ReadinessError(f"boot.ipxe does not contain exactly one immutable HTTPS {role} reference")
        tokens = re.findall(rf"(?:coreos\.live\.rootfs_url=)?https?://[^\s'\"\\]*{re.escape(by_role[role]['name'])}[^\s'\"\\]*", boot)
        allowed = [wanted] if role != "rootfs" else [f"coreos.live.rootfs_url={wanted}"]
        if any(token not in allowed for token in tokens):
            raise ReadinessError(f"boot.ipxe contains a stale or mutable {role} reference")

    context = ssl.create_default_context(cafile=args.ca)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    deadline = time.monotonic() + REMOTE_TOTAL_SECONDS
    with socket.create_connection((base.hostname, base.port or 443), timeout=min(20, deadline - time.monotonic())) as raw:
        with context.wrap_socket(raw, server_hostname=base.hostname):
            pass
    origin = (base.scheme, base.netloc)
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), SameOriginRedirect(origin))
    for entry in files:
        served = fetch_hash(opener, immutable + entry["name"], entry["size"], deadline)
        if served != (entry["size"], entry["sha256"]):
            raise ReadinessError(f"served artifact hash/size mismatch: {entry['name']}")

    rom_dir = config / "menus" / "rom" / "ipxe"
    rom_manifest = load_json(rom_dir / "build-manifest.json", "ROM manifest")
    require_keys(rom_manifest, ("schemaVersion", "ipxeVersion", "builtAt", "trustSha256", "files"), "ROM manifest")
    entries = rom_manifest.get("files")
    if rom_manifest["schemaVersion"] != 1 or rom_manifest["ipxeVersion"] != "1.21.1" or not isinstance(rom_manifest["builtAt"], str) or not isinstance(entries, list) or [entry.get("name") for entry in entries if isinstance(entry, dict)] != ROM_NAMES:
        raise ReadinessError("ROM manifest does not contain the complete BIOS+UEFI set")
    trust_hash = hash_file(Path(args.rom_trust_file))[1]
    if rom_manifest["trustSha256"] != trust_hash:
        raise ReadinessError("ROM manifest trust hash does not match the ROM trust file")
    for entry in entries:
        require_keys(entry, ("name", "size", "sha256"), "ROM file entry")
        if not isinstance(entry["size"], int) or entry["size"] < 1 or not SHA256.fullmatch(entry.get("sha256", "")):
            raise ReadinessError("ROM file entry is invalid")
        if hash_file(rom_dir / entry["name"]) != (entry["size"], entry["sha256"]):
            raise ReadinessError(f"ROM hash/size mismatch: {entry['name']}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--ca", required=True)
    parser.add_argument("--assets-root", required=True)
    parser.add_argument("--config-root", required=True)
    parser.add_argument("--rom-trust-file", required=True)
    return parser.parse_args(argv)


def main(argv=None):
    try:
        verify(parse_args(argv))
    except (ReadinessError, ssl.SSLError, OSError, ValueError) as exc:
        print(f"AUTOMATED READINESS FAILED: {exc}", file=sys.stderr)
        return 1
    print("AUTOMATED READINESS PASSED")
    print("Physical BIOS/UEFI boot and Agent initramfs trust remain unverified and require manual acceptance.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
