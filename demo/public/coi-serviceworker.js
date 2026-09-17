// Cross origin isolation for a static host, so the threaded Box3D build can run on GitHub Pages.
//
// The threaded build needs SharedArrayBuffer, which a browser only hands to a cross origin isolated page, and a page
// is only isolated when it is served with COOP and COEP response headers. GitHub Pages serves fixed headers and has
// no way to add them. A service worker can: once it controls the page, every response passes through it on the way
// in, and it can put the headers on before the browser sees them.
//
// This one file plays both parts. Loaded with a script tag it registers itself and reloads the page once, so the
// document that finally renders came through the worker. Running as the worker it adds the headers.
//
// Nothing here is required for the demo to work. If the browser has no service workers, or the registration fails,
// or the page is already isolated by real headers, the demo loads the single threaded build exactly as before.

if (typeof window === "undefined") {
    // ---- service worker side ----------------------------------------------------------------
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("fetch", (event) => {
        const request = event.request;
        // a range request has to reach the network untouched or media seeking breaks
        if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
            return;
        }

        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        // an opaque response has no headers to add to, and rewriting it would only hide the failure
                        return response;
                    }
                    const headers = new Headers(response.headers);
                    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
                    headers.set("Cross-Origin-Opener-Policy", "same-origin");
                    // same origin assets are allowed under require-corp anyway; this keeps a cross origin copy working
                    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
                    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
                })
                .catch((error) => {
                    console.error("coi-serviceworker:", error);
                    throw error;
                })
        );
    });
} else {
    // ---- page side --------------------------------------------------------------------------
    (() => {
        // already isolated, by these headers or real ones: nothing to do
        if (window.crossOriginIsolated) {
            return;
        }
        if (!window.isSecureContext || !navigator.serviceWorker) {
            console.info("coi-serviceworker: no service worker available, Box3D will run on one thread");
            return;
        }
        // the reload below happens once per page load at most, so a worker that never isolates cannot loop
        if (window.sessionStorage.getItem("coi-reloaded") === "1") {
            window.sessionStorage.removeItem("coi-reloaded");
            console.info("coi-serviceworker: still not isolated after a reload, Box3D will run on one thread");
            return;
        }

        navigator.serviceWorker
            .register(window.document.currentScript.src)
            .then((registration) => {
                if (registration.active && !navigator.serviceWorker.controller) {
                    window.sessionStorage.setItem("coi-reloaded", "1");
                    window.location.reload();
                }
                registration.addEventListener("updatefound", () => {
                    const worker = registration.installing;
                    worker?.addEventListener("statechange", () => {
                        if (worker.state === "activated" && !window.crossOriginIsolated) {
                            window.sessionStorage.setItem("coi-reloaded", "1");
                            window.location.reload();
                        }
                    });
                });
            })
            .catch((error) => console.info("coi-serviceworker: registration failed, Box3D will run on one thread", error));
    })();
}
