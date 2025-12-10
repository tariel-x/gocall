const CACHE_NAME = 'familycall-v3';
// Don't cache HTML, CSS, or JS - always fetch fresh
// Only cache static assets like icons and manifest
const urlsToCache = [
  '/manifest.json'
];

// Install event - minimal, no activation
self.addEventListener('install', (event) => {
  // Don't activate immediately - prevents "site updated in the background" messages
  // Service worker will activate naturally when user visits page
});

// Activate event - minimal, no claiming clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Don't call clients.claim() - prevents "site updated in the background"
});

// Fetch event
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;

  // For app.js, HTML, and CSS - always fetch from network first (no cache)
  // This ensures we always get the latest version
  if (pathname === '/app.js' || 
      pathname === '/' || 
      pathname === '/index.html' ||
      pathname === '/styles.css' ||
      pathname.startsWith('/invite/') ||
      pathname.startsWith('/call')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For other static assets (icons, manifest), use cache-first
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        return response || fetch(event.request);
      })
  );
});

// Push notification event - just show notification with URL
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const url = data.data?.url || self.location.origin + '/';
  
  const options = {
    body: data.body || 'Tap here to answer a call',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: url },
    tag: 'incoming-call',
    requireInteraction: true,
    priority: 'high'
  };

  // Just show the notification - nothing else
  event.waitUntil(
    self.registration.showNotification(data.title || 'Tap here to answer a call', options)
  );
});

// Notification click event - just open the URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  const urlToOpen = event.notification.data?.url || self.location.origin + '/';
  
  // Simply open the URL - nothing else
  event.waitUntil(
    clients.openWindow(urlToOpen)
  );
});

