// uponlan.xyz
// Main Node.js app

var baseurl = process.env.SUBFOLDER || '/';
var app = require('express')();
var { DownloaderHelper } = require('node-downloader-helper');
var exec = require('child_process').exec;
var express = require('express');
var fs = require('fs');
var http = require('http').Server(app);
var io = require('socket.io')(http, {path: baseurl + 'socket.io'});
var isBinaryFile = require("isbinaryfile").isBinaryFile;
var path = require('path');
var readdirp = require('readdirp');
var fetch = require('node-fetch');
var urlLib = require('url');

const allowedHosts = [
  's3.amazonaws.com'
];
var si = require('systeminformation');
const util = require('util');
var { version } = require('./package.json');
var yaml = require('js-yaml');
var baserouter = express.Router();
let ejs = require('ejs');

// Disable sigs on every startup in remote boot.cfg
disablesigs();
function disablesigs(){
  var bootcfgr = '/config/menus/remote/boot.cfg';
  var bootcfgl = '/config/menus/local/boot.cfg';
  var bootcfgm = '/config/menus/boot.cfg';
  if (fs.existsSync(bootcfgr) && ! fs.existsSync(bootcfgl)) {
    var data = fs.readFileSync(bootcfgr, 'utf8');
    var disable = data.replace(/set sigs_enabled true/g, 'set sigs_enabled false');
    fs.writeFileSync(bootcfgr, disable, 'utf8');
    fs.writeFileSync(bootcfgm, disable, 'utf8');
  }
}

// set menu version from menuversion.txt
let menuversion = '';
if (fs.existsSync('/config/menuversion.txt')) {
  menuversion = fs.readFileSync('/config/menuversion.txt', 'utf8');
} else {
  menuversion = 'none'; // or ''
}
// set menu origin from menuorigin.txt
let menuorigin = '';
if (fs.existsSync('/config/menuorigin.txt')) {
  menuorigin = fs.readFileSync('/config/menuorigin.txt', 'utf8');
} else {
  menuorigin = 'none'; // or ''
}

// Set endpoint url from ENDPOINT_URL env variable
const isValidUrl = urlString=> {
       var urlPattern = new RegExp('^(https?:\\/\\/)?'+ // validate protocol
     '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+ // validate domain name
     '((\\d{1,3}\\.){3}\\d{1,3}))'+ // validate OR ip (v4) address
     '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+ // validate port and path
     '(\\?[;&a-z\\d%_.~+=-]*)?'+ // validate query string
     '(\\#[-a-z\\d_]*)?$','i'); // validate fragment locator
   return !!urlPattern.test(urlString);
 }

const defaultEndpointUrl = "https://github.com/mozebaltyk/uponlan";
let endpoint_url = process.env.ENDPOINT_URL;

if (!endpoint_url || !isValidUrl(endpoint_url)) {
  console.warn(`Invalid URL "${endpoint_url}" in environment variable ENDPOINT_URL. Using default URL ${defaultEndpointUrl} instead.`);
  endpoint_url = defaultEndpointUrl;
}

// Define API and raw URLs based on endpoint_url
let api_url, raw_url;

if (endpoint_url.includes("github.com")) {
  // For GitHub, construct API and raw URLs
  const match = endpoint_url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    const user = match[1];
    const repo = match[2];
    api_url = `https://api.github.com/repos/${user}/${repo}/`;
    raw_url = `https://raw.githubusercontent.com/${user}/${repo}/main/`;
  } else {
    // fallback if parsing fails
    api_url = endpoint_url;
    raw_url = endpoint_url;
  }
} else {
  // For other endpoints, just use the base URL
  api_url = endpoint_url;
  raw_url = endpoint_url;
}

console.log("API URL:", api_url);
console.log("RAW URL:", raw_url);
console.log("Endpoint URL:", endpoint_url);
////// PATHS //////
//// Main ////
baserouter.get("/", function (req, res) {
  res.render(__dirname + '/public/index.ejs', {baseurl: baseurl});
});
baserouter.get("/uponlanxyz-web.js", function (req, res) {
  res.setHeader("Content-Type", "application/javascript");
  res.render(__dirname + '/public/uponlanxyz-web.ejs', {baseurl: baseurl});
});
//// Public JS and CSS ////
baserouter.use('/public', express.static(__dirname + '/public'));

// Socket IO connection
io.on('connection', function(socket){
  //// Socket Connect ////
  // Log Client and connection time
  console.log(socket.id + ' connected time=' + (new Date).getTime());
  socket.join(socket.id);
  ///////////////////////////
  ////// Socket events //////
  ///////////////////////////
  // When dashboard info is requested send to client
  socket.on('getdash', function(){
    // Always read the latest values from disk
    let menuversion = fs.existsSync('/config/menuversion.txt') ? fs.readFileSync('/config/menuversion.txt', 'utf8') : 'none';
    let menuorigin = fs.existsSync('/config/menuorigin.txt') ? fs.readFileSync('/config/menuorigin.txt', 'utf8') : 'none';
    // Commands to get versions
    var tftpcmd = '/usr/sbin/dnsmasq --version | head -n1 | cut -d " " -f1-3';
    var nginxcmd = '/usr/sbin/nginx -v';
    var wolcmd = '/usr/bin/awake --version';
    var dashinfo = {};
    // Webapp version
    dashinfo['webversion'] = version;
    // Menu version
    dashinfo['menuversion'] = menuversion;
    // Menu origin (endpoint_url or netbook.xyz)
    dashinfo['menuorigin'] = menuorigin;
    fetch('https://api.github.com/repos/mozebaltyk/uponlan/releases/latest', {headers: {'user-agent': 'node.js'}})
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(body => {
        dashinfo['remotemenuversion'] = body.tag_name;
        si.cpu(function(cpu) {
          dashinfo['cpu'] = cpu;
          si.mem(function(mem) {
            dashinfo['mem'] = mem;
            si.currentLoad(function(currentLoad) {
              dashinfo['CPUpercent'] = currentLoad.currentload_user;
              exec(tftpcmd, function (err, stdout) {
                dashinfo['tftpversion'] = stdout;
                exec(nginxcmd, function (err, stdout, stderr) {
                  dashinfo['nginxversion'] = stderr;
                  exec(wolcmd, function (err, stdout, stderr) {
                    dashinfo['wolversion'] = (stdout || stderr || '').trim();
                  io.sockets.in(socket.id).emit('renderdash',dashinfo);
                  });
                });
              });  
            });
          });
        });  
      })
      .catch(error => {
        console.log('There was a problem with the fetch operation: ' + error.message);
      });
    });
  // When Menu from Endpoint URL is requested run it from dashboard
  socket.on('upgrademenus', function(version){
    upgrademenu(version, function(response){
      io.sockets.in(socket.id).emit('renderdashhook');
    });
  });
  // When Menu from Endpoint URL is requested run it in the Dev Menu
  socket.on('upgrademenusdev', function(version){
    upgrademenu(version, function(response){
      io.sockets.in(socket.id).emit('renderconfighook');
    });
  });
  // When Menu from Netboot.xyz is requested run it in the Dev Menu
  socket.on('upgrademenusdevnetboot', function(version){
    upgrademenunetboot(version, function(response){
      io.sockets.in(socket.id).emit('renderconfighook');
    });
  });
  // When config info is requested send file list to client
  socket.on('getconfig', function(){
    var local_files = fs.readdirSync('/config/menus/local',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
    var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
    io.sockets.in(socket.id).emit('renderconfig',remote_files,local_files);
  });
  // When a file is requested send it's contents to the client
  socket.on('editgetfile', function(filename, islocal){
    var rootDir = '/config/menus/';
    var filePath = path.resolve(rootDir, filename);
    if (!filePath.startsWith(rootDir)) {
      io.sockets.in(socket.id).emit('error', 'Invalid file path');
      return;
    }
    var data = fs.readFileSync(filePath);
    var stat = fs.lstatSync(filePath);
    isBinaryFile(data, stat.size).then((result) => {
      if (result) {
        io.sockets.in(socket.id).emit('editrenderfile','CANNOT EDIT THIS IS A BINARY FILE',filename,'nomenu');
      }
      else {
        io.sockets.in(socket.id).emit('editrenderfile',data.toString("utf8"),filename,islocal);
      }
    });
  });
  // When save is requested save it sync files and return user to menu
  socket.on('saveconfig', function(filename, text){
    var rootDir = '/config/menus/local/';
    var filePath = path.resolve(rootDir, filename);
    if (!filePath.startsWith(rootDir)) {
      io.sockets.in(socket.id).emit('error', 'Invalid file path');
      return;
    }
    fs.writeFileSync(filePath, text);
    layermenu(function(response){
      var local_files = fs.readdirSync(rootDir, {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      var remote_files = fs.readdirSync('/config/menus/remote', {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      io.sockets.in(socket.id).emit('renderconfig', remote_files, local_files, filename, true);
    });
  });
  // When revert is requested delete it, sync files and return user to menu
  socket.on('revertconfig', function(filename){
    var rootDir = '/config/menus/local/';
    var filePath = path.resolve(rootDir, filename);
    if (!filePath.startsWith(rootDir)) {
      io.sockets.in(socket.id).emit('error', 'Invalid file path');
      return;
    }
    fs.unlinkSync(filePath);
    layermenu(function(response){
      var local_files = fs.readdirSync(rootDir, {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      var remote_files = fs.readdirSync('/config/menus/remote', {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      io.sockets.in(socket.id).emit('renderconfig', remote_files, local_files);
    });
  });
  // When a create file is 
  socket.on('createipxe', function(filename){
    var rootDir = '/config/menus/local/';
    var filePath = path.resolve(rootDir, filename);
    if (!filePath.startsWith(rootDir)) {
      io.sockets.in(socket.id).emit('error', 'Invalid file path');
      return;
    }
    fs.writeFileSync(filePath, '#!ipxe');
    layermenu(function(response){
      var local_files = fs.readdirSync(rootDir, {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      var remote_files = fs.readdirSync('/config/menus/remote', {withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      io.sockets.in(socket.id).emit('renderconfig', remote_files, local_files, filename, true);
    });
  });
  // When the endpoints content is requested send it to the client
  socket.on('getlocal', async function(filename){
    //var remotemenuversion = fs.readFileSync('/config/menuversion.txt', 'utf8');
    var endpointsfile = fs.readFileSync('/config/endpoints.yml');
    var endpoints = yaml.load(endpointsfile);
    var localfiles = await readdirp.promise('/assets/.');
    var assets = [];
    if (localfiles.length != 0){
      for (var i in localfiles){
        assets.push('/' + localfiles[i].path);
      }
    }
    io.sockets.in(socket.id).emit('renderlocal',endpoints,assets,menuversion);
  });
  // Empty Menu
  socket.on('emptymenu', function(){
    try {
      // Helper to delete all files in a directory
      function deleteAllFilesInDir(dir) {
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            if (fs.lstatSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
              console.log('Deleted', filePath);
            }
          });
        }
      }
      // Delete all files in local and remote directories
      deleteAllFilesInDir('/config/menus/local');
      deleteAllFilesInDir('/config/menus/remote');
      deleteAllFilesInDir('/config/menus');

      // Delete /config/menuversion.txt
      const menuVersionFile = '/config/menuversion.txt';
      if (fs.existsSync(menuVersionFile)) {
        fs.unlinkSync(menuVersionFile);
        console.log('Deleted', menuVersionFile);
      }

      // Delete /config/menuorigin.txt
      const menuOriginFile = '/config/menuorigin.txt';
      if (fs.existsSync(menuOriginFile)) {
        fs.unlinkSync(menuOriginFile);
        console.log('Deleted', menuOriginFile);
      }

      // Optionally, re-render the config for the client
      var local_files = fs.readdirSync('/config/menus/local',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
      io.sockets.in(socket.id).emit('renderconfig', remote_files, local_files);
    } catch (err) {
      console.error('Failed to reset menu:', err);
      socket.emit('error', 'Failed to reset menu: ' + err.message);
    }
  });
  // When the endpoints Wake On LAN is requested send it to the client.
  socket.on('getwol', async function(filename){
    var wolfile = fs.readFileSync('/config/wol.yml');
    var wolpoints = yaml.load(wolfile);
    io.sockets.in(socket.id).emit('renderwol',wolpoints);
  });
  // add entry in wol.yml
  socket.on('addwol', function(newEntry) {
    try {
      // Read the current wol.yml
      let wolfile = fs.readFileSync('/config/wol.yml', 'utf8');
      let wolpoints = yaml.load(wolfile) || {};
      if (!Array.isArray(wolpoints.wakeonlan)) {
        wolpoints.wakeonlan = [];
      }
      if (!isValidMac(newEntry.default_mac)) {
      socket.emit('error', 'Invalid MAC address format.');
      return;
      }
      if (wolpoints.wakeonlan.some(entry => entry.default_mac.toLowerCase() === newEntry.default_mac.toLowerCase())) {
      socket.emit('error', 'MAC address already exists.');
      return;
      }
      // Add the new entry
      wolpoints.wakeonlan.push(newEntry);
      // Write back to wol.yml
      fs.writeFileSync('/config/wol.yml', yaml.dump(wolpoints));
      // Log in console
      console.log(`WOL entry added: ${JSON.stringify(newEntry)}`);
      // Emit updated data to client
      socket.emit('renderwol', wolpoints);
    } catch (err) {
      console.error('Failed to add WOL entry:', err); 
      socket.emit('error', 'Failed to add WOL entry: ' + err.message);
    }
  });
  // wake on lan function
  const { exec } = require('child_process');
  socket.on('wakewol', function(mac) {
    exec(`awake ${mac}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to wake host ${mac}:`, stderr || error.message); 
        socket.emit('error', `Failed to wake host: ${stderr || error.message}`);
      } else {
        console.log(`Wake command sent to ${mac}: ${stdout.trim()}`); 
        socket.emit('info', `Wake command sent to ${mac}`);
      }
    });
  });
  // Delete entry in wol.yml
  socket.on('deletewol', function(mac) {
    try {
      let wolfile = fs.readFileSync('/config/wol.yml', 'utf8');
      let wolpoints = yaml.load(wolfile) || {};
      if (!Array.isArray(wolpoints.wakeonlan)) {
        wolpoints.wakeonlan = [];
      }
      // Filter out the entry with the matching MAC address (case-insensitive)
      const before = wolpoints.wakeonlan.length;
      wolpoints.wakeonlan = wolpoints.wakeonlan.filter(
        entry => entry.default_mac.toLowerCase() !== mac.toLowerCase()
      );
      if (wolpoints.wakeonlan.length === before) {
        socket.emit('error', 'Entry not found.');
        return;
      }
      fs.writeFileSync('/config/wol.yml', yaml.dump(wolpoints));
      console.log(`WOL entry deleted: ${mac}`);
      socket.emit('renderwol', wolpoints);
    } catch (err) {
      console.error('Failed to delete WOL entry:', err); 
      socket.emit('error', 'Failed to delete WOL entry: ' + err.message);
    }
  });
  // When remote downloads are requested make folders and download
  socket.on('dlremote', function(dlfiles){
    dlremote(dlfiles, function(response){
      io.sockets.in(socket.id).emit('renderlocalhook');
    });
  });
  // When Local deletes are requested purge items
  socket.on('deletelocal', function(dlfiles){
    for (var i in dlfiles){
      var file = dlfiles[i];
      fs.unlinkSync('/assets' + file);
      console.log('Deleted /assets' + file);
      if (fs.existsSync('/assets' + file + '.part2')) {
        fs.unlinkSync('/assets' + file + '.part2');
        console.log('Deleted /assets' + file + '.part2');
      }
    }
    io.sockets.in(socket.id).emit('renderlocalhook');
  });
  // When Get Browser is requested reach out to github Netboot.xyz for versions
  socket.on('nbgetbrowser', async function(){
    try {
      var nb_api_url = 'https://api.github.com/repos/netbootxyz/netboot.xyz/';
      var options = {headers: {'user-agent': 'node.js'}};
      var releasesResponse = await fetch(nb_api_url + 'releases', options);
      if (!releasesResponse.ok) {
        throw new Error(`HTTP error! status: ${releasesResponse.status}`);
      }
      var releases = await releasesResponse.json();
      var commitsResponse = await fetch(nb_api_url + 'commits', options);
      if (!commitsResponse.ok) {
        throw new Error(`HTTP error! status: ${commitsResponse.status}`);
      }
      var commits = await commitsResponse.json()
      io.sockets.in(socket.id).emit('nbrenderbrowser', releases, commits);
    } catch (error) {
      console.error('nbgetbrowser error:', error.stack || error);
      socket.emit('error', 'Failed to fetch Netboot.xyz browser data: ' + error.message);
    }
  });
  // When Get Browser is requested reach out to github Mozebaltyk for versions
  socket.on('devgetbrowser', async function(){
    try {
      var options = {headers: {'user-agent': 'node.js'}};
      var releasesResponse = await fetch(api_url + 'releases', options);
      if (!releasesResponse.ok) {
        throw new Error(`HTTP error! status: ${releasesResponse.status}`);
      }
      var releases = await releasesResponse.json();
      io.sockets.in(socket.id).emit('devrenderbrowser', releases);
    } catch (error) {
      console.error('devgetbrowser error:', error.stack || error);
      socket.emit('error', 'Failed to fetch UpOnLAN.xyz browser data: ' + error.message);
    }
  });
});


//// Functions ////

// Validation function

function isValidMac(mac) {
  return /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac);
}

// Layer remote with local in the main tftp endpoint
function layermenu(callback){
  var local_files = fs.readdirSync('/config/menus/local',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
  var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
  for (var i in remote_files){
    var file = remote_files[i];
    fs.copyFileSync('/config/menus/remote/' + file, '/config/menus/' + file);
  }
  for (var i in local_files){
    var file = local_files[i];
    fs.copyFileSync('/config/menus/local/' + file, '/config/menus/' + file);
  }
  callback(null, 'done');
}

// Upgrade menus to specified version
async function upgrademenu(version, callback){
  var remote_folder = '/config/menus/remote/';
  // Wipe current remote
  var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
  for (var i in remote_files){
    var file = remote_files[i];
    fs.unlinkSync(remote_folder + file);
  }
  // Download files
  var downloads = [];
  var download_endpoint = endpoint_url + '/releases/download/' + version + '/';
  downloads.push({'url':download_endpoint + 'menus.tar.gz','path':remote_folder});
  
  // static config for endpoints
  downloads.push({'url': raw_url + version +'/endpoints.yml','path':'/config/'});
  await downloader(downloads);
  var untarcmd = 'tar xf ' + remote_folder + 'menus.tar.gz -C ' + remote_folder;

  var origin = endpoint_url;

  exec(untarcmd, function (err, stdout) {
    fs.unlinkSync(remote_folder + 'menus.tar.gz');
    fs.writeFileSync('/config/menuversion.txt', version);
    fs.writeFileSync('/config/menuorigin.txt', origin);
    layermenu(function(response){
      disablesigs();
      callback(null, 'done');
    });
  });
}

// Download menus from netboot.xyz
async function upgrademenunetboot(version, callback){
  var remote_folder = '/config/menus/remote/';
  // Wipe current remote
  var remote_files = fs.readdirSync('/config/menus/remote',{withFileTypes: true}).filter(dirent => !dirent.isDirectory()).map(dirent => dirent.name);
  for (var i in remote_files){
    var file = remote_files[i];
    fs.unlinkSync(remote_folder + file);
  }
  // Download files
  var downloads = [];
  var rom_files = ['netboot.xyz.kpxe',
                   'netboot.xyz-undionly.kpxe',
                   'netboot.xyz.efi',
                   'netboot.xyz-snp.efi',
                   'netboot.xyz-snponly.efi',
                   'netboot.xyz-arm64.efi',
                   'netboot.xyz-arm64-snp.efi',
                   'netboot.xyz-arm64-snponly.efi'];

  // This is a commit sha
  if (version.length == 40){
    var download_endpoint = 'https://s3.amazonaws.com/dev.boot.netboot.xyz/' + version + '/ipxe/';
    downloads.push({'url':'https://s3.amazonaws.com/dev.boot.netboot.xyz/' + version + '/menus.tar.gz','path':remote_folder});
  }
  // This is a regular release
  else{
    var download_endpoint = 'https://github.com/netbootxyz/netboot.xyz/releases/download/' + version + '/';
    downloads.push({'url':download_endpoint + 'menus.tar.gz','path':remote_folder});
  }
  for (var i in rom_files){
    var file = rom_files[i];
    var url = download_endpoint + file;    
    downloads.push({'url':url,'path':remote_folder});
  }
  // static config for endpoints
  downloads.push({'url':'https://raw.githubusercontent.com/netbootxyz/netboot.xyz/' + version +'/endpoints.yml','path':'/config/'});
  await downloader(downloads);
  var untarcmd = 'tar xf ' + remote_folder + 'menus.tar.gz -C ' + remote_folder;
  if (version.length == 40){
    var version = 'Development';
  }
  var origin = download_endpoint.replace(/releases\/download\/.*$/, '');

  exec(untarcmd, function (err, stdout) {
    fs.unlinkSync(remote_folder + 'menus.tar.gz');
    fs.writeFileSync('/config/menuversion.txt', version);
    fs.writeFileSync('/config/menuorigin.txt', origin);
    layermenu(function(response){
      disablesigs();
      callback(null, 'done');
    });
  });
}

// Grab remote files - concatenate with endpoints.yml
async function dlremote(dlfiles, callback){
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
  await downloader(dlarray);
  callback(null, 'done');
}

// downloader loop
async function downloader(downloads){
  var startTime = new Date();
  var total = downloads.length;
  for (var i in downloads){
    var value = downloads[i];
    var url = value.url;
    var path = value.path;
    var dloptions = {override:true,retry:{maxRetries:2,delay:5000}};
    var dl = new DownloaderHelper(url, path, dloptions);

    dl.on('end', function(){ 
      console.log('Downloaded ' + url + ' to ' + path);
    });

    dl.on('error', function(error) {
      console.error('Download failed:', error);
    });

    dl.on('progress', function(stats){
      var currentTime = new Date();
      var elaspsedTime = currentTime - startTime;
      if (elaspsedTime > 500) {
        startTime = currentTime;
        io.emit('dldata', url, [+i + 1,total], stats);
      }
    });

    await dl.start().catch(error => {
      console.error('Download failed:', error);
    });

    const parsedUrl = urlLib.parse(url);
    if (!allowedHosts.includes(parsedUrl.host)){
      // Part 2 if exists repeat
      var response = await fetch(url + '.part2', {method: 'HEAD'});
      var urltest = response.headers.get('server');
      if (urltest == 'AmazonS3' || urltest == 'Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0') {
        var dl2 = new DownloaderHelper(url + '.part2', path, dloptions);
        dl2.on('end', function(){ 
          console.log('Downloaded ' + url + '.part2' + ' to ' + path);
        });
        dl2.on('progress', function(stats){
          var currentTime = new Date();
          var elaspsedTime = currentTime - startTime;
          if (elaspsedTime > 500) {
            startTime = currentTime;
            io.emit('dldata', url, [+i + 1,total], stats);
          }
        });
        await dl2.start();
      }
    }
  }
  io.emit('purgestatus');
}

app.use(baseurl, baserouter);

// Spin up application on port 3000 or set to WEB_APP_PORT env variable

const defaultPort = 3000;

let port = process.env.WEB_APP_PORT;

if (!Number.isInteger(Number(port)) || port < 1 || port > 65535) {
  console.warn(`Invalid port "${port}" in environment variable WEB_APP_PORT. Using default port ${defaultPort} instead.`);
  port = defaultPort;
}

http.listen(port, function(){
  console.log('listening on *:' + port);
});
