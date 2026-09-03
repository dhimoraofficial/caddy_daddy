FROM caddy:2.11.4-alpine

# Copy local Caddyfile into the image
COPY Caddyfile /etc/caddy/Caddyfile

# Railway requires volumes to be mounted via Railway UI/service settings to /data

# Default HTTP/HTTPS and internal proxy ports
EXPOSE 80 443
