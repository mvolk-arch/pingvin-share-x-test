// Custom service worker code, bundled into sw.js by next-pwa (customWorkerDir).
// Handles files shared to the installed web app via the Web Share Target API.
// The files are stored in the Cache API and picked up by the /upload page.

const SHARE_TARGET_PATH = "/share-target";
const SHARE_TARGET_CACHE = "share-target";
// TEMPORARY DEBUG (dockhand only, not part of the pull request)
const SHARE_DEBUG_CACHE = "share-target-debug";

const storeDebug = async (info) => {
  try {
    const cache = await caches.open(SHARE_DEBUG_CACHE);
    await cache.put(
      new Request("/share-target-debug"),
      new Response(JSON.stringify(info)),
    );
  } catch (e) {
    // ignore
  }
};

// TEMPORARY DEBUG: try to read the body in different ways on clones of the
// request to see which of them works in the browser
const probeRequest = async (request) => {
  const results = [];
  const run = async (name, fn) => {
    const started = Date.now();
    try {
      const value = await fn();
      results.push(`${name}: ok ${value} (${Date.now() - started}ms)`);
    } catch (e) {
      results.push(`${name}: FAIL ${e} (${Date.now() - started}ms)`);
    }
  };

  await run("arrayBuffer", async () => {
    const buffer = await request.clone().arrayBuffer();
    return `${buffer.byteLength}B`;
  });
  await run("blob", async () => {
    const blob = await request.clone().blob();
    return `${blob.size}B`;
  });
  await run("stream", async () => {
    if (!request.body) return "no body";
    const reader = request.clone().body.getReader();
    let bytes = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      chunks++;
    }
    return `${bytes}B in ${chunks} chunks`;
  });

  return results;
};

// TEMPORARY DEBUG: send the diagnostics to the server, where they are
// written to the container log (see pages/share-debug-log.tsx)
const sendDebugToServer = async (info) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const data = encodeURIComponent(JSON.stringify(info).slice(0, 6000));
    await fetch(`/share-debug-log?d=${data}`, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e) {
    // ignore
  } finally {
    clearTimeout(timer);
  }
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "POST" || url.pathname !== SHARE_TARGET_PATH) {
    return;
  }

  event.respondWith(
    (async () => {
      const debug = {
        at: new Date().toISOString(),
        userAgent: self.navigator.userAgent,
        requestContentType: (
          event.request.headers.get("content-type") || ""
        ).split(";")[0],
        contentLength: event.request.headers.get("content-length"),
        mode: event.request.mode,
        hasBody: !!event.request.body,
        probes: [],
        entries: [],
        error: null,
      };
      debug.probes = await probeRequest(event.request);
      try {
        // Samsung Internet fails with "Failed to fetch" on request.formData(),
        // although the body itself can be read. So the body is read as a
        // buffer and parsed from a new Response instead.
        const body = await event.request.arrayBuffer();
        const formData = await new Response(body, {
          headers: {
            "Content-Type": event.request.headers.get("content-type") || "",
          },
        }).formData();
        for (const [key, value] of formData.entries()) {
          debug.entries.push(
            typeof value === "string"
              ? `${key}: text(${value.length})`
              : `${key}: file ${value.name} ${value.type} ${value.size}B`,
          );
        }
        // Accept files from any form field, not only "files", because some
        // browsers do not use the field name declared in the manifest
        const files = [];
        for (const [, value] of formData.entries()) {
          if (typeof value !== "string") files.push(value);
        }

        // Drop files from earlier shares that were never picked up
        await caches.delete(SHARE_TARGET_CACHE);
        const cache = await caches.open(SHARE_TARGET_CACHE);
        const timestamp = Date.now();

        await Promise.all(
          files.map((file, index) =>
            cache.put(
              new Request(`/share-target-files/${timestamp}-${index}`),
              new Response(file, {
                headers: {
                  "Content-Type": file.type || "application/octet-stream",
                  "X-File-Name": encodeURIComponent(file.name),
                  "X-File-Last-Modified": String(file.lastModified),
                  "X-Shared-At": String(timestamp),
                },
              }),
            ),
          ),
        );
      } catch (e) {
        console.error("Failed to store shared files", e);
        debug.error = String(e);
      }
      await storeDebug(debug);
      await sendDebugToServer(debug);

      // 303 turns the POST into a GET request for the upload page
      return Response.redirect(new URL("/upload", self.location.origin), 303);
    })(),
  );
});
