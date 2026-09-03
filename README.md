# Caddy Daddy (Railway Reverse Proxy)

Production-ready Caddy v2 reverse proxy designed for Railway. Handles **custom tenant domains** with automated On-Demand TLS as well as **wildcard subdomains** (`*.dhimora.com`).

---

## 🏗 Architecture

```
[Custom Domains] --------> Railway TCP Proxy (:443) ----> Caddy (https://) --[Ask Endpoint Check]--> Upstream App
(tenant.com)                                                   |                                (web:3000)
                                                               v
                                                       Persistent /data
                                                       (SSL Certificates)

[Wildcard Subdomains] ---> Railway HTTP Edge (:PORT) ---> Caddy (:PORT) -----------------------------> Upstream App
(*.dhimora.com)                                                                                 (web:3000)
```

---

## 🚀 Setup Guide on Railway

### 1. Disconnect Previous Docker Hub Deployment
If you currently have the raw `caddy:2.11.4-alpine` Docker Hub image deployed:
1. Open your Railway project.
2. Select your Caddy service.
3. In the service settings / source panel, click **Disconnect**.

---

### 2. Connect this GitHub Repository
1. Push this repository to GitHub:
   ```bash
   git push -u origin main
   ```
2. In Railway, click **+ New** $\rightarrow$ **GitHub Repo** (or re-link this repo under the **Source** section of the existing service).
3. Railway will automatically detect the `Dockerfile` and build the container image.

---

### 3. Attach Persistent Volume (`/data`)
> **CRITICAL:** Without persistent storage, Caddy will re-request Let's Encrypt certificates every time the service restarts or redeploys, causing Let's Encrypt rate limiting!

1. Go to the service's **Variables & Volumes** tab.
2. Scroll to **Volumes** $\rightarrow$ Click **+ Add Volume**.
3. Set the mount path to:
   ```
   /data
   ```

---

### 4. Configure Environment Variables
In the **Variables** tab of the Caddy service, configure the following:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `UPSTREAM_URL` | Internal Railway URL of the web app or CMS | `http://web.railway.internal:3000` |
| `ASK_ENDPOINT` | Backend API endpoint that validates tenant domains | `http://super-backend.railway.internal:5000/api/v1/caddy/check-domain` |
| `PORT` | HTTP port used by Railway's Edge router | `8080` |

---

### 5. Configure Networking & Proxies

#### A. For Custom Tenant Domains (`tenant.com`)
1. Go to the service's **Settings** $\rightarrow$ **Networking**.
2. Under **TCP Proxies**, click **+ Add TCP Proxy**.
3. Specify port `443`.
4. Railway will provide a TCP proxy target (e.g. `junction.proxy.rlwy.net:12345` or dedicated IP). Tenants point their DNS A / CNAME records to this target.

#### B. For Wildcard Subdomains (`*.dhimora.com`)
1. In Railway service **Settings** $\rightarrow$ **Public Networking**, click **Generate Domain** or **Custom Domain**.
2. Add your wildcard domain (e.g., `*.dhimora.com`).
3. Railway's edge terminates SSL and forwards requests over internal HTTP to Caddy's `:{$PORT}` block.

---

## 🔒 The Domain Validation Endpoint (`ask`)

Before Caddy issues an SSL certificate for any domain requested via On-Demand TLS, Caddy makes an HTTP GET request to `ASK_ENDPOINT`:

```http
GET /api/v1/caddy/check-domain?domain=customer-domain.com HTTP/1.1
Host: super-backend.railway.internal:5000
```

### Backend Requirements:
- **Return HTTP `200 OK`**: If the domain is recognized and authorized in your database (or ends with an approved root like `.dhimora.com`).
- **Return HTTP `403 Forbidden` / `404 Not Found`**: If the domain is unauthorized. Caddy will abort the TLS handshake, protecting your Let's Encrypt quota against SSL abuse attacks.

---

## 🩺 Healthcheck

Both HTTP and HTTPS blocks expose a lightweight healthcheck:
```
GET /health
```
Response: `200 OK` with body `ok` (does not forward to upstream).

---

## 🛠 Local Testing

Validate configuration:
```bash
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile caddy:2.11.4-alpine caddy validate --config /etc/caddy/Caddyfile
```

Build image:
```bash
docker build -t caddy-daddy:local .
```
