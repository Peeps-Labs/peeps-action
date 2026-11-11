function workerTermFn(n) { return n + 2; }
onmessage = function (e) { postMessage(workerTermFn(e.data)); };
