FROM alpine:3.24 AS build
ARG SOURCE_WEBAPP="webapp"

# Only what npm install needs — the final stage re-installs the runtime set.
RUN apk add --no-cache nodejs npm
COPY /src/${SOURCE_WEBAPP} /webapp
RUN npm install --prefix /webapp

# Final stage
FROM alpine:3.24

# set version label
ARG BUILD_DATE
ARG VERSION

LABEL build_version="uponlan.xyz version: ${VERSION} Build-date: ${BUILD_DATE}"
LABEL maintainer="mozebaltyk"
LABEL org.opencontainers.image.description="uponlan.xyz official docker container - A Webapp to build and serve iPXE menus."

# install awake - Wake-on-LAN helper
RUN apk --no-cache add awake

#### iPXE build toolchain (build_ipxe_roms.sh: make/gcc + genfsimg ISO/USB)
RUN apk add --no-cache \
  build-base \
  curl wget git \
  dosfstools \
  syslinux \
  mtools \
  xorriso \
  xz \
  util-linux \
  libuuid \
  perl \
  xz-dev

#### Deps for the webapp
RUN apk add --no-cache \
    bash \
    busybox \
    curl \
    dnsmasq \
    gettext-envsubst \
    git \
    jq \
    yq-go \
    nghttp2-dev \
    nginx \
    nodejs \
    shadow \
    sudo \
    supervisor \
    syslog-ng \
    busybox-extras \
    tar && \
    groupmod -g 1000 users && \
    useradd -u 911 -U -d /config -s /bin/false nbxyz && \
    usermod -G users nbxyz && \
    mkdir /app /config /defaults

ENV TFTPD_OPTS=''
ENV NGINX_PORT='8080'
ENV WEB_APP_PORT='3000'

EXPOSE 69/udp
EXPOSE 8080
EXPOSE 3000

COPY docs /docs
COPY src/defaults /defaults
COPY src/etc /etc
COPY src/init.sh /init.sh
COPY src/start.sh /start.sh
COPY --from=build /webapp /webapp

# ROM / boot-media build script (the webapp's Build UI shells out to it).
# build_ipxe_roms.sh resolves $REPO_ROOT/scripts/… relative to its own location:
# in the image it lives at /scripts/, so keep the sources/ layout under /scripts/.
COPY scripts/build_ipxe_roms.sh /scripts/build_ipxe_roms.sh
COPY scripts/sources/ipxe-gas242-binutils.patch /scripts/sources/ipxe-gas242-binutils.patch
COPY scripts/sources/genfsimg /scripts/sources/genfsimg
RUN chmod +x /scripts/build_ipxe_roms.sh /scripts/sources/genfsimg

#### VM console support (host libvirt socket mounted at /var/run/libvirt)
# util-linux provides `script`, which allocates the controlling TTY `virsh console` requires.
RUN apk add --no-cache libvirt-client util-linux
# Full virsh access (passwordless) — the host libvirt socket is mounted
# read-write, so the webapp can manage any domain/network/pool visible on the
# host's qemu:///system. Trust boundary = the webapp's own authentication.
RUN echo "nbxyz ALL=(root) NOPASSWD:/usr/bin/virsh *" > /etc/sudoers.d/virsh
RUN chmod 440 /etc/sudoers.d/virsh

# default command
CMD ["sh","/start.sh"]
