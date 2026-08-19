#!/bin/bash

# make our folders
mkdir -p \
  /assets \
  /config/nginx/site-confs \
  /logs/nginx \
  /logs/tftp \
  /logs/webapp \
  /logs/rom \
  /run \
  /var/lib/nginx/tmp/client_body \
  /var/tmp/nginx \
  /config/menus/remote \
  /config/menus/local \
  /config/menus/rom

# copy config files
[[ ! -f /config/nginx/nginx.conf ]] && \
  cp /defaults/nginx.conf /config/nginx/nginx.conf
[[ ! -f /config/nginx/site-confs/default ]] && \
  envsubst '${NGINX_PORT}' < /defaults/default > /config/nginx/site-confs/default

# Import UpOnLAN menus if ENDPOINT_URL is not set
if [[ -z ${ENDPOINT_URL} ]]; then
  export ENDPOINT_URL="https://github.com/mozebaltyk/uponlan/"
  if [[ -z ${MENU_VERSION+x} ]]; then
    MENU_VERSION=$(curl -sL "https://api.github.com/repos/mozebaltyk/uponlan/releases/latest" | jq -r '.tag_name')
  fi
# Import menus if ENDPOINT_URL is set
else
  if [[ -z ${MENU_VERSION+x} ]]; then
    MENU_VERSION="latest"
  fi
fi

# Import menus: use a staged tarball (bind-mounted by test-local) if present, else download
if [[ -f /config/menus.tar.gz ]]; then
  echo "[uponlanxyz-init] Using staged menus.tar.gz (local test)"
else
  # GitHub serves release assets at /releases/download/<tag>/; the local mirror
  # (deploy --local) splits menu/ from assets/.
  if [[ "${ENDPOINT_URL}" == *github.com* ]]; then
    menu_tarball_url="${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz"
  else
    menu_tarball_url="${ENDPOINT_URL}/menu/${MENU_VERSION}/menus.tar.gz"
  fi
  echo "[uponlanxyz-init] Import menu from ${ENDPOINT_URL} version ${MENU_VERSION}"
  curl -L ${menu_tarball_url} -o /config/menus/menus.tar.gz
fi

# Extract menus if exists
if [[ ! -f /config/menus/menus.tar.gz ]]; then
  echo "[uponlanxyz-init] No menus.tar.gz found, skipping extraction"
else
  echo "[uponlanxyz-init] Extracting menus.tar.gz"
  tar -xzf /config/menus/menus.tar.gz -C /config/menus/remote
  rm -f /config/menus/menus.tar.gz
  # -r is required: the tarball contains the rom/ipxe/ directory and a plain
  # `cp` silently omits directories, leaving the TFTP root without the iPXE
  # ROMs the network advertises (UEFI/firmware-PXE boot then fails).
  cp -r /config/menus/remote/* /config/menus/
fi

# Ensure endpoints.yml exists from the asset-side release output
if [[ ! -f /config/endpoints.yml ]]; then
  if [[ "${ENDPOINT_URL}" == *github.com* ]]; then
    endpoint_catalog_url="${ENDPOINT_URL}/endpoints.yml"
  else
    endpoint_catalog_url="${ENDPOINT_URL}/assets/endpoints.yml"
  fi
  echo "[uponlanxyz-init] Import endpoints.yml from ${endpoint_catalog_url}"
  if ! curl -fsL ${endpoint_catalog_url} -o /config/endpoints.yml; then
    echo "[uponlanxyz-init] No endpoints.yml found from asset release, creating a default one"
    echo "endpoints: {}" > /config/endpoints.yml
  fi
fi

# Ensure menu.yml exists
if [[ ! -f /config/menu.yml ]]; then
  echo "[uponlanxyz-init] No menu.yml found, creating a default one"
  echo "menu: {}" > /config/menu.yml
fi

# Apply menu metadata using yq
yq -i ".menu.title = \"${TITLE:-UpOnLAN.xyz}\"" /config/menu.yml
yq -i ".menu.version = \"${MENU_VERSION}\"" /config/menu.yml
yq -i ".menu.origin = \"${ENDPOINT_URL:-https://github.com/mozebaltyk/uponlan}\"" /config/menu.yml

# init wol.yml
if [[ ! -f /config/wol.yml ]]; then
  echo "[uponlanxyz-init] Import wol.yml"
  cp /defaults/wol.yml /config/wol.yml
fi

# Ownership
chown -R nbxyz:nbxyz /config
chown -R nbxyz:nbxyz /assets
chown -R nbxyz:nbxyz /var/lib/nginx
chown -R nbxyz:nbxyz /var/log/nginx
chown -R nbxyz:nbxyz /logs
