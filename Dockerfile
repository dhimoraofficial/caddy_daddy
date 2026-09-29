# Stage 1: Build custom Caddy binary with plugins using official Caddy builder
FROM caddy:builder-alpine AS builder

RUN xcaddy build \
    --with github.com/caddyserver/cache-handler \
    --with github.com/darkweak/storages/badger/caddy \
    --with github.com/mholt/caddy-ratelimit

# Stage 2: Minimal runtime image
FROM caddy:alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
