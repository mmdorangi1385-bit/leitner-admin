// سرویس‌ورکر مخصوص پنل مدیریت. برخلاف sw.js (که برای اپ اصلیه)، این فایل هیچ نقشی توی
// «فرستادن» نوتیفیکیشن به کاربرها نداره — اون کار فقط با نوشتن روی broadcastNotifications/
// توی فایربیس انجام می‌شه (نگاه کن به admin.html) و هر کاربر با سرویس‌ورکر خودِ اپ اصلی
// (sw.js) نمایشش می‌ده. این فایل فقط برای کش‌کردن خودِ پنل مدیریت برای استفاده‌ی آفلاین/سریع‌تره.
const ADMIN_CACHE_NAME = 'leitner-admin-cache-v7';
const ADMIN_ASSETS = ['./admin.html', './icon-hero.png', './manifest-admin.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(ADMIN_CACHE_NAME).then((cache) => cache.addAll(ADMIN_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== ADMIN_CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(ADMIN_CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
