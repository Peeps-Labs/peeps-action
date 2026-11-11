function otherOrigin() {
  const host = location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  return "http://" + host + ":" + location.port;
}

function appInitFn() {
  document.getElementById("to-page2-xsite").href = otherOrigin() + "/page2.html";
  document.getElementById("popup-xsite").href = otherOrigin() + "/popup.html";
}

function navSoonFn() {
  const d = document.createElement("div");
  d.className = "clicked-rule";
  d.textContent = "clicked";
  document.body.appendChild(d);
  setTimeout(function navTimerFn() { location.href = "/page2.html"; }, 100);
}

function neverCalledFn() { return 42; }

async function routeFn(path) {
  history.pushState({}, "", path);
  const chunk = await import("/route-chunk.js");
  chunk.routeChunkFn();
  return "routed";
}

function loadIframe(src) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.src = src;
    f.onload = () => setTimeout(() => resolve("framed"), 200);
    document.body.appendChild(f);
  });
}

function startWorker(url, terminate) {
  return new Promise((resolve) => {
    const w = new Worker(url);
    w.onmessage = (e) => {
      if (terminate) w.terminate();
      resolve(e.data);
    };
    w.postMessage(5);
  });
}

async function startSW() {
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    reg.active.postMessage(3, [ch.port2]);
  });
}

function loadDelayed() {
  return new Promise((resolve) => {
    setTimeout(() => {
      const s = document.createElement("script");
      s.src = "/delayed.js";
      s.onload = () => resolve("delayed");
      document.head.appendChild(s);
    }, 300);
  });
}

function injectStyles() {
  const a = document.createElement("style");
  a.textContent = ".inj-nosrc-used { color: rgb(1, 2, 3); }\n.inj-nosrc-unused { color: rgb(4, 5, 6); }\n";
  document.head.appendChild(a);
  const b = document.createElement("style");
  b.textContent = ".inj-src-used { color: rgb(7, 8, 9); }\n.inj-src-unused { color: rgb(1, 1, 1); }\n/*# sourceURL=injected-with-src.css */\n";
  document.head.appendChild(b);
  for (const cls of ["inj-nosrc-used", "inj-src-used"]) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = cls;
    document.body.appendChild(d);
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r("injected"))));
}

window.addEventListener("DOMContentLoaded", appInitFn);
