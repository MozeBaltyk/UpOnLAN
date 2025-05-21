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

# Push menus if not found
if [[ ! -f /config/menus/menu.ipxe ]]; then
  if [[ -z ${MENU_VERSION+x} ]]; then
    MENU_VERSION=$(curl -sL "https://api.github.com/repos/mozebaltyk/uponlan/releases/latest" | jq -r '.tag_name')
  fi
  echo "[uponlanxyz-init] Import uponlan.xyz at ${MENU_VERSION}"
  echo -n "${MENU_VERSION}" > /config/menuversion.txt
  cp /defaults/endpoints.yml /config/endpoints.yml
  cp /defaults/menus/boot.cfg /config/menus/boot.cfg 
  cp /defaults/menus/*.ipxe /config/menus/
  cp /defaults/menus/boot.cfg /config/menus/remote/boot.cfg 
  cp /defaults/menus/*.ipxe /config/menus/remote/
fi

# init wol.yaml
if [[ ! -f /config/wol.yml ]]; then
  echo "[uponlanxyz-init] Import wol.yml"
  cp /defaults/wol.yml /config/wol.yml
fi

# Avoid errrors with supervisord 
touch /var/logs/messages

# Ownership
chown -R nbxyz:nbxyz /config
