function swFn(n) { return n * 2; }
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("message", function (e) { e.ports[0].postMessage(swFn(e.data)); });
