/** Persist last-loaded ROMs in IndexedDB (too large for localStorage). */

const DB_NAME = "gbc-emu";
const DB_VERSION = 1;
const STORE = "lastRoms";

export type LastRomRecord = {
  slot: number;
  fileName: string;
  /** Raw ROM bytes */
  rom: Uint8Array;
  savedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "slot" });
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Save the ROM for a session slot (0 = Game 1, 1 = Game 2). */
export async function saveLastRom(
  slot: number,
  rom: Uint8Array,
  fileName: string,
): Promise<void> {
  const db = await openDb();
  try {
    const record: LastRomRecord = {
      slot,
      fileName,
      rom: rom.slice(),
      savedAt: Date.now(),
    };
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).put(record));
  } finally {
    db.close();
  }
}

/** Load the last ROM for a session slot, or null if none. */
export async function loadLastRom(
  slot: number,
): Promise<{ rom: Uint8Array; fileName: string } | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const record = (await idbReq(tx.objectStore(STORE).get(slot))) as
      | LastRomRecord
      | undefined;
    if (!record?.rom) return null;
    const bytes =
      record.rom instanceof Uint8Array ? record.rom : new Uint8Array(record.rom as ArrayBuffer);
    return {
      rom: bytes.slice(),
      fileName: record.fileName || "game.gb",
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
