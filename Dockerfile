FROM caddy:builder-alpine AS builder

ENV GOPROXY=https://proxy.golang.org,direct

RUN xcaddy build \
    --with github.com/caddyserver/cache-handler \
    --with github.com/darkweak/storages/badger/caddy

FROM caddy:alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Copy local Caddyfile into the image
COPY Caddyfile /etc/caddy/Caddyfile

# Default HTTP/HTTPS and internal proxy ports
EXPOSE 80 443
