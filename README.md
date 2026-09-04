# Caddy Daddy (Reverse Proxy on Fly.io $\rightarrow$ Railway Upstream)

Production-ready Caddy v2 reverse proxy deployed on **Fly.io** with persistent storage, proxying traffic to your **Railway** backend and storefront.

Handles **custom tenant domains** with automated On-Demand TLS as well as **wildcard subdomains** (`*.dhimora.com`).

---

## 🏗 Architecture

```
[Custom Domains & Subdomains] 
(tenant.com / *.dhimora.com)
            │
            ▼ (Raw TCP: 80, 443)
┌──────────────────────────────────────────────┐
│ Fly.io Gateway (Caddy)                       │
│                                              │
│  - Port 80: HTTP->HTTPS & ACME Challenges   │
│  - Port 443: On-Demand TLS Handshake         │
│  - Storage: Persistent Volume (/data)        │
└──────┬───────────────────────────────┬───────┘
       │                               │
       │ 1. Validate domain (?domain=) │ 2. Proxy request with Host header
       ▼                               ▼
┌──────────────────────────────┐ ┌─────────────────────────────────────────┐
│ Railway Backend              │ │ Railway Storefront                      │
│ dhimora-backend-production...│ │ production-storefront-production...     │
│ /v1/store/lookup             │ │ (Receives X-Forwarded-Host: tenant.com) │
└──────────────────────────────┘ └─────────────────────────────────────────┘
```

---

## 🚀 Fly.io Quickstart & Deployment

### 1. Authenticate with Fly.io
```bash
fly auth login
```

### 2. Launch or Create the Fly App
```bash
# If launching for the first time:
fly launch --no-deploy
```
*(Choose your app name, e.g. `caddy-daddy`, and select your primary region, e.g. `sin` for Singapore).*

### 3. Create the Persistent Volume for Certificates
> **CRITICAL**: The `/data` volume ensures Let's Encrypt / ZeroSSL certificates survive redeployments, preventing ACME rate limits.

```bash
fly volumes create caddy_data --region sin --size 1
```

### 4. Allocate Dedicated Public IP Addresses
Fly.io provides dedicated IPs for your reverse proxy:
```bash
# Allocate dedicated IPv4 (essential for root A records)
fly ips allocate-v4

# Allocate dedicated IPv6 (for AAAA records)
fly ips allocate-v6
```
*(Run `fly ips list` to view your assigned IP addresses).*

### 5. Deploy to Fly.io
```bash
fly deploy
```

---

## ⚙️ Configuration & Environment Variables

These are pre-configured in `fly.toml` under `[env]`, but can also be updated via `fly secrets set` or `fly.toml`:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `UPSTREAM_URL` | `https://production-storefront-production.up.railway.app` | Target Railway storefront URL |
| `UPSTREAM_HOST` | `production-storefront-production.up.railway.app` | Host header sent to Railway Edge router |
| `ASK_ENDPOINT` | `https://dhimora-backend-production.up.railway.app/v1/store/lookup` | Backend validation endpoint |

---

## 🌐 DNS Setup for Tenants

### Tenant Custom Domains (`clientstore.com`)
Direct tenants to add either:
- **A Record**: `@` $\rightarrow$ `<Fly-Allocated-IPv4>`
- **AAAA Record**: `@` $\rightarrow$ `<Fly-Allocated-IPv6>`
- **CNAME Record**: `www` or `shop` $\rightarrow$ `your-app-name.fly.dev`

### Wildcard Subdomain (`*.dhimora.com`)
In your DNS provider (e.g. Cloudflare / Route53):
- **A Record**: `*.dhimora.com` $\rightarrow$ `<Fly-Allocated-IPv4>`
- **AAAA Record**: `*.dhimora.com` $\rightarrow$ `<Fly-Allocated-IPv6>`

---

## 🔒 The Domain Validation Endpoint (`ask`)

When a client hits Caddy on port 443 with a domain name, Caddy triggers:
```http
GET /v1/store/lookup?domain=clientstore.com HTTP/1.1
Host: dhimora-backend-production.up.railway.app
```
- **HTTP 200 OK**: Backend confirms domain exists $\rightarrow$ Caddy issues/loads certificate.
- **HTTP 404 / 403**: Backend rejects domain $\rightarrow$ Caddy drops TLS handshake (prevents certificate spoofing and abuse).

---

## 🩺 Healthcheck

Fly.io automatically performs TCP checks on ports 80 and 443.
You can also verify Caddy directly:
```bash
curl -i http://<your-fly-app>.fly.dev/health
# Returns HTTP 200 OK with "ok"
```
