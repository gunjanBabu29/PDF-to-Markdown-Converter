# Folio — PDF to Markdown, entirely in your browser

Folio converts PDF documents into clean, structured Markdown without a server,
a build step, or a network request beyond the three libraries it's built on.
Drop in a PDF and it reads the document's own typography — font sizes,
weights, indentation, spacing — to reconstruct headings, lists, tables,
links, code blocks and more as Markdown, ready to hand to an AI model, drop
into Obsidian/Notion, or commit to a docs repo.

## Running it

Just open `index.html` in a modern desktop browser (Chrome, Firefox, Edge,
or Safari). There's no install step, no `npm install`, no server. Because
the three libraries below are pulled from a CDN, you do need an internet
connection the first time a browser loads the page — after that, your
browser will typically cache them. **Your PDF itself never leaves your
device**; all parsing runs locally in the tab.

Files:
- `index.html` — page structure and library `<script>` tags
- `style.css` — the whole visual design (light + dark themes)
- `script.js` — everything else: PDF parsing, structure detection, Markdown
  generation, and the UI

## What it does

- **Drag-and-drop or browse** to load a PDF (up to ~500MB / 1000 pages —
  see [Performance](#performance-notes) below).
- **Structure detection**, using font size, weight, position and spacing:
  - Headings (multiple levels, mapped from the document's largest fonts)
  - Paragraphs, with wrapped lines merged and genuine paragraph breaks
    preserved
  - Bulleted and numbered lists (incl. basic nested indentation)
  - Tables, built from columns of text separated by consistent gaps
  - Bold and italic text
  - Hyperlinks (from the PDF's own link annotations)
  - Fenced code blocks (from monospaced text)
  - Blockquotes, figure/table captions, horizontal rules
  - Section numbering (`1.2.3 Introduction` → heading) and common section
    keywords (Abstract, References, Appendix, …) even when the font doesn't
    change
  - Table-of-contents style dot leaders (`Chapter One ..... 4`)
  - Repeated running headers/footers, watermarks, and page numbers, which
    are detected and stripped rather than injected into every page
  - A best-effort two-column layout detector that re-linearizes reading
    order
- **Live preview + raw Markdown view**, with in-document search and
  highighting.
- **Word/character counts, heading/table/link counts, estimated reading
  time.**
- **Copy to clipboard**, **download as `.md`**, or **download as plain
  `.txt`** (Markdown syntax stripped).
- **Recent conversions drawer** and **autosave draft**, both stored only in
  your browser's `localStorage` — nothing is uploaded.
- **Password-protected PDFs**: you're prompted for the password locally;
  it's passed straight to pdf.js and never stored or transmitted.
- **Light/dark theme**, keyboard shortcuts, and friendly error messages for
  invalid, corrupted, or oversized files.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/⌘ + O` | Browse for a file |
| `Ctrl/⌘ + Enter` | Convert the loaded file |
| `Ctrl/⌘ + S` | Download the Markdown |
| `F` | Focus the search box |
| `T` | Toggle light/dark theme |
| `Esc` | Close drawers/dialogs |

## Technology

- **[pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174** for reading and
  parsing the PDF. This is intentionally *not* the newest pdf.js: version
  4.0 and later ship only as ES modules, which doesn't suit a page built
  with plain `<script>` tags and no bundler. 3.11.174 is the last release
  published as a classic global-script build.
- **[marked.js](https://marked.js.org/)** to render the generated Markdown
  into the live preview.
- **[FileSaver.js](https://github.com/eligrey/FileSaver.js/)** for the
  `.md`/`.txt` download buttons.
- Everything else — drag & drop, theming, the structure-detection engine,
  the Markdown builder, search, shortcuts — is vanilla HTML/CSS/JS with no
  framework and no build tools.

## How structure detection works, briefly

There's no such thing as "headings" or "tables" inside a PDF — only text
positioned at coordinates with a given font. Folio reconstructs structure
in two passes:

1. It reads every page's positioned text, groups nearby text into lines,
   and computes document-wide statistics (which font size is "body text",
   which sizes are meaningfully larger and therefore headings).
2. It walks the lines again, classifying each one (heading / paragraph /
   list item / table row / code / quote / caption / …) using that font
   data plus pattern matching (bullet glyphs, numbering, dot leaders,
   section-keyword lists), then assembles the classified lines into
   Markdown — merging wrapped lines into paragraphs, grouping consecutive
   list items, and building `|` tables from aligned columns.

This is a heuristic process, tuned to work well on typical reports, articles,
and books — not a perfect layout parser. See below for where it's weakest.

## Known limitations

- **Heuristic, not exact.** Heading levels, list nesting, and table
  boundaries are inferred from typography and spacing. Unusually designed
  PDFs (heavy custom styling, PDFs exported from design tools without
  real font-size hierarchy, scanned/image-only PDFs with no text layer)
  will convert less cleanly.
- **Scanned PDFs aren't OCR'd.** If a PDF has no embedded text layer,
  there's nothing for Folio to extract — this tool doesn't do optical
  character recognition.
- **Images** are detected but not extracted or embedded — Folio inserts a
  `![Image on page N](image-placeholder-pN.png)` marker so the AI/reader
  knows an image was there, rather than a fully accurate export.
- **Multi-column layout** detection is a best-effort heuristic (it looks
  for a consistent gap down the middle of the page). Complex magazine-style
  layouts, mixed single/multi-column pages, or sidebars can still come out
  in the wrong order.
- **Right-to-left and vertical scripts** (e.g. Arabic) are extracted in the
  order pdf.js reports the text, sorted left-to-right — this can produce
  incorrect reading order for RTL content. Unicode text itself (Arabic,
  Hindi, Japanese, Chinese, etc.) is preserved correctly; it's specifically
  *ordering* that isn't RTL-aware.
- **Hyperlink matching** is done by overlapping each link annotation's
  rectangle with nearby text — very rarely (e.g. link text containing an
  unusual mix of punctuation) it may not attach correctly, in which case
  the plain text is kept without a link.
- **List numbering** in the output always renumbers sequentially rather
  than preserving unusual source numbering (e.g. a list that starts at 5).

## Performance notes

Everything runs on the main thread's event loop in small batches (yielding
back to the browser every few pages) so the tab stays responsive and shows
live progress, even on large documents. That said:

- A 500MB file or 1000-page document is genuinely a lot of data for a
  browser tab to hold in memory — actual limits depend on your device's
  RAM. Folio warns you if a file is very large, and reports a friendly
  error rather than a silent freeze if it runs out of memory.
- Only the first 1000 pages of a longer document are converted.
