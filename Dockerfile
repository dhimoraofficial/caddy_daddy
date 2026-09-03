FROM caddy:2.11.4-alpine

# Copy local Caddyfile into the image
COPY Caddyfile /etc/caddy/Caddyfile

# Ensure data volume directory exists for Let's Encrypt / ZeroSSL certificate storage
VOLUME /data

# Default HTTP/HTTPS and internal proxy ports
EXPOSE 80 443
