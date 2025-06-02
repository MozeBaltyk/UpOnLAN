const { DownloaderHelper } = require('node-downloader-helper');
const urlLib = require('url');
const fetch = require('node-fetch');
const allowedHosts = ['github.com', 's3.amazonaws.com'];
const fs = require('fs');
const path = require('path');

function isValidUrl(urlString) {
  try {
    new URL(urlString); // Will throw if invalid
    return true;
  } catch (err) {
    return false;
  }
}

function getEndpointUrls() {
  let endpoint_url = process.env.ENDPOINT_URL;
  const defaultEndpointUrl = "https://github.com/mozebaltyk/uponlan";
  // Check if env endpoint_url is a valid URL
  if (!endpoint_url || !isValidUrl(endpoint_url)) {
    console.warn(`Invalid URL "${endpoint_url}" in environment variable ENDPOINT_URL. Using default URL ${defaultEndpointUrl} instead.`);
    endpoint_url = defaultEndpointUrl;
  }

  // Define API and raw URLs based on endpoint_url
  let api_url, raw_url;
  if (endpoint_url.startsWith("https://github.com/")) {
    // For GitHub, construct API and raw URLs
    const match = endpoint_url.match(/github\.com\/([^\/]+)\/([^\/]+)(\/)?$/);
    if (match) {
      const user = match[1];
      const repo = match[2];
      api_url = `https://api.github.com/repos/${user}/${repo}/`;
      raw_url = `https://raw.githubusercontent.com/${user}/${repo}/main/`;
    } else {
      console.warn(`Could not extract user/repo from GitHub URL: ${endpoint_url}`);
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
  return { endpoint_url, api_url, raw_url };
}


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

function deleteFiles(file) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log('Deleted', file);
  }
}

async function downloader(downloads, io, socket) {
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
      console.error(`Download failed: ${item.url} -> ${err.message}`);
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

module.exports = {
  isValidUrl,
  getEndpointUrls,
  deleteAllFilesInDir,
  deleteFiles,
  downloader,
};