// ./routes/baseRoutes.js
const express = require('express');
const path = require('path');
const router = express.Router();

router.get("/", (req, res) => {
  res.render('index', { baseurl: process.env.SUBFOLDER || '/' });
});

router.get("/uponlanxyz-web.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.render('uponlanxyz-web', { baseurl: process.env.SUBFOLDER || '/' });
});

module.exports = router;