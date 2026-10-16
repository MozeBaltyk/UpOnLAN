'use strict';
const fs = require('fs');
const path = require('path');

// Linux runtime: anchor every component to an open directory, not a checked path
// which could be replaced before open(). Never follow symlinks, including parents.
async function openRegular(file) {
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  let parent = await fs.promises.open('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  let handle;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await fs.promises.open(`/proc/self/fd/${parent.fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      await parent.close(); parent = next;
    }
    handle = await fs.promises.open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe file');
    return { handle, stat };
  } catch (err) { if (handle) await handle.close(); throw err; }
  finally { await parent.close(); }
}

async function readBounded(file, limit) {
  const { handle, stat } = await openRegular(file);
  try {
    if (stat.size < 1 || stat.size > limit) throw new Error('Invalid file size');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Invalid file size');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
module.exports = { openRegular, readBounded };
