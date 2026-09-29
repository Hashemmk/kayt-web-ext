// The Markdown export. Keep this format stable, so older exports and new ones
// look the same.

import { watchUrl, shortUrl, formatTimestampLabel } from "./youtube-url.js";

// Notes in timestamp order; notes without a timestamp go last, oldest first.
export function sortNotesByTimestamp(notes) {
  return [...notes].sort((a, b) => {
    const aHasTime = a.timestampSeconds !== null;
    const bHasTime = b.timestampSeconds !== null;
    if (aHasTime && bHasTime && a.timestampSeconds !== b.timestampSeconds) {
      return a.timestampSeconds - b.timestampSeconds;
    }
    if (aHasTime !== bHasTime) {
      return aHasTime ? -1 : 1;
    }
    return a.createdAt - b.createdAt;
  });
}

// data is { videos: {videoId: Video}, notes: [Note] } from storage.getAll(), or just
// one video's part of it when exporting a single video.
export function buildMarkdown(data) {
  const exportedOn = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
  const lines = ["# Kayt export", "Exported " + exportedOn];

  const notesByVideo = new Map();
  const unsortedNotes = [];
  for (const note of data.notes) {
    if (note.videoId) {
      if (!notesByVideo.has(note.videoId)) {
        notesByVideo.set(note.videoId, []);
      }
      notesByVideo.get(note.videoId).push(note);
    } else {
      unsortedNotes.push(note);
    }
  }

  // Most recently noted video first, like the library.
  const videoIds = [...notesByVideo.keys()].sort((a, b) => {
    const aTime = data.videos[a] ? data.videos[a].lastNotedAt : 0;
    const bTime = data.videos[b] ? data.videos[b].lastNotedAt : 0;
    return bTime - aTime;
  });

  for (const videoId of videoIds) {
    const video = data.videos[videoId] || {};
    lines.push("");
    lines.push("## " + (isBlank(video.title) ? videoId : video.title));
    if (!isBlank(video.channelName)) {
      lines.push(video.channelName);
    }
    lines.push(watchUrl(videoId));
    lines.push("");
    pushNotes(lines, sortNotesByTimestamp(notesByVideo.get(videoId)), (note) => noteBullet(note, videoId));
  }

  if (unsortedNotes.length > 0) {
    lines.push("");
    lines.push("## Unsorted notes");
    lines.push("");
    unsortedNotes.sort((a, b) => a.createdAt - b.createdAt);
    pushNotes(lines, unsortedNotes, noteText);
  }

  return lines.join("\n") + "\n";
}

// One bullet per note, with a "### chapter" heading each time a new chapter starts.
// A video without chapters gets no headings at all.
function pushNotes(lines, notes, bulletFor) {
  let previousChapter = null;
  for (const note of notes) {
    const chapter = note.chapterTitle;
    if (!isBlank(chapter) && chapter !== previousChapter) {
      lines.push("", "### " + chapter, "");
    }
    previousChapter = chapter;
    lines.push("- " + bulletFor(note));
  }
}

function noteBullet(note, videoId) {
  const text = noteText(note);
  if (note.timestampSeconds === null) {
    return text;
  }
  const link = watchUrl(videoId, note.timestampSeconds);
  const label = formatTimestampLabel(note.timestampSeconds, note.endTimestampSeconds);
  return "[" + label + "](" + link + ") " + text;
}

// Newlines would break the one-line-per-note format.
function noteText(note) {
  const cleaned = note.text.replace(/\r\n|\r|\n/g, " ");
  return note.source === "PRESENTER" ? "Presenter: " + cleaned : cleaned;
}

// A single note as a few plain lines, for copying and pasting elsewhere:
//   note text
//   video title · 12:34
//   https://youtu.be/ID?t=754
export function buildNoteShareText(note, videoTitle) {
  const lines = [];
  const isPlainRange = Number.isInteger(note.endTimestampSeconds) && note.text === "Range";
  if (!isPlainRange) {
    lines.push(note.text);
  }
  const parts = [];
  if (!isBlank(videoTitle)) {
    parts.push(videoTitle.trim());
  }
  if (note.timestampSeconds !== null) {
    parts.push(formatTimestampLabel(note.timestampSeconds, note.endTimestampSeconds));
  }
  if (parts.length > 0) {
    lines.push(parts.join(" · "));
  }
  if (note.videoId) {
    lines.push(shortUrl(note.videoId, note.timestampSeconds));
  }
  return lines.join("\n");
}

function isBlank(value) {
  return !value || value.trim() === "";
}
