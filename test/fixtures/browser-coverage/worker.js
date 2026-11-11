function workerFn(n) { return n + 1; }
onmessage = function (e) { postMessage(workerFn(e.data)); };
