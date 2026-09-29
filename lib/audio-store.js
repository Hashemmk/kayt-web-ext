// The only file that reads or writes saved audio.
//
// Audio is too big for chrome.storage, so it lives in IndexedDB, in Kayt's own
// storage (never YouTube's): only extension pages and the service worker use this
// file, never the content script.
//
// Database "kayt-audio", store "clips", one record per note:
//   { noteId, blob, mimeType, seconds }
// A voice note's audio is kept under "pending-mic:<tabId>" until its note is saved,
// then moved to the note's id.

const DB_NAME = "kayt-audio";
const STORE = "clips";

let opening = null;

function openDb() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "noteId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    });
  }
  return opening;
}

// Runs one request in its own transaction and resolves with its result once the
// transaction has finished (so a write is really on disk).
async function run(mode, makeRequest) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = makeRequest(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function pendingMicKey(tabId) {
  return "pending-mic:" + tabId;
}

export async function putClip(noteId, blob, seconds) {
  await run("readwrite", (store) =>
    store.put({ noteId, blob, mimeType: blob.type, seconds: Math.round(seconds || 0) })
  );
}

// The clip for a note, or null.
export async function getClip(noteId) {
  return (await run("readonly", (store) => store.get(noteId))) || null;
}

export async function deleteClip(noteId) {
  await run("readwrite", (store) => store.delete(noteId));
}

// Moves a clip to another key, e.g. a voice note's audio to its new note.
// Returns the clip, or null if there was nothing to move.
export async function moveClip(fromKey, toNoteId) {
  const clip = await getClip(fromKey);
  if (!clip) {
    return null;
  }
  await putClip(toNoteId, clip.blob, clip.seconds);
  await deleteClip(fromKey);
  return clip;
}

// The ids of every stored clip.
export async function listClipIds() {
  return run("readonly", (store) => store.getAllKeys());
}

export async function clearAllClips() {
  await run("readwrite", (store) => store.clear());
}

// A file name for downloading a note's clip.
export function clipFileName(note, clip) {
  const extension = clip.mimeType.includes("wav") ? "wav" : "webm";
  const date = new Date(note.createdAt).toISOString().slice(0, 10);
  return "kayt-" + date + "-" + note.id.slice(0, 8) + "." + extension;
}
