/* Borç Çizelgesi · çevrimdışı çalışma ve ödeme hatırlatması */
const VERSION = 'v2';
const CACHE = 'borc-' + VERSION;
const FONT_CACHE = 'borc-fonts';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/badge-96.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Yazı tipleri: önce önbellek, arkada yenile
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONT_CACHE).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Sayfa: önce internet (güncelleme gelsin), yoksa önbellek
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Diğer dosyalar: önce önbellek
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});

/* ───── hatırlatma ───── */
function idb() {
  return new Promise((resolve) => {
    const r = indexedDB.open('borc-cizelgesi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  });
}
async function idbGet(key) {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      q.onsuccess = () => { resolve(q.result); db.close(); };
      q.onerror = () => { resolve(null); db.close(); };
    } catch (err) { resolve(null); db.close(); }
  });
}
async function idbSet(key, value) {
  const db = await idb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    } catch (err) { db.close(); resolve(); }
  });
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const NF = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function checkAndNotify() {
  const data = await idbGet('upcoming');
  if (!data || !data.on || !Array.isArray(data.items)) return;
  const now = new Date();
  const today = ymd(now);
  const tm = new Date(now); tm.setDate(tm.getDate() + 1);
  const tomorrow = ymd(tm);
  if ((await idbGet('notified')) === today) return;

  const late = data.items.filter((i) => i.date < today);
  const dueToday = data.items.filter((i) => i.date === today);
  const dueTomorrow = data.items.filter((i) => i.date === tomorrow);
  let title = '';
  let list = [];
  if (dueToday.length) { title = dueToday.length === 1 ? 'Bugün ödeme günü' : `Bugün ${dueToday.length} ödeme var`; list = dueToday; }
  else if (dueTomorrow.length) { title = dueTomorrow.length === 1 ? 'Yarın ödeme günü' : `Yarın ${dueTomorrow.length} ödeme var`; list = dueTomorrow; }
  else if (late.length) { title = late.length === 1 ? 'Geciken bir ödeme var' : `${late.length} ödeme gecikmede`; list = late; }
  else return;

  const lines = list.slice(0, 4).map((i) => `${i.name} · ${i.est ? '~' : ''}${NF.format((i.amount || 0) / 100)} ₺`);
  if (list.length > 4) lines.push(`+${list.length - 4} ödeme daha`);
  if ((dueToday.length || dueTomorrow.length) && late.length) lines.push(`Ayrıca ${late.length} geciken ödeme var.`);

  await self.registration.showNotification(title, {
    body: lines.join('\n'),
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: 'borc-gunluk',
    renotify: true,
    lang: 'tr',
    data: { url: './' }
  });
  await idbSet('notified', today);
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'borc-hatirlat') e.waitUntil(checkAndNotify());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});
