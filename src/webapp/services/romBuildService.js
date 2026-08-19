// ROM / boot-media build runner. Replaces the old Ansible build playbook: it
// shells out to scripts/build_ipxe_roms.sh (copied into the image at /scripts),
// streaming progress and logging to /logs/rom. No ansible involved.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BUILD_SCRIPT = '/scripts/build_ipxe_roms.sh';
const CONFIG_ROOT = process.env.UPONLAN_CONFIG || '/config';
// Media-mode output: the TFTP/HTTP ROM root (nginx serves /config/menus/rom at /rom).
const OUT_ROM = path.join(CONFIG_ROOT, 'menus', 'rom', 'ipxe');

// Rough number of `[ipxe] ...` steps the build emits, used only for the
// progress-bar denominator (the make step dominates but emits no step line).
const ESTIMATED_STEPS = 8;

let buildState = null; // { process, pid, startedBy, startTime, promise }

function resetBuildState() {
  buildState = null;
}

async function startBuild(formats, socket, progressCallback) {
  if (buildState && buildState.process) {
    return { success: false, message: `A build is already running (PID ${buildState.pid})` };
  }
  const { process, promise } = await runBuild(formats, socket, progressCallback);

  buildState = {
    process,
    pid: process.pid,
    startedBy: socket.id,
    startTime: new Date(),
    promise,
  };
  promise.finally(resetBuildState);

  return { success: true, message: `Build started (PID ${process.pid})`, pid: process.pid, promise };
}

async function cancelBuild() {
  if (!buildState || !buildState.process || !buildState.promise) {
    return { success: false, message: 'No build in progress' };
  }
  try {
    process.kill(-buildState.process.pid, 'SIGTERM');
    const result = await buildState.promise;
    return result;
  } catch (err) {
    return { success: false, message: `Failed to cancel build: ${err.message}` };
  }
}

function runBuild(formats, socket, progressCallback) {
  const logDir = path.join(process.env.UPONLAN_LOGS || '/logs', 'rom');
  fs.mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `build_${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const args = formats ? [formats] : [];
  const proc = spawn(BUILD_SCRIPT, args, {
    detached: true,
    env: { ...process.env, OUT_ROM },
  });

  const promise = new Promise((resolve, reject) => {
    let step = 0;
    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line) => {
        logStream.write(line + '\n');
        const m = line.match(/^\[ipxe\] (.+)$/);
        if (m) {
          step += 1;
          if (progressCallback) {
            progressCallback({ tasksCompleted: step, taskCount: ESTIMATED_STEPS, currentTask: m[1] });
          }
        }
      });
    });

    proc.stderr.on('data', (data) => {
      logStream.write(data);
    });

    proc.on('close', (code, signal) => {
      logStream.end();
      if (signal === 'SIGTERM') {
        resolve({ success: false, status: 'cancelled', message: 'Build was cancelled by the user.' });
      } else if (code === 0) {
        resolve({ success: true, status: 'success', message: `Build completed successfully. Log: ${logFile}` });
      } else {
        resolve({ success: false, status: 'error', message: `Build failed with code ${code}. See log: ${logFile}` });
      }
    });

    proc.on('error', (err) => {
      logStream.end();
      reject(new Error(`Failed to start build: ${err.message}`));
    });
  });

  return { process: proc, promise };
}

module.exports = { startBuild, cancelBuild };
