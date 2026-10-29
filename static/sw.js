// Keeps the app and the label reader on the device so the app opens without internet.
const CACHE = "kit-tracker-v1";
const SHELL = [
  "/", "/index.html", "/app.js", "/label.js", "/manifest.webmanifest",
  "/vendor/tesseract/tesseract.min.js", "/vendor/tesseract/worker.min.js",
  "/vendor/tesseract-core/tesseract-core-lstm.js",
  "/vendor/tesseract-core/tesseract-core-lstm.wasm",
  "/vendor/tesseract-core/tesseract-core-lstm.wasm.js",
  "/vendor/tesseract-core/tesseract-core-simd-lstm.js",
  "/vendor/tesseract-core/tesseract-core-simd-lstm.wasm",
  "/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js",
  "/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.js",
  "/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm",
  "/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "/vendor/lang/eng.traineddata.gz",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // data always comes from the server or the device queue
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match("/index.html")))
  );
});
