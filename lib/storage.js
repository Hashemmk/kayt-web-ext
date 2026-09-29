// The only file that reads or writes chrome.storage.
//
// Layout in chrome.storage.local:
//   "schemaVersion"    number
//   "video:<videoId>"  Video { videoId, title, channelName, thumbnailUrl, lastNotedAt }
//   "note:<id>"        Note  { id, videoId, timestampSeconds, endTimestampSeconds,
//                               chapterTitle, text, createdAt, source }
//   "settings"         { lookBackSeconds, rangeLookBackSeconds, snipBeforeSeconds,
//                        snipAfterSeconds, keepAudio, voiceAutoStop, showListenTip,
//                        pauseForVoice, pagePosition, obsidianVault, obsidianFolder,
//                        speechLang, showPageButton }
//
// A note may also have hasAudio: true when a recording of it is kept (see
// lib/audio-store.js). endTimestampSeconds is set only on range notes. chapterTitle is the video chapter the
// note was taken in, when YouTube showed one.
//
// Each note and each video is its own key rather than one big array, so the service
// worker and the side panel can write at the same time without overwriting each
// other's changes.

export const SCHEMA_VERSION = 2;

const NOTE_PREFIX = "note:";
const VIDEO_PREFIX = "video:";
const SETTINGS_KEY = "settings";

// Notes point this many seconds before the moment the shortcut was pressed, because
// people press it just after the bit that mattered. Same choices as the Android app.
export const LOOK_BACK_CHOICES = [0, 5, 10, 15, 20, 25, 30];
// A range starts this many seconds before its first press. Its own setting, apart
// from notes, because an explanation usually starts well before you react to it.
export const RANGE_LOOK_BACK_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60];
// A Snip keeps what was said this long before and after the press.
export const SNIP_BEFORE_CHOICES = [0, 10, 15, 20, 30, 45, 60, 90, 120];
export const SNIP_AFTER_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60];
const DEFAULT_SETTINGS = {
  lookBackSeconds: 10,
  rangeLookBackSeconds: 10,
  snipBeforeSeconds: 30,
  snipAfterSeconds: 0,
  // Keep a recording with voice notes, Snips and ranges, in this browser only.
  keepAudio: true,
  // A voice note saves itself after a pause. Off: only Stop (or Alt+V) ends it.
  voiceAutoStop: true,
  // The note shown when a Snip or range has to turn listening on.
  showListenTip: true,
  // Pause the video while a voice note is spoken, and play on afterwards.
  pauseForVoice: true,
  // Where the Kayt button was dragged on the video, as { x, y } fractions of the
  // video's width and height; null for the bottom-right corner.
  pagePosition: null,
  // "Send to Obsidian": the vault ("" = whichever is open) and the folder in it.
  obsidianVault: "",
  obsidianFolder: "Kayt",
  // Language for voice notes and presenter transcripts, on-device only.
  speechLang: "en-US",
  // The floating Kayt button on YouTube video pages.
  showPageButton: true
};

// Call on install and on browser start. Migrates data saved by older versions.
export async function ensureSchema() {
  const stored = await chrome.storage.local.get("schemaVersion");
  const version = stored.schemaVersion;
  if (version === undefined) {
    await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION });
    return;
  }
  if (version < 2) {
    // Version 2 added range notes and chapters. Old notes get the new fields, empty.
    const { notes } = await getAll();
    const toSave = {};
    for (const note of notes) {
      toSave[NOTE_PREFIX + note.id] = { endTimestampSeconds: null, chapterTitle: null, ...note };
    }
    toSave.schemaVersion = 2;
    await chrome.storage.local.set(toSave);
  }
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  if (!LOOK_BACK_CHOICES.includes(settings.lookBackSeconds)) {
    settings.lookBackSeconds = DEFAULT_SETTINGS.lookBackSeconds;
  }
  if (!RANGE_LOOK_BACK_CHOICES.includes(settings.rangeLookBackSeconds)) {
    settings.rangeLookBackSeconds = DEFAULT_SETTINGS.rangeLookBackSeconds;
  }
  if (!SNIP_BEFORE_CHOICES.includes(settings.snipBeforeSeconds)) {
    settings.snipBeforeSeconds = DEFAULT_SETTINGS.snipBeforeSeconds;
  }
  if (!SNIP_AFTER_CHOICES.includes(settings.snipAfterSeconds)) {
    settings.snipAfterSeconds = DEFAULT_SETTINGS.snipAfterSeconds;
  }
  return settings;
}

export async function setSettings(changes) {
  const settings = { ...(await getSettings()), ...changes };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

// Everything, as { videos: {videoId: Video}, notes: [Note] }.
export async function getAll() {
  const everything = await chrome.storage.local.get(null);
  const videos = {};
  const notes = [];
  for (const [key, value] of Object.entries(everything)) {
    if (key.startsWith(VIDEO_PREFIX)) {
      videos[value.videoId] = value;
    } else if (key.startsWith(NOTE_PREFIX)) {
      notes.push(value);
    }
  }
  return { videos, notes };
}

export async function getVideo(videoId) {
  const key = VIDEO_PREFIX + videoId;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

// Saves a new note and bumps its video to the top of the library.
// Creates an empty Video record the first time a video gets a note; the title is
// filled in later by setVideoMetadata.
export async function addNote({ videoId, timestampSeconds, endTimestampSeconds, chapterTitle, text, source }) {
  const start = Number.isInteger(timestampSeconds) ? timestampSeconds : null;
  const note = {
    id: crypto.randomUUID(),
    videoId: videoId || null,
    timestampSeconds: start,
    // An end only makes sense after a start.
    endTimestampSeconds:
      start !== null && Number.isInteger(endTimestampSeconds) && endTimestampSeconds > start
        ? endTimestampSeconds
        : null,
    chapterTitle: chapterTitle || null,
    text,
    createdAt: Date.now(),
    source
  };

  const toSave = { [NOTE_PREFIX + note.id]: note };

  if (note.videoId) {
    const existing = await getVideo(note.videoId);
    const video = existing || {
      videoId: note.videoId,
      title: "",
      channelName: "",
      thumbnailUrl: "",
      lastNotedAt: 0
    };
    video.lastNotedAt = note.createdAt;
    toSave[VIDEO_PREFIX + video.videoId] = video;
  }

  await chrome.storage.local.set(toSave);
  return note;
}

export async function updateNoteText(noteId, text) {
  const key = NOTE_PREFIX + noteId;
  const stored = await chrome.storage.local.get(key);
  const note = stored[key];
  if (!note) {
    return null;
  }
  note.text = text;
  await chrome.storage.local.set({ [key]: note });
  return note;
}

// Changes some fields of a note, e.g. { text, source } when a range's transcript
// arrives. Returns null if the note was deleted in the meantime.
export async function updateNote(noteId, changes) {
  const key = NOTE_PREFIX + noteId;
  const stored = await chrome.storage.local.get(key);
  const note = stored[key];
  if (!note) {
    return null;
  }
  Object.assign(note, changes);
  await chrome.storage.local.set({ [key]: note });
  return note;
}

// Deletes several notes at once, and any video left with no notes.
// Returns { notes, videos } so the caller can undo with restoreNotes.
export async function deleteNotes(noteIds) {
  const { notes, videos } = await getAll();
  const removing = new Set(noteIds);
  const removedNotes = notes.filter((note) => removing.has(note.id));
  const remaining = notes.filter((note) => !removing.has(note.id));
  const removedVideos = Object.values(videos).filter(
    (video) => !remaining.some((note) => note.videoId === video.videoId)
  );
  await chrome.storage.local.remove([
    ...removedNotes.map((note) => NOTE_PREFIX + note.id),
    ...removedVideos.map((video) => VIDEO_PREFIX + video.videoId)
  ]);
  return { notes: removedNotes, videos: removedVideos };
}

export async function restoreNotes({ notes, videos }) {
  const toSave = {};
  for (const note of notes) {
    toSave[NOTE_PREFIX + note.id] = note;
  }
  for (const video of videos) {
    toSave[VIDEO_PREFIX + video.videoId] = video;
  }
  await chrome.storage.local.set(toSave);
}

// Deletes a note. If it was the video's last note, the video record goes too, so
// deleting every note of a video leaves nothing about it behind.
// Returns { note, video } (video only if it was removed) so the caller can undo.
export async function deleteNote(noteId) {
  const key = NOTE_PREFIX + noteId;
  const stored = await chrome.storage.local.get(key);
  const note = stored[key];
  if (!note) {
    return { note: null, video: null };
  }
  await chrome.storage.local.remove(key);

  let removedVideo = null;
  if (note.videoId) {
    const { notes } = await getAll();
    const stillHasNotes = notes.some((other) => other.videoId === note.videoId);
    if (!stillHasNotes) {
      removedVideo = await getVideo(note.videoId);
      await chrome.storage.local.remove(VIDEO_PREFIX + note.videoId);
    }
  }
  return { note, video: removedVideo };
}

// Puts back exactly what deleteNote removed.
export async function restoreNote({ note, video }) {
  if (!note) {
    return;
  }
  const toSave = { [NOTE_PREFIX + note.id]: note };
  if (video) {
    toSave[VIDEO_PREFIX + video.videoId] = video;
  }
  await chrome.storage.local.set(toSave);
}

// Title, channel and thumbnail from oEmbed. Does nothing if the video has no notes
// any more (it may have been deleted while the lookup was running).
export async function setVideoMetadata(videoId, { title, channelName, thumbnailUrl }) {
  const video = await getVideo(videoId);
  if (!video) {
    return;
  }
  video.title = title || "";
  video.channelName = channelName || "";
  video.thumbnailUrl = thumbnailUrl || "";
  await chrome.storage.local.set({ [VIDEO_PREFIX + videoId]: video });
}

// Deletes every note and video. Settings are kept: they are not notes.
export async function clearAll() {
  const settings = await getSettings();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION, [SETTINGS_KEY]: settings });
}

// Which tab Kayt is listening to: { tabId, videoId, auto, holds } or null.
// auto: turned on by a Snip or range rather than by the user, and turned off again
// once nothing in holds (keys like "range:<since>" or "snip:<id>") needs it.
// Kept in session storage (memory only, gone when Chrome closes) because the service
// worker can be shut down between events and forget it.
export async function getListeningSession() {
  const stored = await chrome.storage.session.get("listening");
  return stored.listening || null;
}

export async function setListeningSession(session) {
  if (session) {
    await chrome.storage.session.set({ listening: session });
  } else {
    await chrome.storage.session.remove("listening");
  }
}

// Calls callback() whenever notes or videos change, from any part of the extension.
export function onDataChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && Object.keys(changes).some((key) => key !== SETTINGS_KEY)) {
      callback();
    }
  });
}

// Calls callback(settings) whenever the settings change.
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) });
    }
  });
}
