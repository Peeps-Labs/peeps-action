function popupCloseFn() { document.title = "popup-close ran"; }
popupCloseFn();
setTimeout(function closeSoon() { window.close(); }, 300);
