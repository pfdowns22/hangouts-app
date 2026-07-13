/* Firebase Cloud Messaging service worker (background push).
   The Firebase config is passed as query params on the registration URL
   (service workers can't read Vite env vars). Uses the compat CDN build —
   this file is served as-is from /public, outside the bundler. */
/* global importScripts, firebase */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

const params = new URLSearchParams(self.location.search);
firebase.initializeApp({
  apiKey: params.get('apiKey'),
  authDomain: params.get('authDomain'),
  projectId: params.get('projectId'),
  storageBucket: params.get('storageBucket'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId'),
});

const messaging = firebase.messaging();

// Background messages: show a simple branded notification. Clicking focuses
// or opens the app.
messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'Hangouts', {
    body: n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.fcmOptions?.link || '/' },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
