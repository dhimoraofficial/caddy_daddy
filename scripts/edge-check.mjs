#!/usr/bin/env node
/*
 * Page/cache regression suite used by check-production-edge.py.
 *
 *   node scripts/edge-check.mjs
 *
 * Needs three things running (check-production-edge.py starts them):
 *   - the stub storefront:        node scripts/stub-upstream.mjs        (STUB_URL, default http://127.0.0.1:3937)
 *   - Caddy with the production routes                                (EDGE_URL, default http://127.0.0.1:8137)
 *   - Caddy's admin listener, which serves the Souin API                (EDGE_ADMIN_URL, default http://127.0.0.1:2137)
 *
 * Prints PASS / FAIL per assertion and OBSERVED lines for behaviour that is recorded, not asserted.
 * Exits 1 if any assertion fails. Every run uses fresh hostnames and purges its own store tags at the end.
 * Node 20+, no dependencies.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const EDGE = new URL(process.env.EDGE_URL || 'http://127.0.0.1:8137');
const ADMIN = new URL(process.env.EDGE_ADMIN_URL || 'http://127.0.0.1:2137');
const STUB = new URL(process.env.STUB_URL || 'http://127.0.0.1:3937');

const RUN = randomBytes(3).toString('hex');
const SUFFIX = process.env.EDGE_TEST_HOST_SUFFIX || 'edge.test';
const TA = `store-a-${RUN}.${SUFFIX}`;
const TB = `store-b-${RUN}.${SUFFIX}`;
const TC = `store-c-${RUN}.${SUFFIX}`;
const SESSION = `tok-${RUN}`;
const STOREFRONT_CACHE_CONTROL = 'public, max-age=300, s-maxage=7200, stale-while-revalidate=86400';

const outcomes = [];
function record(level, id, text) {
  outcomes.push(level);
  console.log(`${level.padEnd(10)}${id.padEnd(8)}${text}`);
}
function check(id, ok, passText, failText) {
  record(ok ? 'PASS' : 'FAIL', id, ok ? passText : failText);
  return ok;
}
const observe = (id, text) => record('OBSERVED', id, text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(base, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port, method, path, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            text: raw.toString('utf8'),
            ms: Number(process.hrtime.bigint() - started) / 1e6,
          });
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('timeout after 10s')));
    req.on('error', reject);
    req.end();
  });
}

const edge = (host, path, headers = {}) => request(EDGE, path, { headers: { Host: host, ...headers } });
const purgeTag = (tags) => request(ADMIN, '/__cache/souin/', { method: 'PURGE', headers: { 'Surrogate-Key': tags } });
const stubControl = async (method, path) => JSON.parse((await request(STUB, path, { method })).text);
const stubState = () => stubControl('GET', '/__control/state');
const stubRenders = async (host, path) => (await stubState()).renders[`${host} ${path}`] ?? 0;
const cookieText = (res) => (res.headers['set-cookie'] ?? []).join('; ');

// Souin reports the cache state in the Cache-Status header (RFC 9211 style), e.g.
//   "Souin; fwd=uri-miss; stored; key=..."            on a miss that was stored
//   "Souin; fwd=uri-miss; detail=NO-STORE-DIRECTIVE"  on a miss that was not stored (MISS here)
//   "Souin; hit; ttl=7199; key=...; detail=REDIS"     on a hit served from Redis
//   "Souin; fwd=bypass; detail=EXCLUDED-REQUEST-URI"  on an excluded path
function cacheOf(res) {
  const raw = res.headers['cache-status'] ?? '';
  let state = raw ? 'OTHER' : 'NONE';
  if (/;\s*hit\b/.test(raw)) state = 'HIT';
  else if (/fwd=uri-miss/.test(raw)) state = 'MISS';
  else if (/fwd=stale/.test(raw)) state = 'STALE';
  else if (/fwd=bypass/.test(raw)) state = 'BYPASS';
  const ttl = /ttl=(\d+)/.exec(raw);
  const detail = /detail=([A-Za-z-]+)/.exec(raw);
  return { raw, state, ttl: ttl ? Number(ttl[1]) : null, detail: detail ? detail[1] : null };
}

const renderOf = (text) => {
  const m = /render[ =](\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};
const versionOf = (text) => {
  const m = /version[ =](\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};
const tenantOf = (text) => {
  const m = /for ([a-z0-9.-]+)/.exec(text);
  return m ? m[1] : null;
};
const jsonOf = (res) => {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
};
const gunzipOrNull = (buf) => {
  try {
    return gunzipSync(buf).toString('utf8');
  } catch {
    return null;
  }
};
// The render counter legitimately differs between two origin renders (text: "render 2", RSC: "render=2",
// attribute: data-render="2"); compare everything else.
const withoutRenderCounter = (text) => (text ?? '').replace(/render\W{1,2}\d+/g, 'render N');

async function groupCaching() {
  const a1 = await edge(TA, '/');
  const c1 = cacheOf(a1);
  const r1 = await stubRenders(TA, '/');
  check(
    'a1',
    a1.status === 200 && c1.state === 'MISS' && renderOf(a1.text) === 1 && r1 === 1,
    `first GET / is a MISS (${c1.raw}); stub rendered it once`,
    `first GET / expected MISS and render 1, got status=${a1.status} state=${c1.state} render=${renderOf(a1.text)} stubRenders=${r1} cache-status="${c1.raw}"`,
  );

  const a2 = await edge(TA, '/');
  const c2 = cacheOf(a2);
  const r2 = await stubRenders(TA, '/');
  check(
    'a2',
    c2.state === 'HIT' && a2.text === a1.text && r2 === 1,
    `second GET / is a HIT with identical bytes; stub render count still ${r2}`,
    `second GET / expected HIT, identical body and render 1; got state=${c2.state} identical=${a2.text === a1.text} stubRenders=${r2}`,
  );

  check(
    'a3',
    c2.detail === 'REDIS',
    'Souin answers from the Redis storage (detail=REDIS), not its in-memory fallback',
    `Souin detail=${c2.detail}, expected REDIS (look for "Error during Redis init" in the Caddy log)`,
  );

  check(
    'a4',
    a1.headers['cache-control'] === STOREFRONT_CACHE_CONTROL && a2.headers['cache-control'] === STOREFRONT_CACHE_CONTROL,
    'storefront Cache-Control reaches the browser unchanged',
    `Cache-Control on the browser response was "${a1.headers['cache-control']}"`,
  );

  check(
    'a5',
    !a1.headers['surrogate-key'] && !a2.headers['surrogate-key'],
    'Surrogate-Key is stripped from browser responses (tags stay in Redis for purge, see e1)',
    `Surrogate-Key leaked to the browser: "${a1.headers['surrogate-key'] ?? a2.headers['surrogate-key']}"`,
  );

  check(
    'a6',
    c2.ttl !== null && c2.ttl > 300 && c2.ttl <= 7200,
    `Souin TTL follows s-maxage (ttl=${c2.ttl}, not max-age=300)`,
    `Souin ttl=${c2.ttl}, expected 300 < ttl <= 7200 (s-maxage=7200)`,
  );

  const a7 = await edge(TA, '/', { 'Cache-Control': 'no-cache', Pragma: 'no-cache' });
  const r7 = await stubRenders(TA, '/');
  check(
    'a7',
    cacheOf(a7).state === 'HIT' && r7 === 1,
    'browser reload headers (Cache-Control: no-cache, Pragma: no-cache) do not bypass the edge cache',
    `reload request state=${cacheOf(a7).state}, stub render count=${r7}`,
  );

  return { a1 };
}

async function groupSharedHtml({ a1 }) {
  const b1 = await edge(TA, '/', { Cookie: `session=${SESSION}` });
  const r = await stubRenders(TA, '/');
  const b2 = await edge(TA, '/');
  const r2 = await stubRenders(TA, '/');
  check(
    'b1',
    cacheOf(b1).state !== 'HIT' && b1.text.includes(SESSION) && r === 2 && cacheOf(b2).state === 'HIT' &&
      b2.text === a1.text && r2 === 2 && !b2.text.includes(SESSION),
    'session request bypasses shared storage; the anonymous page remains a HIT without session data',
    `cookie state=${cacheOf(b1).state} cookie echoed=${b1.text.includes(SESSION)} renders=${r}; next anonymous state=${cacheOf(b2).state} identical=${b2.text === a1.text} renders=${r2}`,
  );
}

async function groupApi() {
  // /api/cart sets a cart cookie, so the cookie guard makes its Cache-Control no-store (same for browsers as
  // "private, no-store"). /api/session sets no cookie and keeps its Cache-Control exactly.
  for (const [id, path] of [
    ['c1', '/api/cart'],
    ['c2', '/api/session'],
  ]) {
    const first = await edge(TA, path, { Cookie: `session=${SESSION}` });
    const second = await edge(TA, path, { Cookie: `session=${SESSION}` });
    const s1 = jsonOf(first)?.seq;
    const s2 = jsonOf(second)?.seq;
    const cc = second.headers['cache-control'] ?? '';
    const ccOk = path === '/api/session' ? cc === 'private, no-store' : /no-store/.test(cc);
    const neverCached = cacheOf(first).state !== 'HIT' && cacheOf(second).state !== 'HIT';
    check(
      id,
      neverCached && Number.isInteger(s1) && s2 === s1 + 1 && ccOk,
      `${path} is never served from cache (seq ${s1} then ${s2}; ${cacheOf(second).detail ?? cacheOf(second).state}; Cache-Control "${cc}")`,
      `${path}: states ${cacheOf(first).state}/${cacheOf(second).state}, seq ${s1} then ${s2}, Cache-Control "${cc}"`,
    );
  }
}

async function groupTenants({ a1 }) {
  const d1 = await edge(TB, '/');
  check(
    'd1',
    cacheOf(d1).state === 'MISS' && tenantOf(d1.text) === TB,
    'store B first GET / is a MISS and renders store B (store A entry is not reused)',
    `store B first GET / state=${cacheOf(d1).state} rendered=${tenantOf(d1.text)}`,
  );

  const d2 = await edge(TB, '/');
  check(
    'd2',
    cacheOf(d2).state === 'HIT' && d2.text === d1.text,
    'store B second GET / is a HIT with store B bytes',
    `store B second GET / state=${cacheOf(d2).state} identical=${d2.text === d1.text}`,
  );

  const d3 = await edge(TA, '/');
  check(
    'd3',
    cacheOf(d3).state === 'HIT' && d3.text === a1.text,
    'store A still answers from its own entry after store B was cached',
    `store A GET / state=${cacheOf(d3).state} identical=${d3.text === a1.text}`,
  );

  // Caddy overwrites X-Forwarded-Host from Host, so a client cannot pick another store.
  const d4 = await edge(TA, '/', { 'X-Forwarded-Host': TB });
  check(
    'd4',
    tenantOf(d4.text) === TA,
    'client X-Forwarded-Host cannot change the store rendered (Caddy sets it from Host)',
    `Host=${TA} with X-Forwarded-Host=${TB} rendered store ${tenantOf(d4.text)}`,
  );
  const shared = cacheOf(d4).state === 'HIT';
  observe(
    'obs-d4',
    `client X-Forwarded-Host=${TB} with Host=${TA}: Souin ${cacheOf(d4).state}, ${shared ? 'shares the Host-only entry (the Vary override drops X-Forwarded-Host from the key)' : 'a separate key from the Host-only entry'}`,
  );
}

async function groupVary({ a1 }) {
  const g1 = await edge(TA, '/', { RSC: '1', 'Next-Router-State-Tree': 'tree-a' });
  check(
    'g1',
    (g1.headers['content-type'] ?? '').startsWith('text/x-component') && g1.text.startsWith('1:"rsc'),
    'RSC request gets the RSC payload',
    `RSC request content-type "${g1.headers['content-type']}"`,
  );

  const g2 = await edge(TA, '/');
  check(
    'g2',
    (g2.headers['content-type'] ?? '').startsWith('text/html') && g2.text === a1.text,
    'plain HTML request after an RSC request still gets the cached HTML (Vary: rsc is honoured)',
    `plain GET / after RSC got content-type "${g2.headers['content-type']}" state=${cacheOf(g2).state}`,
  );

  const g3 = await edge(TA, '/', { RSC: '1', 'Next-Router-State-Tree': 'tree-a' });
  check(
    'g3',
    cacheOf(g3).state === 'HIT' && g3.text === g1.text,
    'repeated RSC request is a HIT with the RSC payload',
    `repeated RSC request state=${cacheOf(g3).state} identical=${g3.text === g1.text}`,
  );
  const g4 = await edge(TA, '/', { RSC: '1', 'Next-Router-State-Tree': 'tree-b' });
  check(
    'g4',
    cacheOf(g4).state !== 'HIT' && g4.text !== g1.text && g4.text.includes('tree=tree-b'),
    'a different Next router tree gets its own RSC representation',
    'different router tree state=' + cacheOf(g4).state + ' body=' + g4.text.slice(0, 100),
  );

  const varyTokens = (g4.headers.vary ?? '').split(',').map((token) => token.trim().toLowerCase());
  check(
    'g5',
    ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'accept-encoding', 'accept-language']
      .every((token) => varyTokens.includes(token)) &&
      !['host', 'x-forwarded-host', 'x-tenant-domain'].some((token) => varyTokens.includes(token)),
    'origin Next.js representation and locale Vary tokens reach the browser without proxy tenant headers',
    'Vary "' + (g4.headers.vary ?? '') + '"',
  );

  const localeA = await edge(TB, '/', { 'Accept-Language': 'en' });
  const localeB = await edge(TB, '/', { 'Accept-Language': 'fr' });
  const localeARepeat = await edge(TB, '/', { 'Accept-Language': 'en' });
  check(
    'g6',
    localeA.text.includes('data-language="en"') && localeB.text.includes('data-language="fr"') &&
      localeA.text !== localeB.text && cacheOf(localeB).state !== 'HIT' &&
      cacheOf(localeARepeat).state === 'HIT' && localeARepeat.text === localeA.text,
    'Accept-Language representations use separate entries and the matching locale hits',
    'locale states ' + cacheOf(localeA).state + '/' + cacheOf(localeB).state + '/' +
      cacheOf(localeARepeat).state + ', content en=' + localeA.text.includes('data-language="en"') +
      ' fr=' + localeB.text.includes('data-language="fr"'),
  );
}

async function groupGzip() {
  const path = '/category/shoes';
  const h1 = await edge(TA, path, { 'Accept-Encoding': 'gzip' });
  const h1Text = gunzipOrNull(h1.raw);
  check(
    'h1',
    h1.headers['content-encoding'] === 'gzip' && h1Text !== null && h1Text.includes(`for ${TA}`),
    'gzip request gets a gzip-encoded page that decodes to the store page',
    `gzip request content-encoding="${h1.headers['content-encoding']}" decodes=${h1Text !== null}`,
  );

  const h2 = await edge(TA, path);
  check(
    'h2',
    !h2.headers['content-encoding'] && withoutRenderCounter(h2.text) === withoutRenderCounter(h1Text),
    'identity request is not served the gzip variant (Vary: Accept-Encoding is honoured)',
    `identity request content-encoding="${h2.headers['content-encoding']}" state=${cacheOf(h2).state}`,
  );

  const h3 = await edge(TA, path, { 'Accept-Encoding': 'gzip' });
  const h3Text = gunzipOrNull(h3.raw);
  check(
    'h3',
    cacheOf(h3).state === 'HIT' && h3.headers['content-encoding'] === 'gzip' && h3Text === h1Text,
    'repeated gzip request is a HIT whose cached gzip body decodes to the same page',
    `repeated gzip state=${cacheOf(h3).state} content-encoding="${h3.headers['content-encoding']}"`,
  );
}

// The cookie guard. A response that sets a cookie is never stored (Souin would replay the cookie to every later
// visitor), and the cookie still reaches the browser that asked for it.
async function groupSetCookie() {
  // p1: two anonymous visitors on a public page that sets a cookie. Visitor 2 must not get visitor 1's cookie.
  const p1 = await edge(TA, '/private-leak');
  const setCookie1 = p1.headers['set-cookie'] ?? [];
  const p2 = await edge(TA, '/private-leak');
  const setCookie2 = p2.headers['set-cookie'] ?? [];
  const replayed = setCookie1.some((cookie) => setCookie2.includes(cookie));
  check(
    'p1',
    !replayed,
    'a Set-Cookie on a publicly cacheable response is not replayed to another visitor',
    `visitor 2 (no cookie) received visitor 1's Set-Cookie "${setCookie2.join('; ')}" with Cache-Status ${cacheOf(p2).state}: Souin stores Set-Cookie and replays it`,
  );
  check(
    'p1b',
    setCookie1.length > 0,
    'the first visitor still receives its own Set-Cookie (the guard does not strip cookies)',
    'the first visitor received no Set-Cookie: the guard must keep cookies and only stop storage',
  );
  observe(
    'obs-p1',
    `Set-Cookie route: visitor 1 ${cacheOf(p1).state} (set-cookie x${setCookie1.length}), visitor 2 ${cacheOf(p2).state} (set-cookie x${setCookie2.length})`,
  );

  // p2: a visitor who carries a session cookie gets a Set-Cookie on a public page. The anonymous visitor who comes
  // next must not get that cookie. Own host, so the first request is a MISS (the "only when the request has no
  // cookie" variant fails exactly here).
  const p3a = await edge(TC, '/private-leak', { Cookie: `session=${SESSION}` });
  const p3b = await edge(TC, '/private-leak');
  const cookieA = p3a.headers['set-cookie'] ?? [];
  const cookieB = p3b.headers['set-cookie'] ?? [];
  check(
    'p2',
    cookieA.length > 0 && !cookieA.some((cookie) => cookieB.includes(cookie)),
    `a visitor who sent a cookie gets a Set-Cookie on a public page, and the next anonymous visitor does not get it (Cache-Status ${cacheOf(p3b).state})`,
    `the next anonymous visitor got the cookie of a visitor with a session: "${cookieB.join('; ')}" (state ${cacheOf(p3b).state})`,
  );
}

// Login and cart keep their cookies, and the cookie guard never lets a cookie be replayed. Private pages are not
// stored. Both come from the stub: /auth/signin is excluded by the regex, /api/cart is excluded and private.
async function groupCookiePolicy() {
  const l1 = await request(EDGE, '/auth/signin', { method: 'POST', headers: { Host: TA } });
  const l2 = await request(EDGE, '/auth/signin', { method: 'POST', headers: { Host: TA } });
  const sc1 = cookieText(l1);
  const sc2 = cookieText(l2);
  check(
    'l1',
    l1.status === 200 && /session=signin-\d+/.test(sc1),
    `login (POST /auth/signin) passes its session cookie to the browser (${sc1})`,
    `login status ${l1.status}, Set-Cookie "${sc1}"`,
  );
  check(
    'l2',
    cacheOf(l2).state !== 'HIT' && /session=signin-\d+/.test(sc2) && sc2 !== sc1,
    `a second login is not a cached replay: it has its own cookie (${sc2}), Cache-Status ${cacheOf(l2).state}`,
    `second login: state ${cacheOf(l2).state}, Set-Cookie "${sc2}" (first "${sc1}")`,
  );

  const k1 = await edge(TA, '/api/cart');
  const k2 = await edge(TA, '/api/cart');
  const ck1 = cookieText(k1);
  const ck2 = cookieText(k2);
  check(
    'k1',
    /cart=cart-\d+/.test(ck1) && cacheOf(k1).state !== 'HIT',
    `a cart call passes its cart cookie to the browser (${ck1}) and is not served from cache`,
    `cart call: Set-Cookie "${ck1}", state ${cacheOf(k1).state}`,
  );
  check(
    'k2',
    /cart=cart-\d+/.test(ck2) && ck2 !== ck1 && cacheOf(k2).state !== 'HIT',
    `the next cart call gets its own cart cookie (${ck2}), not a replay of the first`,
    `next cart call: Set-Cookie "${ck2}" (first "${ck1}"), state ${cacheOf(k2).state}`,
  );

  const v1 = await edge(TA, '/private-page');
  const rv1 = await stubRenders(TA, '/private-page');
  const v2 = await edge(TA, '/private-page');
  const rv2 = await stubRenders(TA, '/private-page');
  check(
    'pv1',
    v1.status === 200 && cacheOf(v2).state !== 'HIT' && rv2 === rv1 + 1 && v2.headers['cache-control'] === 'private, max-age=300',
    `a private response is not stored: the second GET renders again (renders ${rv1} -> ${rv2}), Cache-Control unchanged`,
    `private response: second GET state ${cacheOf(v2).state}, renders ${rv1} -> ${rv2}, Cache-Control "${v2.headers['cache-control']}"`,
  );

  const w1 = await edge(TA, '/private-cookie');
  const w2 = await edge(TA, '/private-cookie');
  const cw1 = cookieText(w1);
  const cw2 = cookieText(w2);
  check(
    'pv2',
    /session=leak-\d+/.test(cw1) && cw2 !== cw1 && cacheOf(w2).state !== 'HIT' && /no-store/.test(w2.headers['cache-control'] ?? ''),
    `a private response that sets a cookie: the cookie reaches the browser (${cw1}), the second visitor gets a fresh one, and it is no-store`,
    `private+cookie response: "${cw1}" then "${cw2}", state ${cacheOf(w2).state}, Cache-Control "${w2.headers['cache-control']}"`,
  );

  const publicPath = '/category/shoes';
  const publicWarm = await edge(TC, publicPath);
  const withSession = await edge(TC, publicPath, { Cookie: `session=${SESSION}; unknown-preference=blue` });
  const withAuthorization = await edge(TC, publicPath, { Authorization: `Bearer ${SESSION}` });
  const publicAfter = await edge(TC, publicPath);
  check(
    'cv1',
    cacheOf(publicWarm).state === 'MISS' && cacheOf(withSession).state !== 'HIT' &&
      cacheOf(withAuthorization).state !== 'HIT' && cacheOf(publicAfter).state === 'HIT' &&
      withSession.text.includes(`session=${SESSION}`) && withSession.text.includes('unknown-preference=blue') &&
      withAuthorization.text.includes(`Bearer ${SESSION}`) && !publicAfter.text.includes(SESSION),
    'cookie and Authorization requests bypass shared storage; the warm anonymous page still hits without visitor data',
    'states ' + cacheOf(publicWarm).state + '/' + cacheOf(withSession).state + '/' +
      cacheOf(withAuthorization).state + '/' + cacheOf(publicAfter).state +
      ', visitor data leaked to anonymous=' + publicAfter.text.includes(SESSION),
  );
}

async function groupErrorResponses() {
  for (const [id, path, expectedStatus] of [
    ['er1', '/error-404', 404],
    ['er2', '/error-504', 504],
  ]) {
    const before = await stubRenders(TA, path);
    const first = await edge(TA, path);
    const second = await edge(TA, path);
    const after = await stubRenders(TA, path);
    check(
      id,
      first.status === expectedStatus && second.status === expectedStatus && cacheOf(first).state !== 'HIT' &&
        cacheOf(second).state !== 'HIT' && after === before + 2 && /no-store/.test(second.headers['cache-control'] ?? ''),
      expectedStatus + ' response is no-store and the next request reaches origin again',
      path + ': statuses ' + first.status + '/' + second.status + ', states ' + cacheOf(first).state + '/' +
        cacheOf(second).state + ', renders ' + before + ' -> ' + after + ', Cache-Control "' +
        (second.headers['cache-control'] ?? '') + '"',
    );
  }
}

async function groupPurge() {
  await edge(TA, '/category/shoes');
  await stubControl('POST', '/__control/bump');

  const e1 = await purgeTag(`page:${TA}:home`);
  check(
    'e1',
    e1.status === 204,
    'PURGE with Surrogate-Key page:<store A>:home answers 204 on the Souin API (admin listener)',
    `PURGE returned ${e1.status} ${e1.text.slice(0, 120)}`,
  );

  const e2 = await edge(TA, '/');
  check(
    'e2',
    cacheOf(e2).state === 'MISS' && versionOf(e2.text) === 2,
    'after the purge, store A home is a MISS and renders the new version',
    `store A home after purge state=${cacheOf(e2).state} version=${versionOf(e2.text)}`,
  );

  const e3 = await edge(TA, '/category/shoes');
  check(
    'e3',
    cacheOf(e3).state === 'HIT' && versionOf(e3.text) === 1,
    'other tags are untouched: store A category page is still a HIT with the old version',
    `store A category after purge state=${cacheOf(e3).state} version=${versionOf(e3.text)}`,
  );

  const e4 = await edge(TB, '/');
  check(
    'e4',
    cacheOf(e4).state === 'HIT' && versionOf(e4.text) === 1,
    'other stores are untouched: store B home is still a HIT with the old version',
    `store B home after purge state=${cacheOf(e4).state} version=${versionOf(e4.text)}`,
  );

  const e5Purge = await purgeTag(`layout:${TB}:home, page:${TB}:home`);
  const e5 = await edge(TB, '/');
  check(
    'e5',
    e5Purge.status === 204 && cacheOf(e5).state === 'MISS' && versionOf(e5.text) === 2,
    'PURGE with a comma-separated tag list evicts the page it names',
    `comma PURGE returned ${e5Purge.status}; then store B home state=${cacheOf(e5).state} version=${versionOf(e5.text)}`,
  );

  const e6Purge = await purgeTag(`store:${TA}`);
  const e6 = await edge(TA, '/category/shoes');
  check(
    'e6',
    e6Purge.status === 204 && cacheOf(e6).state === 'MISS' && versionOf(e6.text) === 2,
    'a store-level tag purge evicts every cached page of store A',
    `store tag PURGE returned ${e6Purge.status}; then category state=${cacheOf(e6).state} version=${versionOf(e6.text)}`,
  );
}

async function groupSwr() {
  const f1 = await edge(TA, '/swr-probe');
  const origin1 = await stubRenders(TA, '/swr-probe');
  await sleep(3000);
  const originBefore2 = await stubRenders(TA, '/swr-probe');
  const f2 = await edge(TA, '/swr-probe');
  const originAfter2 = await stubRenders(TA, '/swr-probe');
  await sleep(1000);
  const f3 = await edge(TA, '/swr-probe');
  const originAfter3 = await stubRenders(TA, '/swr-probe');

  const servedStale = renderOf(f2.text) === 1 && originAfter2 === originBefore2;
  observe('obs-f1', `t0: ${cacheOf(f1).state}, render ${renderOf(f1.text)}, origin renders ${origin1} (${cacheOf(f1).raw})`);
  observe(
    'obs-f2',
    `t+3s (s-maxage=2 expired, stale-while-revalidate=30 still open): ${cacheOf(f2).state}, render ${renderOf(f2.text)}, ${f2.ms.toFixed(0)} ms, origin renders ${originBefore2} -> ${originAfter2}; stale served without an origin hit: ${servedStale ? 'yes' : 'no'}`,
  );
  observe('obs-f3', `t+4s: ${cacheOf(f3).state}, render ${renderOf(f3.text)}, origin renders ${originAfter2} -> ${originAfter3} (${cacheOf(f3).raw})`);
}

async function cleanup() {
  for (const host of [TA, TB, TC]) {
    await purgeTag(`store:${host}`);
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    check(name, false, '', `unexpected error in group ${name}: ${err.message}`);
    return undefined;
  }
}

function finish() {
  const count = (level) => outcomes.filter((l) => l === level).length;
  console.log(`\n${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('OBSERVED')} OBSERVED (run ${RUN})`);
  process.exitCode = count('FAIL') > 0 ? 1 : 0;
}

async function main() {
  console.log(`edge-check run ${RUN}: caddy ${EDGE.origin}, admin ${ADMIN.origin}, stub ${STUB.origin}`);

  try {
    await stubControl('POST', '/__control/reset');
    check('pre1', true, 'stub storefront reachable and reset', '');
  } catch (err) {
    check('pre1', false, '', `stub storefront not reachable at ${STUB.origin} (${err.message}); start it with: node scripts/stub-upstream.mjs`);
    return finish();
  }

  try {
    const health = await request(EDGE, '/health');
    check('pre2', health.status === 200 && health.text === 'ok', 'Caddy answers /health on the edge port', `Caddy /health returned ${health.status}`);
  } catch (err) {
    check('pre2', false, '', `Caddy not reachable at ${EDGE.origin} (${err.message}); start it with: python3 scripts/check-production-edge.py`);
    return finish();
  }

  try {
    const admin = await request(ADMIN, '/__cache/souin/');
    check('pre3', admin.status === 200, 'Souin API answers on the admin listener', `Souin API returned ${admin.status}`);
  } catch (err) {
    check('pre3', false, '', `Souin API not reachable at ${ADMIN.origin} (${err.message})`);
    return finish();
  }

  const ctxA = (await step('a', groupCaching)) ?? {};
  await step('b', () => groupSharedHtml(ctxA));
  await step('c', groupApi);
  await step('d', () => groupTenants(ctxA));
  await step('g', () => groupVary(ctxA));
  await step('h', groupGzip);
  await step('p', groupSetCookie);
  await step('policy', groupCookiePolicy);
  await step('errors', groupErrorResponses);
  await step('e', groupPurge);
  await step('f', groupSwr);
  await step('clean', cleanup);
  finish();
}

main().catch((err) => {
  console.error(`edge-check crashed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
