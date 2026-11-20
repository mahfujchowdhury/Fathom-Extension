/*
 * Fathom — local capture history.
 *
 * IndexedDB rather than chrome.storage: a full-page PNG is routinely several
 * megabytes and would blow the 10 MB local-storage quota after three shots.
 * Records hold the image twice — a small `thumb` for the list and the full
 * `dataUrl` for the editor — so the history page never decodes full-size images.
 */
(() => {
  const F = (globalThis.Fathom = globalThis.Fathom || {});

  const DB_NAME = "fathom";
  const DB_VERSION = 1;
  const STORE = "captures";

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("createdAt", "createdAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the capture store."));
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, mode);
          const store = transaction.objectStore(STORE);
          let result;
          try {
            result = fn(store);
          } catch (err) {
            reject(err);
            return;
          }
          transaction.oncomplete = () => resolve(result);
          transaction.onerror = () => reject(transaction.error || new Error("Capture store error."));
          transaction.onabort = () => reject(transaction.error || new Error("Capture store aborted."));
        }),
    );
  }

  const request = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const store = (F.captureStore = {
    /**
     * Save a capture. `entry` needs { dataUrl, thumb, width, height, url, mode }.
     * Returns the new record id. Prunes to `limit` afterwards when limit > 0.
     */
    async add(entry, limit = 10) {
      const record = {
        dataUrl: entry.dataUrl,
        thumb: entry.thumb || entry.dataUrl,
        width: entry.width || 0,
        height: entry.height || 0,
        url: entry.url || "",
        mode: entry.mode || "capture",
        createdAt: Date.now(),
      };
      const id = await tx("readwrite", (s) => s.add(record));
      if (limit > 0) await store.prune(limit);
      return id;
    },

    /** Newest first, newest-first ordering is explicit so IDB index quirks don't matter. */
    async list() {
      const all = await tx("readonly", (s) => request(s.getAll()));
      return all
        .map(({ dataUrl, ...meta }) => meta)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async get(id) {
      return tx("readonly", (s) => request(s.get(Number(id))));
    },

    async remove(id) {
      await tx("readwrite", (s) => s.delete(Number(id)));
    },

    async removeMany(ids) {
      await tx("readwrite", (s) => {
        for (const id of ids) s.delete(Number(id));
      });
    },

    async clear() {
      await tx("readwrite", (s) => s.clear());
    },

    async count() {
      return tx("readonly", (s) => request(s.count()));
    },

    /** Delete the oldest records until at most `limit` remain. */
    async prune(limit) {
      const all = await tx("readonly", (s) => request(s.getAll()));
      const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
      const excess = sorted.slice(limit);
      if (!excess.length) return 0;
      await store.removeMany(excess.map((r) => r.id));
      return excess.length;
    },
  });
})();
