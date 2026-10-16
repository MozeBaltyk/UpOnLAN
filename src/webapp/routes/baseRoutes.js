// ./routes/baseRoutes.js
'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const { pipeline } = require('stream/promises');
const operations = require('../services/okdOperationsServices');
const okd = require('../services/okdServices');

// Mounted behind the application's existing global authentication policy.
router.get('/okd/:profile/:release/:version/iso', async (req, res) => {
  let iso;
  try { iso = await require('../services/okdArtifactServices').openIso(req.params.profile, req.params.release, req.params.version); }
  catch { res.status(404).type('text').send('ISO not found.'); return; }
  try {
    if (res.destroyed) return;
    let start = 0; let end = iso.size - 1;
    const ranges = req.headers['if-range'] ? undefined : req.range(iso.size, { combine: true });
    if (ranges === -1) { res.status(416).set('Content-Range', `bytes */${iso.size}`).end(); return; }
    if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
      ({ start, end } = ranges[0]); res.status(206).set('Content-Range', `bytes ${start}-${end}/${iso.size}`);
    }
    res.set({ 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${iso.name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) });
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(iso.handle.createReadStream({ start, end, autoClose: false }), res);
  } catch { if (!res.destroyed) res.destroy(); }
  finally { await iso.handle.close().catch(() => {}); }
});

// Existing UUID-named finalized ISO media remains readable but is never rewritten.
router.get('/okd/:profile/:version/iso', async (req, res) => {
  let iso;
  try { iso = await require('../services/okdArtifactServices').openIso(req.params.profile, req.params.version); }
  catch { res.status(404).type('text').send('ISO not found.'); return; }
  try {
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(iso.size),
      'Content-Disposition': `attachment; filename="${iso.name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(iso.handle.createReadStream({ autoClose: false }), res);
  } catch { if (!res.destroyed) res.destroy(); }
  finally { await iso.handle.close().catch(() => {}); }
});

router.get('/okd/:profile/:release/:version/pxe.tar.gz', async (req, res) => {
  let bundle;
  try { bundle = await require('../services/okdArtifactServices').openPxeBundle(req.params.profile, req.params.release, req.params.version); }
  catch { res.status(404).type('text').send('PXE bundle not found.'); return; }
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${bundle.name}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  try {
    await pipeline(bundle.stream, res);
    await operations.audit('bundle.export', 'succeeded', { profileId: req.params.profile, release: req.params.release, versionId: req.params.version, mode: 'pxe' }).catch(() => {});
  } catch { if (!res.destroyed) res.destroy(); }
});

router.get("/", (req, res) => {
  res.render('index', { baseurl: req.app.locals.baseurl });
});

router.get("/uponlanxyz-web.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.render('uponlanxyz-web', { baseurl: req.app.locals.baseurl, okdRelease: okd.RELEASE, okdMaxWorkers: okd.RELEASE_RECORD.maxWorkers });
});

module.exports = router;
