const CACHE_VERSION = 'v3.2';
const CACHE_NAME = `anime-os-cache-${CACHE_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './imagens/logo.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // { cache: 'reload' } força ignorar qualquer cópia guardada no navegador,
      // garantindo que pegamos os arquivos realmente atualizados do servidor.
      await Promise.all(
        ASSETS.map(async (url) => {
          const response = await fetch(url, { cache: 'reload' });
          return cache.put(url, response);
        })
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // 🚨 Ignora completamente requisições para outros domínios (APIs externas)
  // Deixa o navegador cuidar delas normalmente, sem passar pelo Service Worker.
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (
    event.request.mode === 'navigate' ||
    event.request.url.endsWith('.js') ||
    event.request.url.endsWith('.css')
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'reload' })
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});