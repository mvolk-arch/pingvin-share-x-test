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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "POST" || url.pathname !== SHARE_TARGET_PATH) {
    return;
  }

  event.respondWith(
    (async () => {
      const debug = {
        at: new Date().toISOString(),
        requestContentType: event.request.headers.get("content-type"),
        entries: [],
        error: null,
      };
      try {
        const formData = await event.request.formData();
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

      // 303 turns the POST into a GET request for the upload page
      return Response.redirect(new URL("/upload", self.location.origin), 303);
    })(),
  );
});
