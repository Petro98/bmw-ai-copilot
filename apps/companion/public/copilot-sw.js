/*
 * The panel's service worker: Angular's worker (ngsw-worker.js, configured by ngsw-config.json) behind one rule of
 * its own. Angular's worker answers every request of the page, passing the ones it does not cache on to the
 * network. Requests for the API and the car link must not go through it at all: answers, the live event streams,
 * sign-in and pairing always go straight from the browser to the network. This listener is registered before
 * Angular's and stops the event for those paths without answering it, so the browser fetches them itself.
 */
'use strict';

var NETWORK_ONLY_PREFIXES = ['/api/', '/car/v1/'];

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  for (var i = 0; i < NETWORK_ONLY_PREFIXES.length; i++) {
    if (url.pathname.indexOf(NETWORK_ONLY_PREFIXES[i]) === 0) {
      event.stopImmediatePropagation();
      return;
    }
  }
});

importScripts('ngsw-worker.js');
