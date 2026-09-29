// URL rules shared with the Android app: which YouTube URLs contain a video, how
// ?t= works, and how a timestamp is written. Pure functions, no Chrome APIs, so the
// content script, the service worker and the side panel can all import this file.

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"];

// Returns the 11-character video ID in a YouTube URL, or null.
// Handles /watch?v=ID, /shorts/ID, /live/ID, /embed/ID and youtu.be/ID.
export function parseVideoId(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (error) {
    return null;
  }

  let candidate = null;

  if (url.hostname === "youtu.be") {
    candidate = url.pathname.split("/")[1];
  } else if (YOUTUBE_HOSTS.includes(url.hostname)) {
    const pathParts = url.pathname.split("/");
    if (url.pathname === "/watch") {
      candidate = url.searchParams.get("v");
    } else if (["shorts", "live", "embed"].includes(pathParts[1])) {
      candidate = pathParts[2];
    }
  }

  if (candidate && VIDEO_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return null;
}

// Reads ?t= from a YouTube URL. Accepts "754", "754s" and "12m34s" / "1h2m3s".
// Returns whole seconds, or null if there is no usable ?t=.
export function parseStartSeconds(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (error) {
    return null;
  }

  const value = url.searchParams.get("t");
  if (!value) {
    return null;
  }

  if (/^\d+s?$/.test(value)) {
    return parseInt(value, 10);
  }

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) {
    return null;
  }
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

export function watchUrl(videoId, seconds) {
  const base = "https://www.youtube.com/watch?v=" + videoId;
  if (seconds === null || seconds === undefined) {
    return base;
  }
  return base + "&t=" + seconds + "s";
}

// "m:ss", switching to "h:mm:ss" from one hour on. Same as the Android app.
export function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    const mm = String(minutes).padStart(2, "0");
    return hours + ":" + mm + ":" + ss;
  }
  return minutes + ":" + ss;
}

// "12:34", or "12:34–13:10" (no spaces around the dash) for a range. Same as Android.
export function formatTimestampLabel(seconds, endSeconds) {
  const start = formatTimestamp(seconds);
  if (endSeconds === null || endSeconds === undefined) {
    return start;
  }
  return start + "–" + formatTimestamp(endSeconds);
}

// The short link used when sharing a single note, as the Android app does.
export function shortUrl(videoId, seconds) {
  const base = "https://youtu.be/" + videoId;
  if (seconds === null || seconds === undefined) {
    return base;
  }
  return base + "?t=" + seconds;
}
