// Service worker: keyboard shortcuts, the toolbar icon, saving notes sent by the
// YouTube page, looking up video titles through YouTube's oEmbed endpoint, and
// running the hidden listener page for voice notes, Snips and ranges.

import * as storage from "./lib/storage.js";
import * as audioStore from "./lib/audio-store.js";
import { watchUrl, parseVideoId } from "./lib/youtube-url.js";

const YOUTUBE_URL_PATTERN = /^https:\/\/(www|m)\.youtube\.com\//;
// A phrase's words arrive a moment after it is spoken; wait for them before
// taking a range's or a Snip's text.
const LAST_WORDS_MS = 2000;
// A deleted note's audio is kept this long, so Undo can bring the note back whole.
const AUDIO_UNDO_GRACE_MS = 30000;

chrome.runtime.onInstalled.addListener(() => {
  storage.ensureSchema();
  setUpToolbarIcon();
  sweepOrphanAudio();
});

chrome.runtime.onStartup.addListener(() => {
  storage.ensureSchema();
  setUpToolbarIcon();
  sweepOrphanAudio();
});

// Clicking the toolbar icon opens the notes panel, on every site. Notes are taken
// with the shortcuts or the Kayt button on the YouTube page.
function setUpToolbarIcon() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn("Kayt: could not set the toolbar icon to open the panel.", error);
  });
}

// Alt+N, Alt+R, Alt+V, Alt+L, and Snip (no default key), or whatever the user set at
// chrome://extensions/shortcuts.
chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) {
    return;
  }
  if (command === "open-capture") {
    sendToYouTubeTab(tab, { type: "openCapture" });
  } else if (command === "voice-note") {
    sendToYouTubeTab(tab, { type: "openCapture", voice: true });
  } else if (command === "toggle-range") {
    sendToYouTubeTab(tab, { type: "toggleRange" });
  } else if (command === "snip") {
    sendToYouTubeTab(tab, { type: "snip" });
  } else if (command === "toggle-listening") {
    // A shortcut counts as the user invoking Kayt on this tab, which Chrome requires
    // before an extension may listen to a tab.
    toggleListening(tab, { tellTabAboutErrors: true }).catch((error) => console.warn("Kayt:", error));
  }
});

function isYouTubeTab(tab) {
  // tab.url is only visible to us on sites we have access to, which is exactly YouTube.
  return Boolean(tab && tab.url) && YOUTUBE_URL_PATTERN.test(tab.url);
}

async function sendToYouTubeTab(tab, message) {
  if (!isYouTubeTab(tab)) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    // Happens on YouTube tabs that were already open when the extension was
    // installed or reloaded: they don't have our script until they are refreshed.
    console.warn("Kayt: could not reach the YouTube tab. Refresh it and try again.", error);
  }
}

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "offscreen") {
    return false; // for the listener page, not us
  }
  if (message.from === "offscreen") {
    onListenerMessage(message);
    return false;
  }

  if (message.type === "openSidePanel") {
    // Called synchronously so the click on the page still counts as a user
    // gesture; Chrome refuses to open the panel otherwise.
    if (sender.tab) {
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch((error) => {
        console.warn("Kayt: could not open the side panel.", error);
      });
    }
    return false;
  }

  const tab = sender.tab;
  const handlers = {
    saveNote: () => saveNote(message, tab),
    undoSave: () => storage.deleteNote(message.noteId),
    refreshMissingTitles: () => refreshMissingTitles(),
    openManage: () => chrome.tabs.create({ url: chrome.runtime.getURL("manage/manage.html") }),
    startDictation: () => startDictation(tab),
    micPermissionResult: () => onMicPermissionResult(Boolean(message.granted)),
    stopDictation: () => toListenerIfOpen({ type: "stopMic" }),
    cancelDictation: () => toListenerIfOpen({ type: "cancelMic" }),
    toggleListening: () => toggleListening(tab, { tellTabAboutErrors: false }),
    getListeningState: () => getListeningState(tab),
    // The page can't read the shortcuts the user set; it asks here.
    getShortcuts: async () => {
      const commands = await chrome.commands.getAll();
      return Object.fromEntries(commands.map((command) => [command.name, command.shortcut || ""]));
    },
    stopListening: async () => {
      if (await isListeningTo(tab)) {
        await toListener({ type: "stopTab" });
      }
    },
    needListening: () => needListening(tab, message.key, message.since),
    releaseListening: () => releaseListening(tab, message.key),
    saveSnip: () => saveSnip(message, tab)
  };
  const handler = handlers[message.type];
  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.warn("Kayt:", error);
      sendResponse({ ok: false, error: error.message || String(error), code: error.code || "" });
    });
  return true; // keeps sendResponse alive for the async reply
});

// kind is "text" (typed), "voice" (spoken), "label" (a label button) or "range".
async function saveNote(message, tab) {
  const { kind, videoId, timestampSeconds, endTimestampSeconds, chapterTitle, label } = message;
  const trimmed = (message.text || "").trim();
  let text;
  let source;
  if (kind === "range") {
    text = "Range";
    source = "MARKER";
  } else if (kind === "label") {
    // A label on its own is a marker, like the Android app. If something was typed
    // too, keep it rather than throw it away.
    text = trimmed === "" ? label : label + " — " + trimmed;
    source = trimmed === "" ? "MARKER" : "TEXT";
  } else if (trimmed === "") {
    // An empty note is a bookmark of the moment, like the Android app.
    text = "Marked";
    source = "MARKER";
  } else {
    text = trimmed;
    source = kind === "voice" ? "VOICE" : "TEXT";
  }

  const note = await storage.addNote({ videoId, timestampSeconds, endTimestampSeconds, chapterTitle, text, source });
  afterSave(note);

  if (kind === "voice" && tab) {
    await attachVoiceAudio(note, tab);
  }
  if (kind === "range" && tab) {
    // Not awaited: the range is saved; its words and sound follow in a moment.
    fillRange(note, message, tab);
  }
  return note;
}

function afterSave(note) {
  if (note.videoId) {
    // Not awaited: the note is already saved, the title can arrive later.
    fetchTitleIfMissing(note.videoId);
  }
}

// The listener stored the voice note's recording under the tab; give it to the note.
async function attachVoiceAudio(note, tab) {
  const pendingKey = audioStore.pendingMicKey(tab.id);
  try {
    const { keepAudio } = await storage.getSettings();
    if (!keepAudio) {
      await audioStore.deleteClip(pendingKey);
      return;
    }
    if (await audioStore.moveClip(pendingKey, note.id)) {
      note.hasAudio = true;
      await storage.updateNote(note.id, { hasAudio: true });
    }
  } catch (error) {
    console.warn("Kayt: could not keep the voice note's audio.", error);
  }
}

// ---------------------------------------------------------------------------
// The hidden listener page (offscreen/offscreen.js)
// ---------------------------------------------------------------------------

let creatingListener = null;

async function ensureListener() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!creatingListener) {
    creatingListener = chrome.offscreen
      .createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Turns speech from the microphone or the YouTube tab into text, on this computer."
      })
      .finally(() => {
        creatingListener = null;
      });
  }
  await creatingListener;
}

async function toListener(message) {
  await ensureListener();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (!response || !response.ok) {
    const error = new Error(response ? response.error : "The listener did not answer.");
    error.code = response ? response.code : "";
    throw error;
  }
  return response;
}

// Only if it's already running; never starts it just to ask.
async function toListenerIfOpen(message) {
  if (!(await chrome.offscreen.hasDocument())) {
    return { micTabId: null, listeningTabId: null, active: false };
  }
  return toListener(message);
}

async function listenerState() {
  return toListenerIfOpen({ type: "state" });
}

async function closeListenerIfIdle() {
  const state = await listenerState().catch(() => null);
  if (state && !state.active) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// Messages the listener page sends on its own, passed on to the YouTube tab.
function onListenerMessage(message) {
  if (message.type === "dictationUpdate") {
    sendToTab(message.tabId, { type: "dictationUpdate", text: message.text });
  } else if (message.type === "dictationEnded") {
    sendToTab(message.tabId, { type: "dictationEnded", text: message.text, error: message.error });
    if (!message.active) {
      closeListenerIfIdle();
    }
  } else if (message.type === "listeningEnded") {
    storage.getListeningSession().then(async (session) => {
      const auto = Boolean(session && session.auto);
      // When listening moves to another tab, this arrives for the old tab after
      // the new session is saved; leave that one alone.
      if (!session || session.tabId === message.tabId) {
        await storage.setListeningSession(null);
      }
      sendToTab(message.tabId, { type: "listeningState", on: false, error: message.error, auto });
      if (!message.active) {
        closeListenerIfIdle();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Voice notes (microphone)
// ---------------------------------------------------------------------------

async function startDictation(tab) {
  if (!tab) {
    throw new Error("No tab.");
  }
  const { speechLang, keepAudio, voiceAutoStop } = await storage.getSettings();
  try {
    await toListener({ type: "startMic", tabId: tab.id, lang: speechLang, keepAudio, autoStop: voiceAutoStop });
  } catch (error) {
    if (error.code === "needs-permission") {
      await askForMicrophone(tab);
      const asking = new Error("Allow the microphone in the small Kayt window.");
      asking.code = "asking-permission";
      throw asking;
    }
    closeListenerIfIdle();
    throw error;
  }
}

// The hidden page can't show Chrome's microphone question, and asking inside
// YouTube's page would give the microphone to YouTube rather than to Kayt. So a
// small Kayt window asks, once; it closes itself, and the voice note starts.
async function askForMicrophone(tab) {
  const width = 440;
  const height = 320;
  let position = {};
  try {
    const parent = await chrome.windows.get(tab.windowId);
    position = {
      left: Math.round(parent.left + (parent.width - width) / 2),
      top: Math.round(parent.top + (parent.height - height) / 3)
    };
  } catch (error) {
    // Chrome picks a place.
  }
  const popup = await chrome.windows.create({
    url: chrome.runtime.getURL("permission/permission.html?tab=" + tab.id),
    type: "popup",
    width,
    height,
    focused: true,
    ...position
  });
  await chrome.storage.session.set({ micAsk: { windowId: popup.id, tabId: tab.id } });
}

// From the small window: allowed (start the voice note) or refused.
async function onMicPermissionResult(granted) {
  const { micAsk } = await chrome.storage.session.get("micAsk");
  if (!micAsk) {
    return;
  }
  await chrome.storage.session.remove("micAsk");
  if (!granted) {
    sendToTab(micAsk.tabId, {
      type: "dictationEnded",
      text: "",
      error: "The microphone wasn't allowed. Click Voice to try again, or type your note."
    });
    return;
  }
  try {
    const tab = await chrome.tabs.get(micAsk.tabId);
    await startDictation(tab);
    sendToTab(tab.id, { type: "dictationStarted" });
  } catch (error) {
    sendToTab(micAsk.tabId, { type: "dictationEnded", text: "", error: error.message });
  }
}

// Closing the small window without answering counts as a refusal.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { micAsk } = await chrome.storage.session.get("micAsk");
  if (micAsk && micAsk.windowId === windowId) {
    await onMicPermissionResult(false);
  }
});

// ---------------------------------------------------------------------------
// Listening to the tab (Snips and ranges)
//
// Listening is either the user's (Alt+L or "Listen to video"; it stays on until
// they stop it) or automatic (auto: turned on by a Snip or a range, and off again
// once none of them needs it). What needs it is tracked as "holds" (keys like
// "range:<since>" or "snip:<id>"), both here and in the listener page, which keeps
// the text and sound from each hold's start until it is released.
// ---------------------------------------------------------------------------

// From a shortcut there is no one to answer, so errors are sent to the tab as a
// message; from the page, they are thrown back to the caller instead.
async function toggleListening(tab, { tellTabAboutErrors }) {
  const reportError = (message) => {
    if (tellTabAboutErrors) {
      sendToTab(tab.id, { type: "listeningState", on: false, error: message });
    }
    return new Error(message);
  };
  if (!isYouTubeTab(tab)) {
    return { on: false };
  }
  const state = await listenerState();
  if (state.listeningTabId === tab.id) {
    const session = await storage.getListeningSession();
    if (session && session.auto) {
      // Listening a Snip or range turned on: the user now wants it kept on.
      await storage.setListeningSession({ ...session, auto: false });
      sendToTab(tab.id, { type: "listeningState", on: true, auto: false });
      return { on: true };
    }
    await toListener({ type: "stopTab" });
    return { on: false };
  }

  // A Snip or range on this tab may be waiting for this shortcut; it then gets
  // its listening, which goes off again when it is done.
  const waiting = await takeWaitingHolds(tab.id);
  try {
    await startListening(tab, { auto: waiting.length > 0, holds: waiting });
  } catch (error) {
    throw reportError(error.message);
  }
  return { on: true };
}

// holds: keys of Snips or ranges this listening is for.
async function startListening(tab, { auto, holds = [] }) {
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    // Chrome only allows this after a Kayt shortcut or a click on the toolbar icon.
    const commands = await chrome.commands.getAll();
    const listen = commands.find((command) => command.name === "toggle-listening");
    const key = listen && listen.shortcut ? listen.shortcut : "your Listen to video shortcut";
    throw new Error("Press " + key + " to let Kayt hear this tab (Chrome needs a shortcut for this).");
  }

  const { speechLang } = await storage.getSettings();
  try {
    await toListener({ type: "startTab", tabId: tab.id, streamId, lang: speechLang });
  } catch (error) {
    closeListenerIfIdle();
    throw error;
  }
  const since = Date.now();
  for (const key of holds) {
    await toListener({ type: "hold", tabId: tab.id, key, since });
  }
  await storage.setListeningSession({ tabId: tab.id, videoId: parseVideoId(tab.url), auto, holds });
  sendToTab(tab.id, { type: "listeningState", on: true, auto, heldKeys: holds, since });
}

// A Snip or range asks for the tab's words from `since` on. If Kayt is already
// listening, it keeps them from there. If not, it starts listening now (which
// works after a Kayt shortcut; after a plain click Chrome may refuse, and then the
// hold waits for Alt+L). Returns { listening, since, startedNow, needsShortcut, error }.
async function needListening(tab, key, since) {
  if (!tab) {
    return { listening: false, error: "No tab." };
  }
  if (await isListeningTo(tab)) {
    await toListener({ type: "hold", tabId: tab.id, key, since });
    const session = await storage.getListeningSession();
    const holds = (session && session.holds) || [];
    if (session && !holds.includes(key)) {
      await storage.setListeningSession({ ...session, holds: [...holds, key] });
    }
    return { listening: true, since, startedNow: false };
  }
  try {
    await startListening(tab, { auto: true, holds: [key] });
  } catch (error) {
    await addWaitingHold(tab.id, key);
    return { listening: false, needsShortcut: true, error: error.message };
  }
  // Nothing before this moment was heard.
  return { listening: true, since: Date.now(), startedNow: true };
}

// The Snip or range is done (or dropped): stop keeping its words, and stop
// listening if only it needed it.
async function releaseListening(tab, key) {
  if (!tab) {
    return;
  }
  await removeWaitingHold(tab.id, key);
  const session = await storage.getListeningSession();
  if (!session || session.tabId !== tab.id) {
    return;
  }
  await toListenerIfOpen({ type: "release", tabId: tab.id, key }).catch(() => {});
  const holds = (session.holds || []).filter((other) => other !== key);
  await storage.setListeningSession({ ...session, holds });
  if (session.auto && holds.length === 0) {
    await toListenerIfOpen({ type: "stopTab" }).catch(() => {});
  }
}

// Holds that could not start listening, waiting for Alt+L on their tab. Kept in
// session storage because the service worker may sleep in between.
async function addWaitingHold(tabId, key) {
  const { waitingHolds = {} } = await chrome.storage.session.get("waitingHolds");
  waitingHolds[tabId] = [...(waitingHolds[tabId] || []).filter((other) => other !== key), key];
  await chrome.storage.session.set({ waitingHolds });
}

async function removeWaitingHold(tabId, key) {
  const { waitingHolds = {} } = await chrome.storage.session.get("waitingHolds");
  if (!waitingHolds[tabId]) {
    return;
  }
  waitingHolds[tabId] = waitingHolds[tabId].filter((other) => other !== key);
  await chrome.storage.session.set({ waitingHolds });
}

async function takeWaitingHolds(tabId) {
  const { waitingHolds = {} } = await chrome.storage.session.get("waitingHolds");
  const keys = waitingHolds[tabId] || [];
  delete waitingHolds[tabId];
  await chrome.storage.session.set({ waitingHolds });
  return keys;
}

async function getListeningState(tab) {
  const state = await listenerState().catch(() => ({ listeningTabId: null }));
  const on = Boolean(tab) && state.listeningTabId === tab.id;
  const session = on ? await storage.getListeningSession() : null;
  return { on, auto: Boolean(session && session.auto) };
}

async function isListeningTo(tab) {
  return (await getListeningState(tab)).on;
}

// A Snip: what the video said between since and until. The page waits until the
// "after" seconds have played before asking. pressAt and pressSeconds are the
// wall-clock time and video time of the press, to point the note where the heard
// speech starts.
async function saveSnip(message, tab) {
  const { key, since, until, pressAt, pressSeconds, videoId, chapterTitle } = message;
  try {
    // The last phrase's words arrive a moment after it is spoken.
    const wait = until + LAST_WORDS_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (!(await isListeningTo(tab))) {
      throw new Error("Kayt stopped listening before the Snip was taken.");
    }
    const { text, heardFrom } = await toListener({
      type: "getTranscript",
      tabId: tab.id,
      since,
      until: until + LAST_WORDS_MS
    });
    if (!text) {
      throw new Error("Nothing was heard for this Snip. Is the video playing, with sound?");
    }
    let seconds = null;
    if (videoId && Number.isInteger(pressSeconds)) {
      seconds = Math.max(0, pressSeconds + Math.round((heardFrom - pressAt) / 1000));
    }
    const note = await storage.addNote({
      videoId,
      timestampSeconds: seconds,
      chapterTitle,
      text,
      source: "PRESENTER"
    });
    afterSave(note);
    return note;
  } finally {
    await releaseListening(tab, key);
  }
}

// Fills a saved range with what was said during it, once its last words have
// arrived, then lets listening go. Only words: the video's sound is never kept.
function fillRange(note, message, tab) {
  const { key, since, until } = message;
  if (!key) {
    return;
  }
  setTimeout(async () => {
    try {
      if (Number.isFinite(since) && (await isListeningTo(tab))) {
        const { text } = await toListener({
          type: "getTranscript",
          tabId: tab.id,
          since,
          until: until + LAST_WORDS_MS
        });
        if (text && (await storage.updateNote(note.id, { text, source: "PRESENTER" }))) {
          sendToTab(tab.id, { type: "rangeTranscribed", ok: true });
        } else if (!text) {
          sendToTab(tab.id, { type: "rangeTranscribed", ok: false });
        }
      }
    } catch (error) {
      console.warn("Kayt: could not fill the range's transcript.", error);
    }
    await releaseListening(tab, key);
  }, LAST_WORDS_MS);
}

// Listening follows one video. Moving to another video wipes what was heard;
// leaving YouTube (or closing the tab) stops listening altogether.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.status) {
    return;
  }
  const session = await storage.getListeningSession();
  if (!session || session.tabId !== tabId) {
    return;
  }
  if (!isYouTubeTab(tab)) {
    await toListenerIfOpen({ type: "stopTab" }).catch(() => {});
    return;
  }
  const videoId = parseVideoId(tab.url);
  if (videoId !== session.videoId) {
    await toListenerIfOpen({ type: "clearTranscript", tabId }).catch(() => {});
    await storage.setListeningSession({ ...session, videoId });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { waitingHolds = {} } = await chrome.storage.session.get("waitingHolds");
  if (waitingHolds[tabId]) {
    delete waitingHolds[tabId];
    await chrome.storage.session.set({ waitingHolds });
  }
  const state = await listenerState().catch(() => null);
  if (!state) {
    return;
  }
  if (state.listeningTabId === tabId) {
    await toListener({ type: "stopTab" }).catch(() => {});
  }
  if (state.micTabId === tabId) {
    await toListener({ type: "cancelMic" }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Audio of deleted notes
// ---------------------------------------------------------------------------

// When a note is deleted, its audio goes too, after a grace period for Undo.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  const removed = Object.entries(changes)
    .filter(([key, change]) => key.startsWith("note:") && change.oldValue && !change.newValue)
    .map(([, change]) => change.oldValue);
  if (removed.some((note) => note.hasAudio)) {
    setTimeout(sweepOrphanAudio, AUDIO_UNDO_GRACE_MS);
  }
});

// Deletes audio whose note no longer exists. Also runs at start-up, in case the
// service worker was stopped before a grace period ended.
async function sweepOrphanAudio() {
  try {
    const { notes } = await storage.getAll();
    const noteIds = new Set(notes.map((note) => note.id));
    for (const id of await audioStore.listClipIds()) {
      if (!String(id).startsWith("pending-mic:") && !noteIds.has(id)) {
        await audioStore.deleteClip(id);
      }
    }
  } catch (error) {
    console.warn("Kayt: could not tidy up saved audio.", error);
  }
}

// ---------------------------------------------------------------------------
// Video titles
// ---------------------------------------------------------------------------

async function refreshMissingTitles() {
  const { videos } = await storage.getAll();
  const missing = Object.values(videos).filter((video) => !video.title);
  await Promise.all(missing.map((video) => fetchTitleIfMissing(video.videoId)));
}

const lookupsInProgress = new Set();

// Title, channel and thumbnail from oEmbed. No API key, no quota. If it fails the
// video simply keeps no title and we try again the next time it gets a note or the
// side panel opens.
async function fetchTitleIfMissing(videoId) {
  if (lookupsInProgress.has(videoId)) {
    return;
  }
  lookupsInProgress.add(videoId);
  try {
    const video = await storage.getVideo(videoId);
    if (!video || video.title) {
      return;
    }
    const oembedUrl =
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(watchUrl(videoId));
    const response = await fetch(oembedUrl, { credentials: "omit" });
    if (!response.ok) {
      console.warn("Kayt: oEmbed lookup failed for " + videoId + ": HTTP " + response.status);
      return;
    }
    const info = await response.json();
    await storage.setVideoMetadata(videoId, {
      title: info.title,
      channelName: info.author_name,
      thumbnailUrl: info.thumbnail_url
    });
  } catch (error) {
    console.warn("Kayt: oEmbed lookup failed for " + videoId, error);
  } finally {
    lookupsInProgress.delete(videoId);
  }
}
