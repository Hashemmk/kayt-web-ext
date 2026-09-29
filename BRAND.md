# Kayt — brand assets

Drop `kayt-mark.svg` and friends anywhere you need the logo. For the Android
app, copy the three XML files into `app/src/main/res/`:

    res/drawable/ic_launcher_foreground.xml
    res/drawable/ic_launcher_background.xml
    res/mipmap-anydpi-v26/ic_launcher.xml

Then point the manifest at it:

    android:icon="@mipmap/ic_launcher"
    android:roundIcon="@mipmap/ic_launcher"

## Files

| File | Use |
|---|---|
| `kayt-mark.svg` | Primary, ink on light backgrounds |
| `kayt-mark-on-dark.svg` | Reversed, for dark backgrounds |
| `kayt-mark-mono.svg` | Single colour, inherits `currentColor` |
| `ic_launcher_*.xml` | Android adaptive launcher icon |

## Colours

| Token | Hex | Use |
|---|---|---|
| Ink | `#15181C` | UI surfaces, the bars, the pen barrel |
| Jade | `#2FB89B` | Accent — only ever marks what the user captured |
| Pine | `#14524B` | Same hue for light backgrounds where jade is too bright |
| Saffron | `#E8A33D` | Secondary state — transcribing, or flagged to revisit |
| Bone | `#F4F1EA` | Light background |
| Sand | `#D8D2C4` | Dividers, disabled states |

Jade is reserved. If it appears on something the user did not capture, it is
wrong.

## Type

- Display: **Bricolage Grotesque** (600 / 800)
- Interface and body: **Public Sans** (400 / 500 / 600)
- Both on Google Fonts, nothing to license.
- Timestamps use tabular figures so note lists do not jitter while scrolling.

## Mark geometry

Drawn on a 72-unit square. Four bars, 8 wide, corner radius 4, all centred on
y=37; heights 14 / 40 / 24 / 10 at x = 2 / 13 / 24 / 35. The second bar carries
the accent. The pen is anchored by its nib at the end of the wave and rises at
40 degrees; barrel 7.6 wide so it matches the bar weight.

Do not re-space the bars or re-angle the pen. If the mark needs to fit a
different space, scale the whole thing.
