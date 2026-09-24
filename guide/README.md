# The user manual

`Edge Lab - User Manual.pdf` is generated, not hand-maintained. It is also bundled
into the desktop installer (`tauri.conf.json` → `bundle.resources`) and opened by
the **?** button, so it must exist before `npx tauri build`.

The app shows numbers, controls and one-line warnings only. **Explanations belong
in `manual.html`, not on the screens.** When a change adds or alters a number,
update the manual rather than adding a paragraph to the UI.

Regenerate whenever the UI changes, or the screenshots quietly go stale:

```bash
npm run build              # the manual shoots the dist build, so build first
node guide/shots.cjs       # ~4 min: seeds a journal and captures every screen
node guide/shots-fix.cjs   # the panels that need element-level shots
node guide/build.cjs       # renders manual.html -> PDF
```

- `manual.html` is the source. Edit the prose there.
- `shots/` is generated and gitignored. Do not edit by hand.
- Screenshots are captured in the **light** theme because the manual is meant to
  be printable; both capture scripts set it, and they must agree or the PDF mixes
  palettes page to page.
- Full-page captures unstick the header and rail first; a sticky element lands
  mid-page in a stitched screenshot.
- For the browser build, copy the PDF next to `Edge Lab.html` — the **?** button
  opens it by relative path.
