// Festival Navigator service worker — offline-first app shell.
// Bump CACHE_VERSION whenever you change cached static assets.
// v77 = a clash is a set of sets that ALL overlap, not a chain of pairwise
// overlaps. A-B and B-C no longer drag A and C into one group.
const CACHE_VERSION = 'festival-nav-v77';

// The shell that MUST be complete for offline to be real: if any of these
// fail, install fails and the old worker keeps serving — a half-cached shell
// that claims offline-ready is a lie that surfaces in a muddy field (PS-1).
const APP_CORE = [
  '/',
  '/index.html',
  '/assets/v3-tokens.css',
  '/assets/v3.css',
  '/assets/fonts/fonts.css',
  '/assets/fonts/anton-400-latin.woff2',
  '/assets/fonts/inter-var-latin.woff2',
  '/js/state.js',
  '/js/sync.js',
  '/js/crew.js',
  '/js/festivals.js',
  '/js/merge.js',
  '/js/time.js',
  '/js/overlap.js',
  '/js/parse.js',
  '/js/util.js',
  '/js/spotify.js',
  '/js/name-rules.mjs',
  '/js/v3/app.js',
  '/js/v3/wall.js',
  '/js/v3/notes.js',
  '/js/v3/settings.js',
  '/js/v3/tools.js',
  '/js/v3/model.js',
  '/js/v3/aura.js',
  '/js/v3/palette.js',
  '/js/v3/favicon.js',
  '/js/v3/router.js',
  '/js/v3/sort-control.js',
  '/js/discovery/artist-page.js',
  '/js/discovery/genres.js',
  '/js/discovery/score.js',
  '/js/discovery/setinfo.js',
  '/js/discovery/player.js',
  '/js/discovery/player-core.js',
  '/js/discovery/deck.js',
  '/js/discovery/filter.js',
  '/js/discovery/gaps.js',
  '/js/discovery/my-day.js',
  '/js/discovery/decide.js',
  '/assets/discovery.css',
  '/data/festivals/index.json',
  // Repo-owned genre canon (js/discovery/genres.js's loadGenreCanon) — every
  // Discovery surface that ranks (deck, filter sheet, For-you wall, artist
  // page's Similar section) reads it. Missing from the M3 precache list;
  // fixed here rather than carried forward into another milestone.
  '/data/genres.json',
];

// Nice-to-have: failures here never block install.
const APP_EXTRAS = [
  '/404.html',
  '/vendor/html2canvas.min.js',
  '/spotify-callback',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
];
// Per-festival JSONs are cached at first fetch by the handler below, so a
// festival you have opened once keeps working offline.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Atomic core (addAll fails install if ANY core asset fails), then
      // best-effort extras.
      cache.addAll(APP_CORE).then(() =>
        Promise.all(APP_EXTRAS.map((url) => cache.add(new Request(url)).catch(() => {})))
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (api.spotify.com, accounts.spotify.com, analytics): never
  // ours to cache — a cache-first Spotify API response made every re-scan
  // one scan stale, silently (SPOT-4). Let the browser handle it untouched.
  if (url.origin !== location.origin) return;

  // API calls: always go to the network (sync needs fresh data). If offline,
  // the app already has localStorage, so a failed fetch is handled client-side.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response('{}', {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Navigations: network-first so a stale worker can never pin an old shell
  // on a returning device (PS-2); cache is the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // Static assets: cache-first, then update the cache in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
