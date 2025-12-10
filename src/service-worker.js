const CACHE_NAME = 'familycall-v1';
const urlsToCache = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

// Install event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

// Fetch event
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        return response || fetch(event.request);
      })
  );
});

// Push notification event
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'familycall';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.data || {},
    requireInteraction: true,
    actions: [
      {
        action: 'answer',
        title: 'Answer'
      },
      {
        action: 'decline',
        title: 'Decline'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'answer' || !event.action) {
    // Open the app and handle the call
    event.waitUntil(
      clients.openWindow('/')
    );
    
    // Send message to all clients
    event.waitUntil(
      clients.matchAll().then((clientList) => {
        clientList.forEach((client) => {
          client.postMessage({
            type: 'call-notification-clicked',
            data: event.notification.data
          });
        });
      })
    );
  }
});

