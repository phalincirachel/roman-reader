// Hält die Seite des Readers im Browser bereit, damit sie sich auch ohne Netz öffnen lässt
// (unterwegs: Chromebook, Handy). Nur die Seite selbst – den Roman legt quelle-github.js ab.
//
// Die vollständige Programmfassung liegt im Zwischenspeicher und startet ohne Netzwartezeit.
// Jede Veröffentlichung bekommt eine neue Cache-Kennung. Der Browser lädt neue Fassungen
// im Hintergrund; erst eine vollständig geladene Fassung wird aktiviert.
// Anfragen an GitHub (api.github.com) und alles außerhalb der Seite fasst er nicht an.
// Veröffentlicht wird diese Datei neben index.html (reader/veroeffentlichen.py).

const CACHE = "roman-app-03d9ba62ae4257fb7793"; // veroeffentlichen.py setzt hier die Prüfsumme der Programmfassung ein
// Alles, was die Seite braucht – gleich beim ersten Besuch abgelegt (veroeffentlichen.py prüft,
// dass hier jede Datei aus static/ steht)
const DATEIEN = [
  "./", "static/reader.css", "static/start.js", "static/reader.js", "static/daten.js", "static/quelle-github.js", "static/quelle-lokal.js",
  "static/zkn3.js", "static/aenderung.js", "static/pytext.js", "static/textsatz.js", "static/format.js", "static/export.js",
  "static/verlauf.js", "static/markdown.js", "static/vendor/marked.esm.js", "static/icon.svg", "static/icon-192.png", "static/icon-512.png",
  "static/icon-180.png", "static/icon-maskable-512.png", "static/manifest.webmanifest", "static/roman.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(DATEIEN.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (!response.ok) throw new Error("Programmdatei nicht erreichbar");
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("roman-app-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const seite = request.mode === "navigate";
  const key = seite ? "./" : request;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hier = await cache.match(key, { ignoreSearch: seite });
    if (hier) return hier;
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  })());
});
