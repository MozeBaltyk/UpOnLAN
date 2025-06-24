#!/bin/bash

# make our folders
mkdir -p \
  /assets \
  /config/nginx/site-confs \
  /logs/nginx \
  /logs/tftp \
  /logs/webapp \
  /logs/ansible \
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

# Import menus
echo "[uponlanxyz-init] Import menu from ${ENDPOINT_URL} version ${MENU_VERSION}"
curl -L ${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz -o /config/menus/menus.tar.gz

# Extract menus if exists
if [[ ! -f /config/menus/menus.tar.gz ]]; then
  echo "[uponlanxyz-init] No menus.tar.gz found, skipping extraction"
else
  echo "[uponlanxyz-init] Extracting menus.tar.gz"
  tar -xzf /config/menus/menus.tar.gz -C /config/menus/remote
  rm -f /config/menus/menus.tar.gz
  if [[ -f /config/menus/remote/endpoints.yml ]]; then
    mv /config/menus/remote/endpoints.yml /config/endpoints.yml
    echo "[uponlanxyz-init] Extracted endpoints.yml"
  else
    echo "[uponlanxyz-init] No endpoints.yml found in extracted menus"
  fi
  cp /config/menus/remote/* /config/menus/
fi

# Ensure endpoints.yml exists
if [[ ! -f /config/endpoints.yml ]]; then
  echo "[uponlanxyz-init] No endpoints.yml found, creating a default one"
  echo "menu: {}" > /config/endpoints.yml
fi

# Apply patches using yq
yq -i ".menu.title = \"${TITLE:-UpOnLAN.xyz}\"" /config/endpoints.yml
yq -i ".menu.version = \"${MENU_VERSION}\"" /config/endpoints.yml
yq -i ".menu.origin = \"${ENDPOINT_URL:-https://github.com/mozebaltyk/uponlan}\"" /config/endpoints.yml

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
