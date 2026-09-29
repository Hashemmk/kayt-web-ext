# Chrome Web Store listing — Kayt

## Extension name (max 75 characters)

```
Kayt — timestamped notes for YouTube
```

(36 characters.)

## Short summary (max 132 characters)

```
Take timestamped notes on YouTube without pausing. Alt+N, type, Enter. Notes stay in your browser — no account, no sync.
```

(123 characters.)

## Full description

```
Kayt lets you take timestamped notes on YouTube videos without ever pausing
playback.

While watching, press Alt+N (or click the Kayt button in the corner). A small box
appears in the corner of the page, already focused. Type your note and press Enter —
it's saved instantly with the video and the exact moment you pressed the shortcut,
and the video keeps playing the whole time. Press Enter with an empty box and it
bookmarks the moment with a marker note, so "Alt+N, Enter" is a one-key bookmark.

Press Shift+Enter for a new line inside a note, and Esc to cancel. While you're
typing, YouTube's own keyboard shortcuts (like K to pause or F for fullscreen) are
blocked so your note doesn't get interrupted.

More ways to capture, all without pausing:

- One-click labels: Important, Confusing, Revisit, Disagree (or Alt+1 to Alt+4).
- Ranges: press Alt+R where an explanation starts and again where it ends, and
  Kayt saves one note covering the whole stretch.
- Look-back: notes point a few seconds before you pressed the shortcut (10 by
  default, adjustable), because you usually press it just after the moment mattered.
- Chapters: on videos with chapters, each note remembers which chapter it was in.
- Voice notes: press Alt+V and speak. Chrome turns your words into text on this
  computer, on-device only. A "Stop and save" button ends it any time, or it saves
  itself after a few seconds of quiet (adjustable in Settings).
- Snip: save what the video just said, in one press. Set how many seconds before and
  after the press to grab in Settings ("Snip before" / "Snip after"). If Kayt isn't
  already listening, pressing Snip turns listening on for just that Snip. Also
  on-device only.
- Listen to video: press Alt+L to let Kayt listen continuously, so a Snip or a range
  can reach back further than a single press would. A range (Alt+R) is transcribed
  too: Kayt fills it with everything said from its start to its end.
- Optional audio: turn on "Keep audio" in Settings and Kayt keeps a short recording
  of your microphone alongside voice notes. Stored only in this browser, never
  uploaded; deleted with the note or with "Clear all data". Off any time you like.

All your notes live in the side panel (click the Kayt toolbar icon), and a full
"Manage notes" page lets you filter, select many notes at once, and copy, export or
delete them together.

The side panel:

- Library view: every video you've noted, most recent first, with its thumbnail,
  title, channel, and how many notes it has. Search filters across note text and
  video titles.
- Video view: all notes for one video, in timestamp order, grouped by chapter. Edit,
  copy or delete any note. Click a timestamp to jump straight to that moment — if
  you're already on that video's tab, it seeks in place; otherwise it opens the
  video at that time. While the video plays, the note it has reached is highlighted.

Export everything as a plain Markdown file at any time from Settings.
Use Obsidian? "Send to Obsidian" puts a video's notes straight into your vault as a
note, through the Obsidian app on your computer — nothing is uploaded.

You can change the keyboard shortcuts at any time at chrome://extensions/shortcuts.

Privacy: your notes — and, if you choose to keep them, audio recordings of your voice
notes — are stored only in this browser, on this computer. There's no account, no
backend, and no cloud sync. The only network request Kayt makes is a lookup to
YouTube's own oEmbed service to fetch a video's title and channel name (which sends
only the video ID), plus loading thumbnail images directly from YouTube. No analytics,
no crash reporting, no ads, no tracking. Full policy: see the "Privacy policy" link
below.

Kayt only works on youtube.com — it does not run on, read, or modify any other
site.
```

## Category

Productivity (Education is a reasonable secondary fit, but Productivity is the
primary suggestion — the extension is a note-taking tool, not educational content
itself).

## Single purpose statement

```
Kayt's single purpose is to let a user capture timestamped notes (typed, spoken,
or transcribed from the video's speech on the user's own computer) while watching
a YouTube video, and to let them review, edit, search, and export those
notes afterward. It does not do anything else: it does not modify YouTube's player,
block ads, download video, or interact with any other site.
```

## Permission justifications

**storage**
Required to save the user's notes and video metadata (title, channel, thumbnail URL)
locally with `chrome.storage.local`. This is the only place any Kayt data is
kept.

**sidePanel**
Required to show the notes library and per-video notes list in Chrome's built-in side
panel, which is how the user browses, searches, edits, and exports their notes.

**tabCapture**
Used only when the user turns on "Listen to video" (Alt+L), uses Snip, or starts a
range (Alt+R) on a YouTube tab, to hear that tab's sound and turn the video's speech
into text with Chrome's on-device speech recognition, so the user can save a Snip or
range as a note. Only that one tab, only while listening is on (shown by a bar on the
page and Chrome's own indicator) — a Snip or range that needs listening turns it on
for just that Snip or range if it wasn't already on. If the user's "Keep audio"
setting is on, a short recording of the tab's sound covering the same stretch as the
note is also kept, stored locally and never sent anywhere; with "Keep audio" off,
only text is kept.

**offscreen**
Chrome's extension service worker cannot use a microphone or tab audio, so a hidden
extension page (an offscreen document) runs the on-device speech recognition for
voice notes, Snip and "Listen to video", and — only when the user's "Keep audio"
setting is on — records the matching microphone or tab audio alongside the
transcription. It is created only while one of these is in use.

**Host permission: `https://www.youtube.com/*` and `https://m.youtube.com/*`**
Required so the content script can run on YouTube's watch pages to read the current
video ID from the page address and the current playback position from the page's
video element — but only at the instant the user presses the shortcut or clicks the
toolbar button — and to draw the small note-capture box on top of the page. The
extension does not request broader host access (no `<all_urls>`, no `tabs`, no
`downloads`, no `history`); it cannot see or act on any site other than YouTube.

## Remote code

```
No. Kayt ships all of its JavaScript inside the extension package. It does not
download or execute any remote code, consistent with Manifest V3's requirements.
```

## Data usage disclosure (Chrome Web Store "Privacy practices" form)

Kayt collects no user data in the Chrome Web Store's sense of "data collected
and sent off the user's device to you or a third party." Specifically:

- **Personally identifiable information:** Not collected.
- **Health info, financial info, authentication info, personal communications, location:** Not collected — the extension has no way to access any of these.
- **Web history:** Not collected. The extension only reads the current tab's URL, and only on youtube.com/m.youtube.com, and only at the instant the user triggers a capture — it does not log or store browsing history.
- **User activity (e.g. keystrokes, clicks) outside the extension's own UI:** Not collected.
- **Website content:** Not collected, beyond reading the current video ID, playback time and chapter name on YouTube pages as described above, which stays on-device.
- **Audio:** Not collected in the Chrome Web Store's sense — nothing is transmitted off the device. Voice notes, Snip and "Listen to video" turn speech into text on the user's computer with Chrome's on-device speech recognition. If the user's "Keep audio" setting is on (it is on by default, and can be turned off), a short recording of the user's microphone for a voice note is also kept, but only in the browser's local storage on that device, never transmitted or uploaded anywhere.

The only data that leaves the device at all is the YouTube video ID sent to YouTube's
own public oEmbed endpoint to fetch a title/channel name, and the video ID used to
load a thumbnail image from YouTube's image CDN (`i.ytimg.com`). Both are requests
to YouTube, not to Kayt or any third party, and neither is "collection" by
the extension — the extension does not receive, store, or transmit this data
anywhere else.

Certify: **This extension does not sell or transfer user data to third parties
outside of approved use cases.** **This extension does not use or transfer user
data for purposes unrelated to the extension's single purpose.** **This extension
does not use or transfer user data to determine creditworthiness or for lending
purposes.**

Privacy policy URL: link to the hosted `privacy.html` (see "Steps to publish" below).

## Screenshots to take (1280×800 px)

Take these in Chrome with the extension loaded, on a real (non-sensitive) YouTube
video. Suggested set:

1. **Capture in action** — a YouTube video playing, with the Kayt capture box
   open in the bottom-right corner showing a timestamp and some typed note text, and
   the video's own controls visible in the background to show it keeps playing.
2. **Saved confirmation** — the same page just after pressing Enter, showing the
   "Saved at 12:34" confirmation with Undo.
3. **Side panel — Library view** — the side panel open showing several videos with
   thumbnails, titles, channel names, and note counts.
4. **Side panel — Video notes view** — one video's notes list, showing a few notes
   with timestamps, and the edit/delete controls.
5. **Search** — the Library view with the search box in use, filtering to a
   matching note or title.
6. **Settings / export** — the Settings area showing the export-to-Markdown option
   and "Clear all data" control.

(Optional 7th: the exported `.md` file opened in a text editor, to show the export
format.)

## Steps to publish (for a non-developer owner)

1. **Register a developer account.** Go to
   https://chrome.google.com/webstore/devconsole, sign in with your Google account,
   and pay the one-time US$5 registration fee. This is a single fee for your account,
   not per extension.
2. **Package the extension.** Once everything is tested, open PowerShell in this
   folder (in File Explorer, click the address bar, type `powershell`, press Enter) and
   run `powershell -ExecutionPolicy Bypass -File .\package.ps1`. It creates
   `kayt-<version>.zip` (for example `kayt-1.2.0.zip`) next to it, containing only the files the extension needs.
   Before each new upload, raise `"version"` in `manifest.json` (e.g. 1.0.1); the
   store rejects a zip with a version it has already seen.
3. **Host the privacy policy.** The Chrome Web Store requires a public URL for the
   privacy policy, and `privacy.html` in this repo is written to be hosted as-is.
   Easiest option, GitHub Pages:
   - The repository (`github.com/Hashemmk/...` — exact name still to be decided)
     must be **public** for free GitHub Pages.
   - In the repository, go to **Settings → Pages**.
   - Under "Build and deployment", choose **Deploy from a branch**, branch **main**,
     folder **/ (root)**, then Save.
   - After a minute or two, the policy will be live at
     `https://<your-github-username>.github.io/<repo-name>/privacy.html`.
4. **Upload the zip.** In the Developer Dashboard, click "New item" and upload the
   `.zip` file.
5. **Fill in the listing.** Use the name, summary, description, category, and
   screenshots above. Paste the privacy policy URL from step 3 into the "Privacy
   policy" field, and fill in the "Privacy practices" data-disclosure form using the
   answers above.
6. **Submit for review.** Google typically reviews new extensions within a few days,
   sometimes longer. You'll get an email when it's approved or if they need changes.
