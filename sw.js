const CACHE_NAME = 'aplift-v11';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
  'https://fonts.gstatic.com/s/outfit/v11/QId1mst44hRye-3STzyYcxuxjbFpS3e5q74.woff2'
];

// Install event - caching assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: Caching files');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate event - cleaning old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Service Worker: Clearing old cache', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serving cached assets
self.addEventListener('fetch', (e) => {
  // Check if target is webhook URL or Google redirect URL, bypass caching
  if (e.request.url.includes('script.google.com') || 
      e.request.url.includes('googleusercontent.com') || 
      e.request.method === 'POST') {
    return; // let it hit the network
  }

  e.respondWith(
    caches.match(e.request).then((response) => {
      // Return cached version or fetch from network
      return response || fetch(e.request).then((fetchRes) => {
        // Optionally cache new requests dynamically
        return caches.open(CACHE_NAME).then((cache) => {
          // Only cache successful HTTP requests
          if (e.request.url.startsWith('http') && fetchRes.status === 200) {
            cache.put(e.request, fetchRes.clone());
          }
          return fetchRes;
        });
      });
    }).catch(() => {
      // Offline fallback if network fails and not in cache
      if (e.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
