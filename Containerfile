FROM alpine:3.21.3 AS build
ARG SOURCE_WEBAPP="webapp"

RUN \
 apk update && \
 apk upgrade && \
 apk add --no-cache \
   bash \
   busybox \
   curl \
   envsubst \
   git \
   jq \
   nghttp2-dev \
   nginx \
   nodejs \
   shadow \
   sudo \
   supervisor \
   syslog-ng \
   tar \
   dnsmasq && \
 apk add --no-cache --virtual=build-dependencies \
   npm && \
 groupmod -g 1000 users && \
 useradd -u 911 -U -d /config -s /bin/false nbxyz && \
 usermod -G users nbxyz && \
 mkdir /app \
       /config \
       /defaults 

COPY /src/${SOURCE_WEBAPP} /webapp

RUN \
 npm install --prefix /webapp && \
 apk del --purge build-dependencies && \
 rm -rf /tmp/*

# Final stage
FROM alpine:3.21.3

# set version label
ARG BUILD_DATE
ARG VERSION
ARG OTELCOL_VERSION=0.126.0

LABEL build_version="uponlan.xyz version: ${VERSION} Build-date: ${BUILD_DATE}"
LABEL maintainer="mozebaltyk"
LABEL org.opencontainers.image.description="uponlan.xyz official docker container - A network-based bootable operating system installer based on iPXE."

# install awake - Python lib so would need a python:3-alpine
RUN apk --no-cache add awake

RUN apk add --no-cache \
    bash \
    busybox \
    curl \
    dnsmasq \
    envsubst \
    git \
    jq \
    nghttp2-dev \
    nginx \
    nodejs \
    shadow \
    sudo \
    supervisor \
    syslog-ng \
    tar && \
    groupmod -g 1000 users && \
    useradd -u 911 -U -d /config -s /bin/false nbxyz && \
    usermod -G users nbxyz && \
    mkdir /app /config /defaults

ENV TFTPD_OPTS=''
ENV NGINX_PORT='80'
ENV WEB_APP_PORT='3000'

EXPOSE 69/udp
EXPOSE 80
EXPOSE 3000

COPY docs /docs
COPY src/defaults /defaults
COPY src/etc /etc
COPY src/init.sh /init.sh
COPY src/start.sh /start.sh
COPY --from=build /webapp /webapp

# default command
CMD ["sh","/start.sh"]