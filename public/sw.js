// Liftoff service worker.
//
// IMPORTANT: this app is now gated by a server-side session check (see
// server.js). The service worker must NEVER cache the authenticated page
// ("/") or the login page, or it could serve a stale copy of the checklist
// to a signed-out visitor while offline, bypassing the server's auth check.
// Only static, non-sensitive assets (manifest, icons) are cached, so the
// app still qualifies as installable on Android/Chrome.
var CACHE_NAME = 'liftoff-cache-v2';
var CACHEABLE_ASSETS = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache){ return cache.addAll(CACHEABLE_ASSETS); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;

  // Page navigations (loading "/" or "/login.html") always go to the
  // network so the server's session check runs every time. Never served
  // from cache, and never cached.
  if(req.mode === 'navigate'){
    event.respondWith(fetch(req).catch(function(){
      return new Response('You are offline. Reconnect to sign in and use the checklist.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      });
    }));
    return;
  }

  // Everything else (manifest, icons): cache-first with background refresh.
  event.respondWith(
    caches.match(req).then(function(cached){
      var network = fetch(req).then(function(res){
        if(res && res.status === 200 && res.type === 'basic'){
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(req, clone); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
