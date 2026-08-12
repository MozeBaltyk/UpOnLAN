# Workflow State

## Task
Move ordered Getting Started and PXE Basics guides to the `docs/` root so they are first in the overall webapp documentation menu, then commit and push the completed work.

## Planner
- Scope: move only `01-GettingStarted.md` and `02-PXEBootBasics.md` from `docs/UpOnLAN/` to `docs/`; update references and their focused test.
- Acceptance criteria: guides appear before root-level alphabetical docs, all links resolve, and the requested commit is pushed without including `.codegraph/`.

## Debater
- Avoid recommending boilerplate pages or duplicating generated/reference material.
- Root-level placement is simpler and satisfies the intended overall-menu ordering; keep prefix-hiding support because it produces clean labels.

## Implementor
- Relocated guides are present at `docs/01-GettingStarted.md` and `docs/02-PXEBootBasics.md`; updated Markdown references in `README.md` and `docs/StartHere.md`, plus their moved-doc deployment/operations links to `UpOnLAN/`.
- Confirmed `src/webapp/test/unit/docServices.test.js` covers root-level `01-GettingStarted.md`, hiding its ordering prefix while retaining that exact `__file` path.
- Checks passed: `npm run test:unit -- docServices.test.js` from `src/webapp` (5 files, 25 tests); root command `python3 -c "..."` validated 26 local Markdown links in the changed docs; `git diff --check` (no output).
- Corrected review findings: reordered `docs/StartHere.md` so Getting Started is item 1 and PXE Basics item 2; `src/webapp/services/docServices.js` now removes only a leading `NN-` display-key prefix while preserving `__file`.
- Added the focused `01-GettingStarted.md` display-key/path assertion in `src/webapp/test/unit/docServices.test.js`.
- Checks passed: `npm run test:unit -- docServices.test.js` from `src/webapp` (5 files, 25 tests); `git diff --check` (no output).
- Completed ordered entry-page documentation: renamed `docs/UpOnLAN/GettingStarted.md` to `docs/UpOnLAN/01-GettingStarted.md` and `docs/UpOnLAN/PXEBootBasics.md` to `docs/UpOnLAN/02-PXEBootBasics.md` so they sort first in the UpOnLAN menu.
- Expanded Getting Started with verified prerequisites, build/deploy, webapp menu upgrade, service/PXE observable results, DHCP boundary, and safe next links. Expanded PXE Basics with the workflow diagram, component definitions, scope boundary, firmware note, and trusted-network caution.
- Updated renamed-file links in `README.md` and `docs/StartHere.md`.
- Checks passed: `python3 -c "from pathlib import Path; import re, urllib.parse; pages=[Path('README.md'), Path('docs/StartHere.md'), Path('docs/UpOnLAN/01-GettingStarted.md'), Path('docs/UpOnLAN/02-PXEBootBasics.md')]; missing=[]; checked=0 ... assert not missing, missing ..."` (all 26 modified-page local Markdown links resolved); `git diff --check` (no output).
- Prior documentation refresh, PXE primer, and Start Here navigation complete; ordered entry-page implementation pending.
- Changed: `README.md`; `docs/Assets.md`; `docs/UpOnLAN/GettingStarted.md`; `docs/UpOnLAN/Troubleshoot.md`; added `docs/UpOnLAN/Deployment.md` and `docs/UpOnLAN/Operations.md`.
- Corrected removed `test`/`test-pxeboot` actions, plain-HTTP-only Nginx, in-webapp Ansible builds, and ephemeral `emptyDir` data semantics. Added linked deployment, security, release, CLI, logging, backup, and recovery references.
- Checks: `bash -n wakemeup.sh scripts/release_menu.sh scripts/release_assets.sh` (passed); `python3 -c "from pathlib import Path; paths=['docs/UpOnLAN/Deployment.md','docs/UpOnLAN/Operations.md','docs/UpOnLAN/GettingStarted.md','docs/UpOnLAN/Troubleshoot.md']; [(_ for _ in ()).throw(AssertionError(p)) for p in paths if not Path(p).is_file()]; [(_ for _ in ()).throw(AssertionError(p)) for p in ['docs/UpOnLAN/Deployment.md','docs/UpOnLAN/Operations.md'] if p not in Path('README.md').read_text()]"` (passed); `git diff --check` (passed).
- Inventory: `README.md`, `CHANGELOG.md`, and 11 Markdown files under `docs/` (all are copied into the image at `Containerfile:113` and rendered by `src/webapp/services/docServices.js:7-33`).
- Verified inaccuracies:
  - `README.md:43-45,58-59` advertises `test-pxeboot`; `wakemeup.sh:81-102,108-126,153-165` implements/lists no such action.
  - `docs/UpOnLAN/GettingStarted.md:20` and `docs/UpOnLAN/Troubleshoot.md:40-49` use `test`; no `test` action exists in `wakemeup.sh:153-165`.
  - `docs/Assets.md:24,33` promises local serving “securely” / via HTTPS, but the shipped nginx config only listens on `${NGINX_PORT}` and has no TLS configuration (`src/defaults/default:1-22`); manifests set it to `8080` (`manifests/uponlan.yaml:24-27`).
  - `docs/UpOnLAN/Troubleshoot.md:56-60` says webapp builds require a separate runner container. The application starts `/ansible/build_rom.yml` directly (`src/webapp/services/menuServices.js:29-34`) and the primary image copies Ansible into itself (`Containerfile:120-124`).
  - `docs/UpOnLAN/Troubleshoot.md:76-85` calls storage named volumes and says `destroy` keeps them. Both manifests define `emptyDir` mounts (`manifests/uponlan.yaml:47-59`; local equivalent `:38-50`), while named volumes appear only in optional `run-runner` (`wakemeup.sh:14-20`).
- Prioritized missing documentation: P0 deployment security/auth and plain-HTTP exposure; P0 data persistence/backup and destructive-operation semantics; P1 supported deploy procedure/configuration (remote vs `--local`, ports, host requirements); P1 release procedure/status (workflow and artifact layout); P2 current action reference and changelog/release-note policy; P2 operations runbook for logs/health/recovery.
- Security/operations gaps: no user-facing guidance for `WEBAPP_USER`/`WEBAPP_PASS`, which leaves authentication disabled (`src/webapp/app.js:20-45`); no TLS/reverse-proxy/firewall boundary guidance; no persistence/backup or port-69 privilege/conflict guidance tied to the actual manifests.
- Evidence commands: `git ls-files '*.md' '*.mdx' '*.rst' '*.txt' '*.adoc'`; `bash -n wakemeup.sh scripts/release_menu.sh scripts/release_assets.sh` (passed). No tests applicable.
- Added `docs/StartHere.md`, a beginner-first navigation map; linked it prominently from `README.md`.
- Verified all new Markdown destinations with `python3 -c "from pathlib import Path; import re; page=Path('docs/StartHere.md'); links=re.findall(r'\]\(([^)]+)\)', page.read_text(encoding='utf-8')); missing=[link for link in links if not (page.parent / link.replace('%20', ' ')).is_file()]; assert not missing, missing; assert '[Start Here](docs/StartHere.md)' in Path('README.md').read_text(encoding='utf-8'); print('Start Here links resolve')"` (passed); `git diff --check` (passed).

## Reviewer
- Review found two follow-ups: numeric prefixes ensure order but are currently displayed by `buildTree`; and `StartHere.md` should list Getting Started before PXE Basics.
- Implemented: root-level numbered guides sort before other docs; navigation hides only the leading numeric prefix while retaining the real file path.
- Root placement is correct for the requested overall-menu ordering.

## Tester
- Pending final validation after root-level relocation.
- Root-level relocation validation passed; no docs/source files edited. Ran `npm run test:unit -- docServices.test.js` from `src/webapp`: 5 test files / 25 tests passed (including `test/unit/docServices.test.js`); expected fixture-missing-file stderr and Vite CJS deprecation warning only, exit status 0.
- Ran `python3 -c $'from pathlib import Path ...'` from the repository root to check local Markdown links in `docs/01-GettingStarted.md`, `docs/02-PXEBootBasics.md`, `docs/StartHere.md`, and `README.md`, plus root-doc ordering: passed, `26 local Markdown links resolve; root docs order starts ['01-GettingStarted.md', '02-PXEBootBasics.md']`.
- Start Here-only validation passed; no docs/source files edited. Ran `git diff --check` (passed with no output) and `python3 -c "from pathlib import Path; import re, urllib.parse; page=Path('docs/StartHere.md'); readme=Path('README.md'); text=page.read_text(encoding='utf-8'); links=re.findall(r'(?<!!)\[[^]]*\]\(([^)]+)\)', text); targets=[]; missing=[]; [targets.append(raw) for raw in links];\nfor raw in targets:\n target=raw.strip().split(maxsplit=1)[0].strip('<>'); parsed=urllib.parse.urlsplit(target);\n if not target or target.startswith('#') or parsed.scheme or target.startswith('//'): continue\n path=urllib.parse.unquote(parsed.path)\n if path.lower().endswith('.md') and not (page.parent / path).is_file(): missing.append((raw, str(page.parent / path)))\nassert not missing, 'unresolved local Markdown links: ' + repr(missing)\nassert '[Start Here](docs/StartHere.md)' in readme.read_text(encoding='utf-8'), 'README Start Here link missing'\nprint(f'Start Here assertions passed ({len(targets)} Markdown links checked)')"` (passed; `Start Here assertions passed (15 Markdown links checked)`). Confirmed every local Markdown target resolves and README links `docs/StartHere.md`.
- Final ordered-navigation validation passed; no docs/source files edited. Ran `npm run test:unit -- docServices.test.js` in `src/webapp` (correct package directory identified from `src/webapp/package.json`): passed, 5 test files / 25 tests, including `test/unit/docServices.test.js` (5 tests). Expected fixture-missing-file stderr and Vite CJS deprecation warning were emitted; exit status 0.
- Local-link/order script initially used `git diff --name-only HEAD -- '*.md'`, which included the old rename path `docs/UpOnLAN/GettingStarted.md` and failed with `FileNotFoundError`. Corrected it to `git diff --name-only -M --diff-filter=ACMR HEAD -- '*.md'`; passed: `14 modified-page local Markdown links resolved; UpOnLAN order: ['01-GettingStarted.md', '02-PXEBootBasics.md']`.

## Security Reviewer
- Reviewed the expanded guides: they correctly keep DHCP external, avoid unsafe DHCP commands, and reiterate trusted-network restrictions for boot content.

## Linter
- Root-level relocation lint passed; ran `git diff --check` from the repository root with no output (no whitespace errors).
- Passed: `git diff --check` reported no whitespace errors for the working-tree documentation changes, including the PXE primer.
- Start Here-only lint check: `git diff --check` passed with no output.
- Final lint: `git diff --check` from repository root passed with no output.

## Commit
- Committed documentation navigation updates: `bf2a21d docs: move entry guides to root`.
- Pushed successfully: `git push` created and set upstream `origin/fix/security-hardening` without force.
- Staged intended files only; `.codegraph/` remains untracked and excluded.

## Open Questions
- Intended audiences and supported deployment environments are not yet specified; assess existing public docs as the baseline.
