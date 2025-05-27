#!/bin/bash

# make our folders
mkdir -p \
  /assets \
  /config/nginx/site-confs \
  /config/logs/nginx \
  /config/logs/tftp \
  /config/logs/webapp \
  /run \
  /var/lib/nginx/tmp/client_body \
  /var/tmp/nginx

# copy config files
[[ ! -f /config/nginx/nginx.conf ]] && \
  cp /defaults/nginx.conf /config/nginx/nginx.conf
[[ ! -f /config/nginx/site-confs/default ]] && \
  envsubst '${NGINX_PORT}' < /defaults/default > /config/nginx/site-confs/default

# Ownership
chown -R nbxyz:nbxyz /assets
chown -R nbxyz:nbxyz /var/lib/nginx
chown -R nbxyz:nbxyz /var/log/nginx

# create local logs dir
mkdir -p \
  /config/menus/remote \
  /config/menus/local

# Import UpOnLAN menus if ENDPOINT_URL is not set
if [[ -z ${ENDPOINT_URL} ]]; then
  if [[ -z ${MENU_VERSION+x} ]]; then
    MENU_VERSION=$(curl -sL "https://api.github.com/repos/mozebaltyk/uponlan/releases/latest" | jq -r '.tag_name')
  fi
  echo "[uponlanxyz-init] Import default menu from uponlan.xyz:${MENU_VERSION}"
  echo -n "${MENU_VERSION}" > /config/menuversion.txt
  echo -n "https://github.com/mozebaltyk/uponlan" > /config/menuorigin.txt
  curl -L https://github.com/mozebaltyk/uponlan/releases/download/${MENU_VERSION}/menus.tar.gz -o /config/menus/menus.tar.gz
  tar -xzf /config/menus/menus.tar.gz -C /config/menus/remote
  rm -f /config/menus/menus.tar.gz
# Import menus if ENDPOINT_URL is set
else
  if [[ -z ${MENU_VERSION+x} ]]; then
    MENU_VERSION="latest"
  fi
  echo "[uponlanxyz-init] Import menu from ${ENDPOINT_URL}"
  echo -n "${MENU_VERSION}" > /config/menuversion.txt
  echo -n "${ENDPOINT_URL}" > /config/menuorigin.txt
  curl -L ${ENDPOINT_URL}/releases/download/${MENU_VERSION}/menus.tar.gz -o /config/menus/menus.tar.gz
  tar -xzf /config/menus/menus.tar.gz -C /config/menus/remote
  rm -f /config/menus/menus.tar.gz
fi

# Finish Menus settings
cp /config/menus/remote/* /config/menus/

# init wol.yml
if [[ ! -f /config/wol.yml ]]; then
  echo "[uponlanxyz-init] Import wol.yml"
  cp /defaults/wol.yml /config/wol.yml
fi

# init endpoints.yml
if [[ ! -f /config/endpoints.yml ]]; then
  echo "[uponlanxyz-init] Import endpoints.yml"
  cp /defaults/endpoints.yml /config/endpoints.yml
fi

# Ownership
chown -R nbxyz:nbxyz /config
