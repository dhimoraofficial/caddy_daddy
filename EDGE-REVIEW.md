# Local branch review — 2026-11-17

Reviewed all five local branches against `master` (`bc878fc`), after fetching origin. Origin master was unchanged.
The production branch is selectively merged: its response safety and Vary fixes are retained, while its shared
cache optimizations and cookie stripping are deferred. The regression suite and stub were taken from
`wip/edge-cookie-guard-uncommitted` and extended to exercise the actual production Caddyfile.

| Local branch | Tip | Decision |
| --- | --- | --- |
| `master` | `bc878fc` | Base; retain routing, TLS, rate limits, and Redis configuration. |
| `fix/egress-optimization` | `90955f4` | Defer shared static cache. This is local-only experimental work; its own README lists missing production validation, deploy skew, content-type checks, and purge-tag requirements. |
| `wip/edge-cookie-guard-uncommitted` | `fd63067` | Integrate cookie/Authorization bypass, Set-Cookie and error no-store guards, and preservation of Next.js Vary tokens. Reuse its page tests and stub. |
| `fix/edge-lcp` | `18255d8` | Defer shared image/static caching, non-identity cookie stripping, and prewarming. These use a separate local config; testing a stub that assumes tenant-independent assets does not establish that production has that property. |
| `fix/production-edge-lcp` | `6e93871` | Selectively merge the safety fixes, with the hardening below. Omit shared asset/image keys and cookie stripping. |

## Findings and integrated fixes

1. **Public purge forwarding.** `fly.toml` publishes raw TCP port 80, but the old HTTP site forwarded `/__cache*`
   to Caddy's admin API. The HTTPS exception also trusted private source IPs, which can be Fly gateway addresses
   for public traffic. Both public listeners now reject cache administration unconditionally. Port 9000 still
   serves `/__cache/*` privately and rejects unrelated admin paths such as `/config/`, `/load`, and `/stop`.
2. **Authenticated requests could read anonymous cached pages.** The old unconditional cache ran even with
   cookies or Authorization. Cache eligibility now requires GET/HEAD and no Cookie or Authorization header.
   Sensitive route roots and children are explicitly excluded. All cookies reach origin intact, including unknown
   cookies and NextAuth chunked session cookies. Such responses are also `private, no-store` downstream.
3. **Cookie responses could be replayed.** Souin in the tested build stores Set-Cookie on publicly cacheable
   responses. The new response handler preserves the visitor's cookie while forcing `private, no-store`.
4. **Next.js variants could collide.** Replacing Vary with a fixed `rsc, Accept-Encoding` removed router-state,
   prefetch, and language dimensions. The new normalization retains origin representation tokens and removes only
   the internal host tokens already covered by the host-specific cache key.
5. **Errors and partial responses could be cached.** Standard non-200 final status codes now become `no-store`,
   including cacheable-looking 404s, gateway errors, redirects, and 206 responses.
6. **Old entries survive a config change.** A new `edge-safe-v1-` key template prevents reusing entries created
   before these guards. Method, scheme, tenant host, full URI/query, and Vary dimensions remain separated. Existing
   Surrogate-Key invalidation continues to work. A deployment starts this namespace cold; older entries age out.

The production LCP cookie regex recognizes only unchunked session names and strips every other cookie on most
paths. For example, `__drk__session_token.0` would lose its cookie and become cache eligible. An unknown future
personalization cookie would also be discarded. The integrated policy bypasses all cookie-bearing requests.

Shared static caching also needs a production purge contract: the stub emits the `static` tag, but the inspected
storefront configuration does not establish that every production chunk emits it. The shared image branch
replaces Vary with `Accept` and removes Set-Cookie instead of rejecting storage. These assumptions need separate
origin validation before expanding shared cache eligibility.

## Validation

```sh
python3 scripts/check-production-edge.py
# Optional: EDGE_IMAGE=<custom-caddy-image> python3 scripts/check-production-edge.py
```

Requires Docker, Python 3, Node 20+, a local `redis:8-alpine` image, and the custom Caddy image
`dhimora-egress-caddy-test:latest`. Fixed loopback ports are checked before startup: 18137, 18138, 12137, 19000,
16387, 19387, and 19388. The runner adapts the production Caddyfile, changes only listener/TLS infrastructure and
local upstream/admin addresses, then starts disposable Caddy/Redis containers and two storefront stubs. It removes
its own containers and stops its stub processes on exit. It never accesses Fly or a shared Redis database.

The existing page suite runs separately through production and pre-production routing. It covers Redis HITs,
tenant separation, RSC/router-tree and language variants, gzip, Set-Cookie, cookie/Authorization bypass, errors, and
scoped tag purging. Additional checks cover public purge rejection, private API restrictions and tag purging,
unknown/chunked cookies, HEAD/GET separation, POST bypass, redirects, partial responses, downstream no-store, and
the cache namespace. Final result: 44 assertions per upstream route plus 82 additional assertions, all 170 passing.
Running the suite against original master reproduced 10 failing assertions, including cookie
replay, lost router-tree/language dimensions, and a cached 404.

Validated using Caddy 2.11.9, cache-handler 0.17.0, Souin 1.7.9, and Redis storage 0.0.23. The running Fly Caddy
also reports 2.11.9. This does not validate production Redis credentials/connectivity or TLS issuance. The Dockerfile
still builds unpinned plugins; rerun the suite with any newly built deployment image before deployment.

## Fly observations (read-only)

- `caddy-daddy`: inspected config, machine inventory, logs, deployed Caddyfile, and Caddy version. The active
  machine still uses the old cache policy. One machine is running and three are stopped, using a canary image
  outside normal Fly Launch management. Machines have no attached volume, despite the repository mount declaration.
- `dhimora-echo-ecommerce`: six started storefront machines at review time.
- `dhimora-backend-test`: one started machine with a passing health check, one stopped machine. Its deployment
  configuration identifies it as pre-production.

No remote branch push, cache purge, reload, machine update, or deployment was performed. Other local branches and
their existing worktree were preserved.

Configuration references: [Caddy reverse proxy response handling](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
and [cache-handler key/Vary configuration](https://github.com/caddyserver/cache-handler).
