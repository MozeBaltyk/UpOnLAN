const fs = require('fs');
const path = require('path');
const { downloader } = require('./utilServices');

async function dlremote(dlfiles, callback, io, socket) {
  var dlarray = [];
  for (var i in dlfiles){
    var dlfile = dlfiles[i];
    var dlpath = '/assets' + path.dirname(dlfile);
    // Make destination directory
    fs.mkdirSync(dlpath, { recursive: true });
    // Construct array for use in download function
    var url = 'https://github.com/netbootxyz' + dlfile;
    dlarray.push({'url':url,'path':dlpath});
  }
  await downloader(dlarray, io, socket);
  callback(null, 'done');
}

module.exports = {
  dlremote,
};