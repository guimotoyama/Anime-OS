const CACHE_VERSION = 'v2'; // 👈 sempre que atualizar o app, muda esse número
const CACHE_NAME = `anime-os-cache-${CACHE_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './imagens/Logo.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // ativa o novo SW imediatamente, sem esperar todas as abas fecharem
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME) // apaga qualquer cache com nome diferente do atual
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim()) // assume controle das abas abertas imediatamente
  );
});

self.addEventListener('fetch', (event) => {
  // Network-first para HTML e JS (sempre tenta buscar a versão mais nova primeiro)
  if (event.request.mode === 'navigate' || event.request.url.endsWith('.js')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          return response;
        })
        .catch(() => caches.match(event.request)) // se estiver offline, usa o cache como reserva
    );
    return;
  }

  // Cache-first para o resto (CSS, imagens) — não muda com tanta frequência
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});