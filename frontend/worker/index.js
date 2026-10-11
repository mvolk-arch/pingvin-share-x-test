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
    const data = encodeURIComponent(JSON.stringify(info).slice(0, 4000));
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

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const indexOfBytes = (haystack, needle, from = 0) => {
  const first = needle[0];
  const limit = haystack.length - needle.length;
  for (let i = from; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
};

const getBoundary = (contentType, bytes) => {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (match) return (match[1] || match[2]).trim();

  // Fall back to the first line of the body ("--<boundary>")
  const lineEnd = indexOfBytes(bytes, encoder.encode("\r\n"));
  if (lineEnd > 2 && bytes[0] === 45 && bytes[1] === 45) {
    return decoder.decode(bytes.subarray(2, lineEnd));
  }
  return null;
};

// Minimal multipart/form-data parser, used when the browser's own parser fails
// (Samsung Internet: request.formData() and Response.formData() throw
// "TypeError: Failed to fetch" although the body itself can be read).
const parseMultipartFiles = (buffer, contentType) => {
  const bytes = new Uint8Array(buffer);
  const boundary = getBoundary(contentType, bytes);
  if (!boundary) return [];

  const delimiter = encoder.encode(`--${boundary}`);
  const headerEnd = encoder.encode("\r\n\r\n");
  const files = [];

  let pos = indexOfBytes(bytes, delimiter, 0);
  while (pos !== -1) {
    const partStart = pos + delimiter.length;
    // "--" right after the delimiter marks the end of the body
    if (bytes[partStart] === 45 && bytes[partStart + 1] === 45) break;

    const next = indexOfBytes(bytes, delimiter, partStart);
    if (next === -1) break;

    const headersStart = partStart + 2; // skip the CRLF after the delimiter
    const headersEnd = indexOfBytes(bytes, headerEnd, headersStart);
    if (headersEnd !== -1 && headersEnd < next) {
      const headers = decoder.decode(bytes.subarray(headersStart, headersEnd));
      const filename = /filename="([^"]*)"/i.exec(headers);
      if (filename) {
        const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
        const dataStart = headersEnd + 4;
        const dataEnd = Math.max(dataStart, next - 2); // strip the CRLF before the next delimiter
        files.push(
          new File([bytes.slice(dataStart, dataEnd)], filename[1] || "shared-file", {
            type: type ? type[1].trim() : "",
          }),
        );
      }
    }
    pos = next;
  }

  return files;
};

// TEMPORARY DEBUG: describe the multipart structure of the body
const inspectMultipart = (buffer, contentType) => {
  const bytes = new Uint8Array(buffer);
  const boundary = getBoundary(contentType, bytes);
  let delimiterCount = 0;
  if (boundary) {
    const delimiter = encoder.encode(`--${boundary}`);
    let pos = indexOfBytes(bytes, delimiter, 0);
    while (pos !== -1) {
      delimiterCount++;
      pos = indexOfBytes(bytes, delimiter, pos + delimiter.length);
    }
  }
  const firstHeadersEnd = indexOfBytes(bytes, encoder.encode("\r\n\r\n"), 0);
  const previewLength = Math.min(
    firstHeadersEnd === -1 ? 300 : firstHeadersEnd,
    300,
  );
  return {
    bodyBytes: bytes.length,
    boundary,
    delimiterCount,
    firstPartHeaders: decoder.decode(bytes.subarray(0, previewLength)),
  };
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "POST" || url.pathname !== SHARE_TARGET_PATH) {
    return;
  }

  event.respondWith(
    (async () => {
      const debug = {
        version: "v3-manual-fallback",
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
        // The body is read as a buffer first. Samsung Internet throws
        // "Failed to fetch" in the browser's multipart parser, so the files are
        // parsed manually if that happens.
        const contentType = event.request.headers.get("content-type") || "";
        const body = await event.request.arrayBuffer();
        debug.contentType = contentType;
        debug.body = inspectMultipart(body, contentType);

        // Accept files from any form field, not only "files", because some
        // browsers do not use the field name declared in the manifest
        let files = [];
        try {
          const formData = await new Response(body, {
            headers: { "Content-Type": contentType },
          }).formData();
          for (const [, value] of formData.entries()) {
            if (typeof value !== "string") files.push(value);
          }
          debug.parsedBy = "native";
        } catch (e) {
          debug.nativeError = String(e);
          files = parseMultipartFiles(body, contentType);
          debug.parsedBy = "manual";
        }
        debug.entries = files.map(
          (file) => `file ${file.name} ${file.type} ${file.size}B`,
        );

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
