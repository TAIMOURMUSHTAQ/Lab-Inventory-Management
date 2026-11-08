// Keeps the app and the label reader on the device so the app opens without internet.
// App files come from the network first so a new release arrives straight away;
// the saved copy is used when offline. Large reader files only change with this name.
const CACHE = "kit-tracker-v3";   // keep the same as APP_VERSION in app.js
const APP_FILES = ["/", "/index.html", "/app.js", "/label.js", "/alerts.js", "/reader.js", "/manifest.webmanifest"];
const READER_FILES = [
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
  "/vendor/zxing/reader.js", "/vendor/zxing/zxing_reader.wasm",
];
const NETWORK_WAIT_MS = 5000;     // on a poor connection, fall back to the saved copy

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...APP_FILES, ...READER_FILES])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (!saved) return network.catch(() => caches.match("/index.html"));
  const slow = new Promise((resolve) => setTimeout(() => resolve(saved), NETWORK_WAIT_MS));
  return Promise.race([network.catch(() => saved), slow]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // data always comes from the server or the device queue
  if (url.pathname.startsWith("/vendor/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
    return;
  }
  e.respondWith(networkFirst(e.request));
});
