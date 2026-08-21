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

# Default endpoint when none is configured.
if [[ -z "${ENDPOINT_URL:-}" ]]; then
  export ENDPOINT_URL="https://github.com/mozebaltyk/uponlan/"
fi

# Resolve the menu version. Empty and unset mean the same thing here: the chart
# always injects MENU_VERSION (possibly as an empty string), so `${VAR+x}` would
# wrongly treat an empty version as deliberate and the dashboard would show
# `none`. GitHub endpoints need the real latest tag; flat/local mirrors use a
# `latest` file under /menu/latest.
if [[ -z "${MENU_VERSION:-}" ]]; then
  if [[ "${ENDPOINT_URL}" == *github.com* ]]; then
    MENU_VERSION=$(curl -sL "https://api.github.com/repos/mozebaltyk/uponlan/releases/latest" | jq -r '.tag_name')
  else
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

# Refresh endpoints.yml from the configured origin on every startup. The asset
# catalog is generated, not user-edited state, so a fresh fetch is correct and
# picks up newly published entries (e.g. direct_file vendor-source catalog
# changes). If refresh fails, keep an existing local copy; otherwise create an
# empty catalog as the last resort.
if [[ "${ENDPOINT_URL}" == *github.com* ]]; then
  # The asset catalog is published by assets.yml as a release asset on the
  # stable 'assets' tag (prerelease, so it never shadows the menu's latest).
  endpoint_catalog_url="${ENDPOINT_URL}/releases/download/assets/endpoints.yml"
else
  endpoint_catalog_url="${ENDPOINT_URL}/assets/endpoints.yml"
fi
echo "[uponlanxyz-init] Import endpoints.yml from ${endpoint_catalog_url}"
if ! curl -fsL ${endpoint_catalog_url} -o /tmp/endpoints.yml; then
  if [[ -f /config/endpoints.yml ]]; then
    echo "[uponlanxyz-init] Keeping existing /config/endpoints.yml (refresh failed)"
  else
    echo "[uponlanxyz-init] No endpoints.yml found from asset release, creating a default one"
    echo "endpoints: {}" > /config/endpoints.yml
  fi
else
  mv /tmp/endpoints.yml /config/endpoints.yml
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

# Trust a mounted corporate CA bundle (e.g. a TLS-inspecting proxy that
# re-signs vendor HTTPS like releases.rancher.com). Drop PEM certs in
# /config/certs/ and they're added to the system trust store so curl trusts
# them; Node picks up the same bundle via NODE_EXTRA_CA_CERTS (supervisor.conf
# points the webapp at /etc/ssl/certs/ca-certificates.crt, refreshed here).
if ls /config/certs/*.crt /config/certs/*.pem >/dev/null 2>&1; then
  echo "[uponlanxyz-init] Trusting mounted CA certs from /config/certs/"
  mkdir -p /usr/local/share/ca-certificates
  for cert in /config/certs/*.crt /config/certs/*.pem; do
    [ -f "$cert" ] || continue
    name="$(basename "$cert")"
    cp "$cert" "/usr/local/share/ca-certificates/${name%.*}.crt" 2>/dev/null || true
  done
  update-ca-certificates 2>/dev/null || true
fi

# Ownership
chown -R nbxyz:nbxyz /config
chown -R nbxyz:nbxyz /assets
chown -R nbxyz:nbxyz /var/lib/nginx
chown -R nbxyz:nbxyz /var/log/nginx
chown -R nbxyz:nbxyz /logs
