#!/usr/bin/env node
/*
 * Stub storefront for scripts/check-production-edge.py.
 * Run: node scripts/stub-upstream.mjs   (listens on 127.0.0.1:${STUB_PORT}, default 3937)
 *
 * It mimics only the parts of the Next.js storefront that matter to the edge cache:
 *  - tenant = X-Forwarded-Host, else X-Tenant-Domain, else Host
 *    (README.md says the storefront receives X-Forwarded-Host = tenant domain)
 *  - "/" and "/category/shoes": shared HTML, identical bytes for every visitor, never varies on
 *    Cookie. Next-style Cache-Control, Vary and Surrogate-Key headers. Render counter per tenant+path.
 *  - "/api/cart": private, no-store, JSON with a per-request seq, and a cart cookie on every response.
 *  - "/api/session": private, no-store, JSON with a per-request seq.
 *  - "/auth/signin" (GET or POST): login. A session cookie per call, and a cacheable-looking Cache-Control on
 *    purpose: the production exclude regex (/auth/) is what keeps it out of the cache.
 *  - "/private-leak": publicly cacheable response that also sets a per-visitor Set-Cookie (to observe Souin).
 *  - "/private-page": Cache-Control private, max-age=300, no cookie. Souin must not store it.
 *  - "/private-cookie": Cache-Control private, max-age=300, plus a per-visitor Set-Cookie.
 *  - "/swr-probe": short s-maxage / stale-while-revalidate so stale serving can be observed in seconds.
 *  - "/_next/static/*": immutable build assets (tenant-independent bytes), a 404 chunk, and the tenant data
 *    route /_next/data/... (the asset checks; see README.assets-cache.md).
 *  - "/_next/image": image optimizer. The bytes depend only on url, w, q and the Accept header (avif, webp or
 *    jpeg), like Next.js. Cache-Control is "public, max-age=<minimumCacheTTL>, must-revalidate" and Vary: Accept.
 *  - "/__control/*": bump the page version, reset state, read state and the last request seen, and arm a
 *    one-off 504 for an image width (POST /__control/image-504-once?w=<width>).
 */
import http from 'node:http';

const HOST = process.env.STUB_HOST || '127.0.0.1';
const PORT = Number(process.env.STUB_PORT || 3937);

const STOREFRONT_CACHE_CONTROL = 'public, max-age=300, s-maxage=7200, stale-while-revalidate=86400';
const STOREFRONT_VARY = 'Host, X-Forwarded-Host, x-tenant-domain, RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Accept-Encoding, Accept-Language';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const IMAGE_MIN_TTL = 2592000; // stands in for next.config.js images.minimumCacheTTL (30 days)
const IMAGE_CACHE_CONTROL = `public, max-age=${IMAGE_MIN_TTL}, must-revalidate`;
const IMAGE_BIG_W = '3840'; // the one width that returns a 1.2 MB body, for the size cap
const IMAGE_TYPE = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg' };
const APP_JS = '/_next/static/chunks/app.js';
const COOKIE_JS = '/_next/static/chunks/cookie-probe.js';
const MISSING_JS = '/_next/static/chunks/missing.js';
const DATA_JSON = '/_next/data/stub-build/category/shoes.json';
const CSS_APP = '/_next/static/css/app.css';
const ROUTE_GROUP_JS = '/_next/static/chunks/app/(shop)/[slug]/page-probe.js';

const PAGES = {
  '/': {
    title: 'Home',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    surrogateKey: (t) => `store:${t}, layout:${t}:home, page:${t}:home`,
  },
  '/category/shoes': {
    title: 'Shoes',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    surrogateKey: (t) => `store:${t}, layout:${t}:category, content:${t}:category:shoes`,
  },
  '/private-leak': {
    title: 'Leak probe',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    surrogateKey: (t) => `store:${t}, page:${t}:leak`,
    setCookie: true,
  },
  '/swr-probe': {
    title: 'SWR probe',
    cacheControl: 'public, max-age=1, s-maxage=2, stale-while-revalidate=30',
    surrogateKey: (t) => `store:${t}, page:${t}:swr`,
  },
  '/private-page': {
    title: 'Private page',
    cacheControl: 'private, max-age=300',
    surrogateKey: (t) => `store:${t}, page:${t}:private`,
  },
  '/private-cookie': {
    title: 'Private cookie',
    cacheControl: 'private, max-age=300',
    surrogateKey: (t) => `store:${t}, page:${t}:private-cookie`,
    setCookie: true,
  },
  '/error-404': {
    title: 'Not found',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    status: 404,
    surrogateKey: (t) => `store:${t}, page:${t}:error-404`,
  },
  '/error-504': {
    title: 'Gateway timeout',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    status: 504,
    surrogateKey: (t) => `store:${t}, page:${t}:error-504`,
  },
  '/partial-content': {
    title: 'Partial response',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    status: 206,
    surrogateKey: (t) => `store:${t}, page:${t}:partial`,
  },
  '/redirect-page': {
    title: 'Redirect response',
    cacheControl: STOREFRONT_CACHE_CONTROL,
    status: 302,
    surrogateKey: (t) => `store:${t}, page:${t}:redirect`,
  },
};
const API_PATHS = new Set(['/api/cart', '/api/session']);
const SIGNIN_PATH = '/auth/signin';

// Build assets: tenant-independent bytes. The surrogate keys carry no store tag on purpose.
const ASSETS = {
  [APP_JS]: {
    contentType: 'application/javascript; charset=utf-8',
    body: '/* stub build asset, identical for every tenant */\nwindow.__stubChunk = "app";\n',
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    surrogateKey: 'static, asset:chunks-app-js',
  },
  [COOKIE_JS]: {
    contentType: 'application/javascript; charset=utf-8',
    body: '/* stub asset that also sets a cookie */\nwindow.__stubChunk = "cookie";\n',
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    surrogateKey: 'static, asset:chunks-cookie-probe-js',
    setCookie: true,
  },
  [CSS_APP]: {
    contentType: 'text/css; charset=utf-8',
    body: '/* stub build css */\n' + Array.from({ length: 40 }, (_, i) => `.stub-rule-${i} { margin: 0; padding: 0; color: #111; }`).join('\n') + '\n',
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    surrogateKey: 'static, asset:css-app',
  },
  [ROUTE_GROUP_JS]: {
    contentType: 'application/javascript; charset=utf-8',
    body: '/* stub route-group chunk */\nwindow.__stubChunk = "route-group";\n',
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    surrogateKey: 'static, asset:chunks-route-group',
  },
};

function freshState() {
  return {
    version: 1,
    renders: {},
    assetHits: {},
    imageHits: {},
    apiSeq: 0,
    cartSeq: 0,
    signinSeq: 0,
    leakSeq: 0,
    assetLeakSeq: 0,
    imageCookieSeq: 0,
    imageFailOnce: [],
    last: null,
  };
}
let state = freshState();

function tenantOf(headers) {
  const raw = headers['x-forwarded-host'] || headers['x-tenant-domain'] || headers.host || 'unknown';
  return String(raw).split(',')[0].trim().toLowerCase();
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function htmlFor({ path, tenant, render, version, title, language, personalization }) {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<title>${title} - ${tenant}</title>
<link rel="canonical" href="https://${tenant}${path}">
</head>
<body>
<main data-tenant="${tenant}" data-path="${path}" data-version="${version}" data-render="${render}" data-language="${language}" data-personalization="${personalization}">
<h1>${title} for ${tenant}</h1>
<p>version ${version}, render ${render}</p>
<ul>
${Array.from({ length: 12 }, (_, i) => `<li>Item ${i + 1} for ${tenant}</li>`).join('\n')}
</ul>
</main>
</body>
</html>
`;
}

function servePage(req, res, path) {
  const cfg = PAGES[path];
  const tenant = tenantOf(req.headers);
  // Next.js RSC requests send "RSC: 1" and get a different payload for the same URL.
  const rsc = req.headers.rsc === '1';
  const routerTree = req.headers['next-router-state-tree'] || 'none';
  const language = req.headers['accept-language'] || 'en';
  const personalization = [req.headers.cookie, req.headers.authorization].filter(Boolean).join(' ');
  const key = `${tenant} ${path}${rsc ? ' rsc' : ''}`;
  state.renders[key] = (state.renders[key] || 0) + 1;
  const render = state.renders[key];
  const contentType = rsc ? 'text/x-component; charset=utf-8' : 'text/html; charset=utf-8';
  const text = rsc
    ? `1:"rsc tenant=${tenant} path=${path} version=${state.version} render=${render} tree=${routerTree} lang=${language} personalization=${personalization}"\n`
    : htmlFor({ path, tenant, render, version: state.version, title: cfg.title, language, personalization });
  const headers = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': cfg.cacheControl,
    Vary: STOREFRONT_VARY,
    'Surrogate-Key': cfg.surrogateKey(tenant),
  };
  if (cfg.setCookie) {
    headers['Set-Cookie'] = `session=leak-${++state.leakSeq}; Path=/; HttpOnly`;
  }
  res.writeHead(cfg.status ?? 200, headers);
  res.end(text);
}

function serveApi(res, path) {
  state.apiSeq += 1;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (path === '/api/cart') {
    state.cartSeq += 1;
    headers['Set-Cookie'] = `cart=cart-${state.cartSeq}; Path=/; HttpOnly`;
  }
  sendJson(res, 200, { route: path, seq: state.apiSeq }, headers);
}

// Login: a fresh session cookie per call. The Cache-Control is the cacheable one the storefront would send
// for a public page, so the test shows the exclude regex (and the cookie guard) are what keep it out of the cache.
function serveSignin(res, path) {
  state.signinSeq += 1;
  const text = JSON.stringify({ route: path, seq: state.signinSeq });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': STOREFRONT_CACHE_CONTROL,
    Vary: STOREFRONT_VARY,
    'Set-Cookie': `session=signin-${state.signinSeq}; Path=/; HttpOnly`,
  });
  res.end(text);
}

function serveAsset(res, path) {
  state.assetHits[path] = (state.assetHits[path] || 0) + 1;
  if (path === MISSING_JS) {
    const text = 'not found\n';
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': IMMUTABLE_CACHE_CONTROL,
      'Surrogate-Key': 'static, asset:chunks-missing-js',
    });
    return res.end(text);
  }
  const cfg = ASSETS[path];
  const headers = {
    'Content-Type': cfg.contentType,
    'Content-Length': Buffer.byteLength(cfg.body),
    'Cache-Control': cfg.cacheControl,
    'Surrogate-Key': cfg.surrogateKey,
  };
  if (cfg.setCookie) {
    headers['Set-Cookie'] = `session=asset-leak-${++state.assetLeakSeq}; Path=/; HttpOnly`;
  }
  res.writeHead(200, headers);
  res.end(cfg.body);
}

function serveData(req, res) {
  const tenant = tenantOf(req.headers);
  const key = `${tenant} ${DATA_JSON}`;
  state.renders[key] = (state.renders[key] || 0) + 1;
  const text = JSON.stringify({
    pageProps: { tenant, page: 'category/shoes', version: state.version, render: state.renders[key] },
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': STOREFRONT_CACHE_CONTROL,
    Vary: STOREFRONT_VARY,
    'Surrogate-Key': `store:${tenant}, data:${tenant}:category:shoes`,
  });
  res.end(text);
}

// Image optimizer, as Next.js answers /_next/image: the format follows the Accept header.
function imageFormat(accept = '') {
  if (accept.includes('image/avif')) return 'avif';
  if (accept.includes('image/webp')) return 'webp';
  return 'jpeg';
}

function serveImage(req, res, url) {
  const src = url.searchParams.get('url');
  const w = url.searchParams.get('w');
  const q = url.searchParams.get('q') ?? '75';
  const fmt = imageFormat(req.headers.accept);
  // Origin hits per format and exact query string (the key the tests use).
  const hitKey = `${fmt} ${url.search}`;
  state.imageHits[hitKey] = (state.imageHits[hitKey] || 0) + 1;

  if (src === null) return sendJson(res, 400, { error: 'url is required' }, { 'Cache-Control': 'no-store' });
  if (w !== null && !/^\d+$/.test(w)) return sendJson(res, 400, { error: 'w must be an integer' }, { 'Cache-Control': 'no-store' });
  if (w !== null && state.imageFailOnce.includes(w)) {
    // One-off gateway timeout. It carries a cacheable Cache-Control on purpose: the edge must still not store it.
    state.imageFailOnce = state.imageFailOnce.filter((x) => x !== w);
    const text = 'upstream timed out\n';
    res.writeHead(504, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': IMAGE_CACHE_CONTROL,
    });
    return res.end(text);
  }
  if (src.includes('missing')) {
    const text = 'not found\n';
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': IMAGE_CACHE_CONTROL,
    });
    return res.end(text);
  }
  const head = `IMG fmt=${fmt} w=${w ?? 'none'} q=${q} src=${src}\n`;
  const body = head + 'x'.repeat(Math.max(0, w === IMAGE_BIG_W ? 1_200_000 : 2048 - head.length));
  state.imageCookieSeq += 1;
  res.writeHead(200, {
    'Content-Type': IMAGE_TYPE[fmt],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': IMAGE_CACHE_CONTROL,
    Vary: 'Accept',
    'Set-Cookie': `img-session=${state.imageCookieSeq}; Path=/; HttpOnly`,
  });
  res.end(body);
}

function control(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/__control/bump') {
    state.version += 1;
    return sendJson(res, 200, { version: state.version });
  }
  if (req.method === 'POST' && pathname === '/__control/reset') {
    state = freshState();
    return sendJson(res, 200, { reset: true, version: state.version });
  }
  if (req.method === 'POST' && pathname === '/__control/image-504-once') {
    const w = url.searchParams.get('w');
    if (w === null) return sendJson(res, 400, { error: 'w is required' }, { 'Cache-Control': 'no-store' });
    state.imageFailOnce.push(w);
    return sendJson(res, 200, { armed: w });
  }
  if (req.method === 'GET' && pathname === '/__control/state') {
    return sendJson(res, 200, {
      version: state.version,
      renders: state.renders,
      assetHits: state.assetHits,
      imageHits: state.imageHits,
      apiSeq: state.apiSeq,
      cartSeq: state.cartSeq,
      signinSeq: state.signinSeq,
      leakSeq: state.leakSeq,
      assetLeakSeq: state.assetLeakSeq,
      imageCookieSeq: state.imageCookieSeq,
    });
  }
  if (req.method === 'GET' && pathname === '/__control/last') {
    return sendJson(res, 200, state.last ?? {});
  }
  return sendJson(res, 404, { error: 'unknown control route' }, { 'Cache-Control': 'no-store' });
}

const server = http.createServer((req, res) => {
  req.resume();
  const url = new URL(req.url, 'http://stub.invalid');

  if (url.pathname.startsWith('/__control/')) {
    return control(req, res, url);
  }

  state.last = { method: req.method, url: req.url, headers: req.headers };
  console.log(new Date().toISOString(), req.method, req.url, `tenant=${tenantOf(req.headers)}`);

  const isSignin = req.method === 'POST' && url.pathname === SIGNIN_PATH;
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isSignin) {
    return sendJson(res, 405, { error: 'method not allowed' }, { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === SIGNIN_PATH) {
    return serveSignin(res, url.pathname);
  }
  if (url.pathname === '/_next/image') {
    return serveImage(req, res, url);
  }
  if (url.pathname.startsWith('/_next/static/')) {
    if (ASSETS[url.pathname] || url.pathname === MISSING_JS) {
      return serveAsset(res, url.pathname);
    }
    return sendJson(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
  }
  if (url.pathname === DATA_JSON) {
    return serveData(req, res);
  }
  if (PAGES[url.pathname]) {
    return servePage(req, res, url.pathname);
  }
  if (API_PATHS.has(url.pathname)) {
    return serveApi(res, url.pathname);
  }
  return sendJson(res, 404, { error: 'not found' }, { 'Cache-Control': 'no-store' });
});

server.listen(PORT, HOST, () => {
  console.log(`stub storefront listening on http://${HOST}:${PORT}`);
});
