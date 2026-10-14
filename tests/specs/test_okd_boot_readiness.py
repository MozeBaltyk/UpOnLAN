"""Deterministic local HTTPS coverage for the read-only OKD readiness verifier."""
import hashlib
import http.server
import json
import importlib.util
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tests.specs.helpers import REPO_ROOT

SPEC = importlib.util.spec_from_file_location("okd_readiness", REPO_ROOT / "scripts" / "verify_okd_boot_readiness.py")
READINESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READINESS)


PROFILE = "lab-okd"
VERSION = "12345678-1234-1234-1234-123456789abc"
ROM_NAMES = sorted((
    "uponlan.xyz.kpxe", "uponlan.xyz.dsk", "uponlan.xyz.pdsk", "uponlan.xyz.lkrn",
    "uponlan.xyz-undionly.kpxe", "uponlan.xyz.efi", "uponlan.xyz-snp.efi", "uponlan.xyz-snponly.efi",
))


def file_entry(role, path):
    data = path.read_bytes()
    return {"role": role, "name": path.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class ReadinessSpecs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("openssl"):
            raise unittest.SkipTest("openssl is required")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.config = self.root / "config"
        self.version_dir = self.assets / "okd" / PROFILE / VERSION
        self.version_dir.mkdir(parents=True)
        certs = self.root / "certs"
        certs.mkdir()
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Readiness Test CA", "-keyout", str(certs / "ca.key"), "-out", str(certs / "ca.crt")], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", str(certs / "server.key"), "-out", str(certs / "server.csr")], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (certs / "ext.cnf").write_text("subjectAltName=DNS:localhost\n")
        subprocess.run(["openssl", "x509", "-req", "-in", str(certs / "server.csr"), "-CA", str(certs / "ca.crt"), "-CAkey", str(certs / "ca.key"), "-CAcreateserial", "-days", "1", "-extfile", str(certs / "ext.cnf"), "-out", str(certs / "server.crt")], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ca = certs / "ca.crt"

        handler = lambda *a, **kw: QuietHandler(*a, directory=str(self.assets), **kw)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certs / "server.crt", certs / "server.key")
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"https://localhost:{self.server.server_port}/"
        self._stage_valid_tree()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def _stage_valid_tree(self):
        for name, content in (("kernel", b"kernel"), ("initrd", b"initrd"), ("rootfs", b"rootfs")):
            (self.version_dir / name).write_bytes(content)
        boot = ("#!ipxe\n"
                f"kernel {self.base}okd/{PROFILE}/{VERSION}/kernel coreos.live.rootfs_url={self.base}okd/{PROFILE}/{VERSION}/rootfs\n"
                f"initrd {self.base}okd/{PROFILE}/{VERSION}/initrd\nboot\n")
        (self.version_dir / "boot.ipxe").write_text(boot)
        files = [file_entry(role, self.version_dir / ("boot.ipxe" if role == "ipxe" else role)) for role in ("kernel", "initrd", "rootfs", "ipxe")]
        manifest = {
            "schemaVersion": 1, "profileId": PROFILE, "profileRevision": "a" * 64,
            "jobId": VERSION, "versionId": VERSION, "mode": "pxe", "release": "test",
            "releaseImage": "test@sha256:" + "b" * 64, "releaseDigest": "sha256:" + "b" * 64,
            "compatibilityRevision": "1", "installer": {"archiveSha256": "c" * 64, "binarySha256": "d" * 64},
            "files": files, "createdAt": "2026-01-01T00:00:00.000Z",
        }
        (self.version_dir / "manifest.json").write_text(json.dumps(manifest))
        publications = self.config / "okd" / "publications"
        publications.mkdir(parents=True)
        (publications / f"{PROFILE}.json").write_text(json.dumps({"profileId": PROFILE, "versionId": VERSION, "activatedAt": "2026-01-01T00:00:00Z"}))
        rom_dir = self.config / "menus" / "rom" / "ipxe"
        rom_dir.mkdir(parents=True)
        rom_files = []
        for name in ROM_NAMES:
            path = rom_dir / name
            path.write_bytes(("ROM:" + name).encode())
            entry = file_entry("unused", path)
            entry.pop("role")
            rom_files.append(entry)
        trust_hash = hashlib.sha256(self.ca.read_bytes()).hexdigest()
        (rom_dir / "build-manifest.json").write_text(json.dumps({"schemaVersion": 1, "ipxeVersion": "1.21.1", "builtAt": "2026-01-01T00:00:00Z", "trustSha256": trust_hash, "files": rom_files}))

    def run_verifier(self):
        return subprocess.run([
            str(REPO_ROOT / "scripts" / "verify_okd_boot_readiness.py"),
            "--base-url", self.base, "--profile", PROFILE, "--version", VERSION,
            "--ca", str(self.ca), "--assets-root", str(self.assets), "--config-root", str(self.config),
            "--rom-trust-file", str(self.ca),
        ], text=True, capture_output=True)

    def test_success_reports_automated_boundary_and_manual_gaps(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AUTOMATED READINESS PASSED", result.stdout)
        self.assertIn("Physical BIOS/UEFI boot and Agent initramfs trust remain unverified", result.stdout)

    def test_accepts_native_named_initrd_and_rejects_missing_binding_or_duplicate(self):
        boot = self.version_dir / "boot.ipxe"
        original = boot.read_text()
        named = original.replace("initrd https://", "initrd --name initrd https://").replace(" coreos.live.rootfs_url=", " initrd=initrd coreos.live.rootfs_url=")
        manifest_path = self.version_dir / "manifest.json"
        for content, valid in ((named, True), (named.replace(" initrd=initrd", ""), False), (named + "initrd --name initrd https://extra.invalid/initrd\n", False)):
            with self.subTest(valid=valid, duplicate=content.count("\ninitrd") > 1):
                boot.write_text(content)
                manifest = json.loads(manifest_path.read_text())
                manifest["files"] = [file_entry(entry["role"], self.version_dir / entry["name"]) if entry["role"] == "ipxe" else entry for entry in manifest["files"]]
                manifest_path.write_text(json.dumps(manifest))
                result = self.run_verifier()
                self.assertEqual(result.returncode == 0, valid, result.stderr)
                if not valid:
                    self.assertIn("invalid initrd naming or command count", result.stderr)

    def test_rejects_non_active_requested_version(self):
        pointer = self.config / "okd" / "publications" / f"{PROFILE}.json"
        data = json.loads(pointer.read_text())
        data["versionId"] = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        pointer.write_text(json.dumps(data))
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not the active pointer", result.stderr)

    def test_rejects_mutable_boot_reference(self):
        boot = self.version_dir / "boot.ipxe"
        boot.write_text(boot.read_text().replace(f"/{VERSION}/kernel", "/active/kernel"))
        manifest_path = self.version_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"] = [file_entry(entry["role"], self.version_dir / entry["name"]) if entry["role"] == "ipxe" else entry for entry in manifest["files"]]
        manifest_path.write_text(json.dumps(manifest))
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("immutable HTTPS kernel reference", result.stderr)

    def test_rejects_incomplete_rom_set(self):
        manifest_path = self.config / "menus" / "rom" / "ipxe" / "build-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"].pop()
        manifest_path.write_text(json.dumps(manifest))
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("complete BIOS+UEFI set", result.stderr)

    def test_local_hash_rejects_symlinks(self):
        target = self.root / "target"
        target.write_bytes(b"secret")
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaises(READINESS.ReadinessError):
            READINESS.hash_file(link)


class FetchBoundsSpecs(unittest.TestCase):
    class Response:
        def __init__(self, chunks, delay=0):
            self.chunks = iter(chunks)
            self.delay = delay
            self.headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def geturl(self):
            return "https://pxe.example.com/artifact"

        def read(self, _size):
            if self.delay:
                time.sleep(self.delay)
            return next(self.chunks, b"")

    class Opener:
        def __init__(self, response):
            self.response = response

        def open(self, _url, timeout):
            if timeout <= 0:
                raise AssertionError("non-positive timeout")
            return self.response

    def test_stream_aborts_as_soon_as_expected_size_is_exceeded(self):
        opener = self.Opener(self.Response([b"abcd", b""]))
        with self.assertRaisesRegex(READINESS.ReadinessError, "exceeds expected size"):
            READINESS.fetch_hash(opener, "https://pxe.example.com/artifact", 3, time.monotonic() + 1)

    def test_slow_stream_obeys_total_deadline(self):
        opener = self.Opener(self.Response([b"a", b"b", b""], delay=0.02))
        with self.assertRaisesRegex(READINESS.ReadinessError, "deadline"):
            READINESS.fetch_hash(opener, "https://pxe.example.com/artifact", 3, time.monotonic() + 0.005)


if __name__ == "__main__":
    unittest.main()
