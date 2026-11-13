// Hält die Seite des Readers im Browser bereit, damit sie sich auch ohne Netz öffnen lässt
// (unterwegs: Chromebook, Handy). Nur die Seite selbst – den Roman legt quelle-github.js ab.
//
// Immer zuerst aus dem Netz (so kommt jede neue Fassung des Readers sofort an); nur wenn das
// nicht klappt oder zu lange dauert, aus dem Zwischenspeicher. Anfragen an GitHub (api.github.com)
// und alles außerhalb der Seite fasst er nicht an.
// Veröffentlicht wird diese Datei neben index.html (reader/veroeffentlichen.py).

const CACHE = "roman-app-1";
const WARTEN = 4000; // so lange auf das Netz warten, dann der zwischengespeicherte Stand
// Alles, was die Seite braucht – gleich beim ersten Besuch abgelegt (veroeffentlichen.py prüft,
// dass hier jede Datei aus static/ steht)
const DATEIEN = [
  "./", "static/reader.css", "static/reader.js", "static/daten.js", "static/quelle-github.js", "static/quelle-lokal.js",
  "static/zkn3.js", "static/aenderung.js", "static/pytext.js", "static/textsatz.js", "static/format.js", "static/export.js",
  "static/verlauf.js", "static/vendor/marked.esm.js", "static/icon.svg", "static/icon-192.png", "static/icon-512.png",
  "static/icon-180.png", "static/icon-maskable-512.png", "static/manifest.webmanifest", "static/roman.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(DATEIEN.map((url) =>
      fetch(url, { cache: "reload" }).then((r) => (r.ok ? cache.put(url, r) : null)).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("roman-app-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

function ausDemNetz(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("zu langsam")), WARTEN);
    // über die Adresse (eine Seitenanfrage selbst lässt sich nicht mit Optionen weiterreichen)
    fetch(request.url, { cache: "no-cache", credentials: "same-origin" }).then((response) => {
      clearTimeout(timer);
      resolve(response);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const seite = request.mode === "navigate";
  const key = seite ? "./" : request;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await ausDemNetz(request);
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch {
      const hier = await cache.match(key, { ignoreSearch: seite });
      if (hier) return hier;
      throw new Error("Weder Netz noch Zwischenspeicher");
    }
  })());
});
