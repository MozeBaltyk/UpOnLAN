'use strict';
const { errorWithTimestamp } = require('../services/utilServices');
const {
  listProvisioningFiles,
  readProvisioningFile,
  saveProvisioningFile,
  deleteProvisioningFile,
  createKickstartProfile,
  createCloudInitProfile,
  getProvisioningVersion,
  setProvisioningVersion,
  validateProvisioningFile,
} = require('../services/provisioningServices');

async function emitProvisioningList(socket) {
  socket.emit('renderprovisioning', await listProvisioningFiles());
}

function emitProvisioningError(socket, action, err, message) {
  if (err.message === 'Invalid provisioning path') {
    socket.emit('error', err.message);
    return;
  }
  errorWithTimestamp(`${action} failed:`, err);
  socket.emit('error', message + err.message);
}

module.exports = function registerProvisioningHandlers(socket) {
  socket.on('getprovisioning', async () => {
    try {
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'getprovisioning', err, 'Failed to get provisioning: ');
    }
  });

  socket.on('getprovisioningfile', async (relativePath) => {
    try {
      const content = await readProvisioningFile(relativePath);
      const version = await getProvisioningVersion(relativePath);
      socket.emit('renderprovisioningfile', content, relativePath, version);
    } catch (err) {
      emitProvisioningError(socket, 'getprovisioningfile', err, 'Failed to read provisioning file: ');
    }
  });

  socket.on('saveprovisioningfile', async (relativePath, text) => {
    try {
      await saveProvisioningFile(relativePath, text);
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'saveprovisioningfile', err, 'Failed to save provisioning file: ');
    }
  });

  socket.on('saveprovisioningversion', async (relativePath, version) => {
    try {
      await setProvisioningVersion(relativePath, version);
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'saveprovisioningversion', err, 'Failed to save provisioning version: ');
    }
  });

  socket.on('validateprovisioning', async (relativePath, version) => {
    try {
      const result = await validateProvisioningFile(relativePath, version);
      socket.emit('renderprovisioningvalidation', relativePath, result);
    } catch (err) {
      emitProvisioningError(socket, 'validateprovisioning', err, 'Failed to validate provisioning file: ');
    }
  });

  socket.on('deleteprovisioningfile', async (relativePath) => {
    try {
      await deleteProvisioningFile(relativePath);
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'deleteprovisioningfile', err, 'Failed to delete provisioning file: ');
    }
  });

  socket.on('createkickstart', async (profilePath) => {
    try {
      await createKickstartProfile(profilePath);
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'createkickstart', err, 'Failed to create Kickstart profile: ');
    }
  });

  socket.on('createcloudinit', async (profilePath) => {
    try {
      await createCloudInitProfile(profilePath);
      await emitProvisioningList(socket);
    } catch (err) {
      emitProvisioningError(socket, 'createcloudinit', err, 'Failed to create cloud-init profile: ');
    }
  });
};
