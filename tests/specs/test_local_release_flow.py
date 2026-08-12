import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path('/home/ubuntu/MozeBaltyk/UpOnLAN')


def write_exe(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class LocalReleaseFlowSpecs(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='uponlan-spec-'))
        (self.tmp / 'scripts').mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / 'wakemeup.sh', self.tmp / 'wakemeup.sh')
        shutil.copy2(REPO_ROOT / 'scripts' / 'release_assets.sh', self.tmp / 'scripts' / 'release_assets.sh')

        (self.tmp / 'release' / 'assets' / 'harvester').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'menus').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'output').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'manifests').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'bin').mkdir(parents=True, exist_ok=True)

        (self.tmp / 'release' / 'assets' / 'harvester' / 'setting.sh').write_text('# spec fixture\n')
        (self.tmp / 'release' / 'menus' / 'version.ipxe').write_text('#!ipxe\nset menu_version 0.0.2\n')
        (self.tmp / 'manifests' / 'uponlan.yaml').write_text('value: "0.0.2"\nhttps://github.com/mozebaltyk/uponlan\n')
        (self.tmp / 'manifests' / 'uponlan-local.yaml').write_text('local manifest\n')

        write_exe(self.tmp / 'bin' / 'python3', '#!/bin/bash\nexit 0\n')
        write_exe(self.tmp / 'bin' / 'sudo', '#!/bin/bash\nexit 0\n')

        write_exe(
            self.tmp / 'release' / 'assets' / 'build.sh',
            textwrap.dedent(
                '''#!/bin/bash
                set -e
                os="$1"
                if [ "$MIRROR_LAYOUT" = "github" ]; then
                  mkdir -p "$OUTPUT_DIR/releases/download/${os}-1.0-x86_64"
                  printf 'asset' > "$OUTPUT_DIR/releases/download/${os}-1.0-x86_64/vmlinuz"
                else
                  mkdir -p "$OUTPUT_DIR/x86_64/$os/1.0/releases/1.0"
                  printf 'asset' > "$OUTPUT_DIR/x86_64/$os/1.0/releases/1.0/vmlinuz"
                fi
                cat > "$OUTPUT_DIR/endpoints.yml" <<'EOF'
                endpoints:
                  harvester-1.0-x86_64:
                    path: /releases/download/harvester-1.0-x86_64/
                    files:
                      - vmlinuz
                EOF
                '''
            ),
        )

        write_exe(
            self.tmp / 'scripts' / 'release_menu_stub.sh',
            textwrap.dedent(
                '''#!/bin/bash
                set -e
                mkdir -p release/output/releases/download/0.0.2
                printf 'menu' > release/output/releases/download/0.0.2/menus.tar.gz
                '''
            ),
        )

        write_exe(
            self.tmp / 'scripts' / 'release_assets_stub.sh',
            textwrap.dedent(
                '''#!/bin/bash
                set -e
                count_file="${COUNT_FILE:?}"
                count=0
                [ -f "$count_file" ] && count=$(cat "$count_file")
                count=$((count + 1))
                printf '%s' "$count" > "$count_file"
                mkdir -p release/output/releases/download/harvester-1.0-x86_64
                mkdir -p release/output/releases
                cat > release/output/endpoints.yml <<'EOF'
                endpoints:
                  harvester-1.0-x86_64:
                    path: /releases/download/harvester-1.0-x86_64/
                    files:
                      - vmlinuz
                EOF
                cat > release/output/releases/latest <<'EOF'
                {"tag_name":"local"}
                EOF
                printf 'asset' > release/output/releases/download/harvester-1.0-x86_64/vmlinuz
                '''
            ),
        )

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_cmd(self, *args, env=None):
        merged = os.environ.copy()
        if env:
            merged.update(env)
        return subprocess.run(args, cwd=self.tmp, env=merged, text=True, capture_output=True, check=True)

    def test_release_assets_keeps_only_github_style_tree(self):
        proc = self.run_cmd('bash', 'scripts/release_assets.sh')
        self.assertTrue((self.tmp / 'release' / 'output' / 'endpoints.yml').is_file())
        self.assertTrue((self.tmp / 'release' / 'output' / 'releases' / 'latest').is_file())
        self.assertIn('Processing harvester', proc.stdout)
        self.assertTrue((self.tmp / 'release' / 'output' / 'releases' / 'download' / 'harvester-1.0-x86_64' / 'vmlinuz').is_file())
        self.assertFalse((self.tmp / 'release' / 'output' / 'x86_64').exists())

    def test_deploy_local_reuses_existing_output(self):
        count_file = self.tmp / 'count.txt'
        mirror = self.tmp / 'release' / 'output' / 'releases' / 'download' / 'harvester-1.0-x86_64'
        mirror.mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'output' / 'releases').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'output' / 'releases' / 'download' / '0.0.2').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'output' / 'x86_64' / 'stale').mkdir(parents=True, exist_ok=True)
        (self.tmp / 'release' / 'output' / 'endpoints.yml').write_text(
            'endpoints:\n  harvester-1.0-x86_64:\n    path: /releases/download/harvester-1.0-x86_64/\n'
        )
        (self.tmp / 'release' / 'output' / 'releases' / 'latest').write_text('{"tag_name":"local"}\n')
        (self.tmp / 'release' / 'output' / 'releases' / 'download' / '0.0.2' / 'menus.tar.gz').write_text('menu')
        (mirror / 'vmlinuz').write_text('asset')

        self.run_cmd(
            'bash', 'wakemeup.sh', '-a', 'deploy', '--local',
            env={
                'PATH': f"{self.tmp / 'bin'}:{os.environ['PATH']}",
                'RELEASE_ASSETS_SCRIPT': 'scripts/release_assets_stub.sh',
                'RELEASE_MENU_SCRIPT': 'scripts/release_menu_stub.sh',
                'COUNT_FILE': str(count_file),
            },
        )

        self.assertFalse(count_file.exists(), 'asset rebuild should not run when mirror already exists')

    def test_deploy_local_requires_existing_asset_output(self):
        proc = subprocess.run(
            ['bash', 'wakemeup.sh', '-a', 'deploy', '--local'],
            cwd=self.tmp,
            env=os.environ.copy(),
            text=True,
            capture_output=True,
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('mirror-assets', proc.stdout + proc.stderr)


if __name__ == '__main__':
    unittest.main()
