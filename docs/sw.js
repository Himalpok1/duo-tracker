// Service worker: receives push alerts from the tracker and opens the buy link on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Duo Tracker", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "iPhone Duo in stock";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { url: data.url || self.registration.scope },
      requireInteraction: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(self.clients.openWindow(url));
});
