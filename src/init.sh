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
  /config/menus/rom \
  /config/tls

# TLS ports.
export HTTPS_PORT="${HTTPS_PORT:-8443}"
export WEBAPP_HTTPS_PORT="${WEBAPP_HTTPS_PORT:-3443}"

# copy config files
[[ ! -f /config/nginx/nginx.conf ]] && \
  cp /defaults/nginx.conf /config/nginx/nginx.conf

# TLS termination: use a mounted cert+key pair when present; generate a
# self-signed fallback only when both are missing (never overwrite an
# operator's real cert). A lone cert or key is a misconfiguration — skip TLS
# rather than guess. The shell-format list restricts envsubst to the three
# ports so nginx's own $host / $http_upgrade variables survive untouched.
TLS_CRT=/config/tls/server.crt
TLS_KEY=/config/tls/server.key
if [[ -f "$TLS_CRT" && -f "$TLS_KEY" ]]; then
  echo "[uponlanxyz-init] TLS: using mounted server.crt + server.key"
elif [[ ! -f "$TLS_CRT" && ! -f "$TLS_KEY" ]]; then
  echo "[uponlanxyz-init] TLS: generating self-signed cert"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$TLS_KEY" -out "$TLS_CRT" \
    -subj "/CN=uponlan.xyz" \
    -addext "subjectAltName=DNS:uponlan.xyz,DNS:localhost,IP:127.0.0.1,IP:192.168.7.1" >/dev/null 2>&1
fi
if [[ -f "$TLS_CRT" && -f "$TLS_KEY" ]]; then
  # Single HTTPS site-conf: assets on HTTPS_PORT, webapp reverse-proxy on
  # WEBAPP_HTTPS_PORT. No plain-HTTP listener.
  envsubst '${HTTPS_PORT} ${WEBAPP_HTTPS_PORT} ${WEB_APP_PORT}' \
    < /defaults/default > /config/nginx/site-confs/default
  echo "[uponlanxyz-init] TLS enabled: assets :${HTTPS_PORT}, webapp :${WEBAPP_HTTPS_PORT}"
else
  rm -f /config/nginx/site-confs/default
  echo "[uponlanxyz-init] TLS: only one of server.crt/server.key present — HTTPS disabled"
fi

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

  # Provisioning profiles (kickstart/cloud-init seeds) ship inside menus.tar.gz
  # under provisioning/. Move them out of the menu tree into the editable tree
  # (/config/provisioning/local) and the served tree (/assets/provisioning), so
  # they aren't exposed as iPXE menu files but are reachable at
  # /provisioning/... via nginx. Never overwrite an operator's existing file.
  if [ -d /config/menus/remote/provisioning ]; then
    mkdir -p /config/provisioning/local /assets/provisioning
    (cd /config/menus/remote/provisioning && find . -type f | while read -r f; do
      rel="${f#./}"
      for dst in /config/provisioning/local /assets/provisioning; do
        if [ ! -e "$dst/$rel" ]; then
          mkdir -p "$dst/$(dirname "$rel")"
          cp "$f" "$dst/$rel"
        fi
      done
    done)
    rm -rf /config/menus/remote/provisioning
  fi

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
