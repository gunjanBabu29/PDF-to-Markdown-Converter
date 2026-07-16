/* ============================================================
   FOLIO — PDF to Markdown converter
   100% client-side. No network calls except the CDN libraries
   already loaded by index.html.

   Sections:
   1. Config & DOM refs
   2. Utils
   3. Theme manager
   4. Toast / error banner
   5. Recent files (localStorage)
   6. PDF engine (extraction -> classification -> markdown)
   7. UI controller (upload, convert flow, workspace, search, shortcuts)
   8. Init
   ============================================================ */

(() => {
  'use strict';

  /* ---------------------------------------------------------
     1. CONFIG & DOM REFS
  --------------------------------------------------------- */
  const CONFIG = {
    MAX_FILE_MB: 500,
    MAX_PAGES: 1000,
    RECENT_LIMIT: 5,
    RECENT_STORE_KEY: 'folio.recent',
    DRAFT_STORE_KEY: 'folio.draft',
    THEME_STORE_KEY: 'folio.theme',
    YIELD_EVERY_N_PAGES: 3,
  };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const $ = (sel) => document.querySelector(sel);
  const el = {
    fileInput: $('#fileInput'),
    dropZone: $('#dropZone'),
    browseBtn: $('#browseBtn'),
    dropIdleState: $('#dropIdleState'),
    dropFileState: $('#dropFileState'),
    fileName: $('#fileName'),
    fileMeta: $('#fileMeta'),
    convertBtn: $('#convertBtn'),
    clearBtn: $('#clearBtn'),

    progressBlock: $('#progressBlock'),
    progressLabel: $('#progressLabel'),
    progressPct: $('#progressPct'),
    progressFill: $('#progressFill'),
    progressStamps: $('#progressStamps'),

    errorBanner: $('#errorBanner'),
    errorTitle: $('#errorTitle'),
    errorDetail: $('#errorDetail'),
    errorClose: $('#errorClose'),

    workspace: $('#workspace'),
    docTitle: $('#docTitle'),
    docStats: $('#docStats'),
    searchInput: $('#searchInput'),
    searchCount: $('#searchCount'),
    viewToggle: $('#viewToggle'),
    previewPane: $('#previewPane'),
    sourcePane: $('#sourcePane'),

    statWords: $('#statWords'),
    statChars: $('#statChars'),
    statHeadings: $('#statHeadings'),
    statTables: $('#statTables'),
    statLinks: $('#statLinks'),

    copyBtn: $('#copyBtn'),
    downloadTxtBtn: $('#downloadTxtBtn'),
    downloadMdBtn: $('#downloadMdBtn'),

    themeToggle: $('#themeToggle'),
    themeIconSun: $('#themeIconSun'),
    themeIconMoon: $('#themeIconMoon'),

    recentBtn: $('#recentBtn'),
    recentDrawer: $('#recentDrawer'),
    recentBackdrop: $('#recentBackdrop'),
    recentClose: $('#recentClose'),
    recentList: $('#recentList'),
    clearRecentBtn: $('#clearRecentBtn'),

    passwordModal: $('#passwordModal'),
    passwordInput: $('#passwordInput'),
    passwordError: $('#passwordError'),
    passwordSubmit: $('#passwordSubmit'),
    passwordCancel: $('#passwordCancel'),

    toast: $('#toast'),
  };

  /* ---------------------------------------------------------
     2. UTILS
  --------------------------------------------------------- */
  const Utils = {
    formatBytes(bytes) {
      if (!bytes && bytes !== 0) return '—';
      if (bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    },
    debounce(fn, wait) {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    },
    escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
    // Escape both HTML-significant characters (so literal text from the PDF
    // is never mistaken for a tag when the Markdown is rendered to HTML) and
    // markdown-significant characters (so the source's own punctuation can't
    // be mistaken for syntax we generate ourselves).
    escapeMdInline(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/\|/g, '\\|')
        .replace(/~/g, '\\~');
    },
    clamp(n, min, max) { return Math.max(min, Math.min(max, n)); },
    yieldToBrowser() {
      return new Promise((resolve) => {
        if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 50 });
        else setTimeout(resolve, 0);
      });
    },
    normalizeSpace(str) { return str.replace(/\s+/g, ' ').trim(); },
    wordCount(str) {
      const m = str.trim().match(/[^\s]+/g);
      return m ? m.length : 0;
    },
    slugTitle(name) { return name.replace(/\.pdf$/i, ''); },
    downloadBlob(content, filename, type) {
      const blob = new Blob([content], { type });
      saveAs(blob, filename);
    },
  };

  /* ---------------------------------------------------------
     3. THEME MANAGER
  --------------------------------------------------------- */
  const ThemeManager = {
    init() {
      const saved = localStorage.getItem(CONFIG.THEME_STORE_KEY);
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.set(saved || (prefersDark ? 'dark' : 'light'));
      el.themeToggle.addEventListener('click', () => this.toggle());
    },
    set(theme) {
      document.body.setAttribute('data-theme', theme);
      el.themeIconSun.style.display = theme === 'dark' ? 'none' : 'block';
      el.themeIconMoon.style.display = theme === 'dark' ? 'block' : 'none';
      localStorage.setItem(CONFIG.THEME_STORE_KEY, theme);
    },
    toggle() {
      const cur = document.body.getAttribute('data-theme');
      this.set(cur === 'dark' ? 'light' : 'dark');
    },
  };

  /* ---------------------------------------------------------
     4. TOAST / ERROR BANNER
  --------------------------------------------------------- */
  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  function showError(title, detail) {
    el.errorTitle.textContent = title;
    el.errorDetail.textContent = detail || '';
    el.errorBanner.hidden = false;
  }
  function hideError() { el.errorBanner.hidden = true; }
  el.errorClose.addEventListener('click', hideError);

  /* ---------------------------------------------------------
     5. RECENT FILES (localStorage)
  --------------------------------------------------------- */
  const RecentFiles = {
    load() {
      try { return JSON.parse(localStorage.getItem(CONFIG.RECENT_STORE_KEY)) || []; }
      catch { return []; }
    },
    save(entry) {
      let list = this.load();
      list = list.filter((e) => e.name !== entry.name || e.size !== entry.size);
      list.unshift(entry);
      list = list.slice(0, CONFIG.RECENT_LIMIT);
      try { localStorage.setItem(CONFIG.RECENT_STORE_KEY, JSON.stringify(list)); }
      catch { /* storage full — silently skip history */ }
    },
    clear() { localStorage.removeItem(CONFIG.RECENT_STORE_KEY); },
    render() {
      const list = this.load();
      if (!list.length) {
        el.recentList.innerHTML = '<p class="drawer__empty">Nothing yet — conversions you run in this browser will show up here.</p>';
        return;
      }
      el.recentList.innerHTML = list.map((item, i) => `
        <div class="recent-item" data-index="${i}">
          <span class="recent-item__name">${Utils.escapeHtml(item.name)}</span>
          <span class="recent-item__meta">${item.pages} pages · ${Utils.formatBytes(item.size)} · ${new Date(item.date).toLocaleString()}</span>
        </div>`).join('');
      el.recentList.querySelectorAll('.recent-item').forEach((node) => {
        node.addEventListener('click', () => {
          const item = list[Number(node.dataset.index)];
          if (item && item.markdown) {
            App.renderResult(item.markdown, { name: item.name, pages: item.pages, size: item.size });
            closeDrawer();
            showToast('Loaded from history');
          }
        });
      });
    },
  };

  function openDrawer() { RecentFiles.render(); el.recentDrawer.hidden = false; }
  function closeDrawer() { el.recentDrawer.hidden = true; }
  el.recentBtn.addEventListener('click', openDrawer);
  el.recentClose.addEventListener('click', closeDrawer);
  el.recentBackdrop.addEventListener('click', closeDrawer);
  el.clearRecentBtn.addEventListener('click', () => { RecentFiles.clear(); RecentFiles.render(); showToast('History cleared'); });

  /* ---------------------------------------------------------
     6. PDF ENGINE
  --------------------------------------------------------- */
  const HEADING_KEYWORDS = new Set([
    'abstract', 'introduction', 'conclusion', 'conclusions', 'references', 'bibliography',
    'acknowledgements', 'acknowledgments', 'appendix', 'annexure', 'contents', 'table of contents',
    'summary', 'overview', 'preface', 'foreword', 'glossary', 'index',
  ]);

  const BULLET_RE = /^[•◦‣▪▶●○·∙‑–—-]\s+(?=\S)/;
  const ORDERED_RE = /^(\d{1,3}|[a-hA-H]|[ivxlcdmIVXLCDM]{1,7})[.)]\s+(?=\S)/;
  const SECTION_NUM_RE = /^(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+(?=\S)/;
  const HR_RE = /^[-_=*]{3,}$/;
  const MONO_FONT_RE = /mono|courier|consolas|menlo|typewriter/i;
  const BOLD_FONT_RE = /bold|black|heavy|semibold/i;
  const ITALIC_FONT_RE = /italic|oblique/i;
  const PAGE_NUM_LINE_RE = /^(page\s+)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;
  const DOT_LEADER_RE = /\.{2,}\s*(\d{1,4})\s*$/;

  const PdfEngine = {
    /**
     * Load a PDF document from an ArrayBuffer, handling password protection
     * via an interactive modal. Resolves to a pdf.js PDFDocumentProxy.
     */
    loadDocument(arrayBuffer) {
      return new Promise((resolve, reject) => {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        let cancelled = false;

        loadingTask.onPassword = (callback, reason) => {
          const isRetry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
          PasswordModal.open(isRetry, (pwd) => {
            if (pwd === null) {
              cancelled = true;
              try { loadingTask.destroy(); } catch { /* noop */ }
              reject(new FriendlyError('Cancelled', 'Password entry was cancelled.'));
              return;
            }
            callback(pwd);
          });
        };

        loadingTask.promise.then(
          (doc) => { if (!cancelled) resolve(doc); },
          (err) => { if (!cancelled) reject(err); }
        );
      });
    },

    /** Pull raw positioned text items + annotations + image flag for one page. */
    async extractPage(pdfDoc, pageNum) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      let annotations = [];
      try { annotations = await page.getAnnotations(); } catch { annotations = []; }

      let hasImages = false;
      try {
        const opList = await page.getOperatorList();
        hasImages = opList.fnArray.some((fn) =>
          fn === pdfjsLib.OPS.paintImageXObject ||
          fn === pdfjsLib.OPS.paintJpegXObject ||
          fn === pdfjsLib.OPS.paintImageMaskXObject);
      } catch { hasImages = false; }

      const items = textContent.items
        .filter((it) => typeof it.str === 'string')
        .map((it) => {
          const tx = it.transform;
          const fontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || Math.abs(tx[0]) || 10;
          const styleEntry = textContent.styles ? textContent.styles[it.fontName] : null;
          const fontFamily = (styleEntry && styleEntry.fontFamily) || '';
          return {
            text: it.str,
            x: tx[4],
            y: tx[5],
            width: it.width || 0,
            fontSize,
            fontKey: it.fontName || '',
            fontFamily,
            bold: BOLD_FONT_RE.test(it.fontName || '') || BOLD_FONT_RE.test(fontFamily),
            italic: ITALIC_FONT_RE.test(it.fontName || '') || ITALIC_FONT_RE.test(fontFamily),
            mono: MONO_FONT_RE.test(it.fontName || '') || MONO_FONT_RE.test(fontFamily),
          };
        })
        .filter((it) => it.text.length > 0);

      page.cleanup();
      return { pageNum, items, annotations, hasImages, width: viewport.width, height: viewport.height };
    },

    /** Cluster raw items into visual lines (top-to-bottom, left-to-right). */
    groupIntoLines(items) {
      const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of sorted) {
        const tol = Math.max(2, it.fontSize * 0.42);
        let line = lines.find((l) => Math.abs(l.y - it.y) < tol);
        if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
        line.items.push(it);
        line.y = (line.y * (line.items.length - 1) + it.y) / line.items.length;
      }
      lines.sort((a, b) => b.y - a.y);
      lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
      return lines;
    },

    /** Detect a simple two-column layout and reorder lines into reading order. */
    resolveColumns(lines, pageWidth) {
      if (lines.length < 8) return lines;
      const mid = pageWidth / 2;
      let leftOnly = 0, rightOnly = 0, spanning = 0;
      for (const line of lines) {
        const minX = Math.min(...line.items.map((i) => i.x));
        const maxX = Math.max(...line.items.map((i) => i.x + i.width));
        if (maxX < mid - pageWidth * 0.04) leftOnly++;
        else if (minX > mid + pageWidth * 0.04) rightOnly++;
        else spanning++;
      }
      const columnish = leftOnly > lines.length * 0.28 && rightOnly > lines.length * 0.28 && spanning < lines.length * 0.35;
      if (!columnish) return lines;
      const left = [], right = [], full = [];
      for (const line of lines) {
        const minX = Math.min(...line.items.map((i) => i.x));
        const maxX = Math.max(...line.items.map((i) => i.x + i.width));
        if (maxX < mid) left.push(line);
        else if (minX > mid) right.push(line);
        else full.push(line);
      }
      // Full-width lines (titles spanning both columns) are rare mid-column;
      // keep overall order stable by interleaving at their natural position.
      return [...left, ...right, ...full];
    },

    /** Build a line's escaped, whitespace-joined text, flagging cell gaps for table detection. */
    buildLineText(line) {
      const items = line.items;
      let text = '';
      let cellBreaks = 0;
      const cells = [];
      let currentCell = '';
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const clean = it.text.replace(/\s+/g, ' ');
        if (i > 0) {
          const prev = items[i - 1];
          const gap = it.x - (prev.x + prev.width);
          const avgCharW = Math.max(2, prev.fontSize * 0.5);
          if (gap > avgCharW * 3.2) {
            cellBreaks++;
            cells.push(currentCell.trim());
            currentCell = '';
            text += '  '; // visually keep separation in plain text
          } else if (gap > avgCharW * 0.35 && !text.endsWith(' ')) {
            text += ' ';
            currentCell += ' ';
          }
        }
        text += clean;
        currentCell += clean;
      }
      cells.push(currentCell.trim());
      return {
        raw: text.trim(),
        cells: cells.filter((c) => c.length > 0),
        cellBreaks,
        fontSize: this.dominantFontSize(items),
        bold: items.filter((i) => i.bold).length > items.length / 2,
        italic: items.filter((i) => i.italic).length > items.length / 2,
        mono: items.every((i) => i.mono),
        startX: Math.min(...items.map((i) => i.x)),
        endX: Math.max(...items.map((i) => i.x + i.width)),
      };
    },

    dominantFontSize(items) {
      const counts = new Map();
      for (const it of items) {
        const key = Math.round(it.fontSize * 2) / 2;
        counts.set(key, (counts.get(key) || 0) + it.text.length);
      }
      let best = items[0] ? items[0].fontSize : 10, bestCount = -1;
      for (const [size, count] of counts) if (count > bestCount) { best = size; bestCount = count; }
      return best;
    },

    /** First pass over the whole doc: figure out body font size + heading size thresholds. */
    computeGlobalStats(pagesData) {
      const sizeWeights = new Map();
      for (const page of pagesData) {
        for (const it of page.items) {
          const key = Math.round(it.fontSize * 2) / 2;
          sizeWeights.set(key, (sizeWeights.get(key) || 0) + it.text.length);
        }
      }
      let bodySize = 10, bodyWeight = -1;
      for (const [size, weight] of sizeWeights) if (weight > bodyWeight) { bodySize = size; bodyWeight = weight; }

      const headingSizes = [...sizeWeights.keys()]
        .filter((s) => s > bodySize * 1.12)
        .sort((a, b) => b - a)
        .slice(0, 4);

      return { bodySize, headingSizes };
    },

    /** Find lines that repeat across many pages near the top/bottom edge — headers, footers, watermarks. */
    detectRepeatedChrome(pagesLines, pageHeights) {
      const freq = new Map(); // normalized text -> count
      const totalPages = pagesLines.length;
      pagesLines.forEach((lines, idx) => {
        const height = pageHeights[idx] || 792;
        lines.forEach((line) => {
          const relY = line.y / height;
          if (relY > 0.9 || relY < 0.09) {
            const norm = Utils.normalizeSpace(line.text.raw).toLowerCase().replace(/\d+/g, '#');
            if (norm.length < 2) return;
            freq.set(norm, (freq.get(norm) || 0) + 1);
          }
        });
      });
      const threshold = Math.max(3, Math.ceil(totalPages * 0.35));
      const chrome = new Set();
      for (const [norm, count] of freq) if (count >= threshold) chrome.add(norm);
      return chrome;
    },

    isChromeLine(line, chromeSet, pageHeight) {
      const relY = line.y / pageHeight;
      if (relY <= 0.9 && relY >= 0.09) return false;
      if (PAGE_NUM_LINE_RE.test(line.text.raw.trim())) return true;
      const norm = Utils.normalizeSpace(line.text.raw).toLowerCase().replace(/\d+/g, '#');
      return chromeSet.has(norm);
    },

    /** Classify a single line into a semantic type used by the markdown builder. */
    classifyLine(line, stats, prevLine) {
      const raw = line.text.raw.trim();
      if (!raw) return { type: 'blank' };

      if (HR_RE.test(raw)) return { type: 'hr' };

      if (line.text.mono && raw.length > 0) return { type: 'code', text: raw };

      if (/^>\s?/.test(raw)) return { type: 'quote', text: raw.replace(/^>\s?/, '') };

      const captionMatch = raw.match(/^(figure|fig\.?|table|chart|image)\s+\d+[:.]?\s*/i);
      if (captionMatch) return { type: 'caption', text: raw };

      const normKeyword = raw.toLowerCase().replace(/[:.\s]+$/, '');
      if (HEADING_KEYWORDS.has(normKeyword) && raw.length < 40) {
        return { type: 'heading', level: 2, text: raw.replace(/[:.\s]+$/, '') };
      }

      // Only multi-level numbering (e.g. "1.2", "2.3.4") is treated as a section
      // heading here — a single leading number ("1. Item") is an ordered list
      // item and is handled later, once headings/quotes/captions are ruled out.
      const sectionMatch = raw.match(SECTION_NUM_RE);
      if (sectionMatch && sectionMatch[1].includes('.') && raw.length < 120) {
        const depth = sectionMatch[1].split('.').length;
        const level = Utils.clamp(depth, 1, 4);
        return { type: 'heading', level, text: raw };
      }

      if (stats.headingSizes.length && line.text.fontSize > stats.bodySize * 1.12) {
        const level = stats.headingSizes.indexOf(
          stats.headingSizes.find((s) => Math.abs(s - line.text.fontSize) < 0.6) ?? stats.headingSizes[stats.headingSizes.length - 1]
        );
        return { type: 'heading', level: Utils.clamp(level + 1, 1, 4), text: raw };
      }

      // Explicit markers (lists, tables) are stronger signals than the "soft"
      // bold-heading guess below, so they're checked first.
      if (line.text.cellBreaks >= 1 && line.text.cells.length >= 2) {
        return { type: 'tablerow', cells: line.text.cells };
      }

      if (BULLET_RE.test(raw)) {
        return { type: 'bullet', text: raw.replace(BULLET_RE, ''), indent: line.text.startX };
      }

      if (ORDERED_RE.test(raw)) {
        return { type: 'ordered', text: raw.replace(ORDERED_RE, ''), indent: line.text.startX };
      }

      // Bold, short, standalone line with no terminal punctuation -> likely a heading
      if (line.text.bold && raw.length < 70 && !/[,;:]$/.test(raw) && Utils.wordCount(raw) <= 12) {
        return { type: 'heading', level: 3, text: raw, soft: true };
      }

      const dotLeader = raw.match(DOT_LEADER_RE);
      if (dotLeader) {
        return { type: 'tocentry', text: raw.replace(DOT_LEADER_RE, '').trim(), page: dotLeader[1] };
      }

      return { type: 'para', text: raw, bold: line.text.bold, italic: line.text.italic, indent: line.text.startX };
    },

    /** Wrap plain text with link markdown for any PDF link annotations overlapping it. */
    applyLinks(text, lineItems, annotations, pageHeight) {
      if (!annotations.length) return text;
      const links = annotations.filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl));
      if (!links.length) return text;

      // Build a rough map from character ranges to URLs by matching item x-position to annot rects.
      let result = text;
      for (const link of links) {
        const url = link.url || link.unsafeUrl;
        if (!url) continue;
        const [x1, y1, x2, y2] = link.rect;
        const overlapping = lineItems.filter((it) => {
          const itYMid = it.y;
          return it.x + it.width >= x1 - 1 && it.x <= x2 + 1 && itYMid >= y1 - 3 && itYMid <= y2 + 3;
        });
        if (!overlapping.length) continue;
        const linkText = overlapping.map((it) => it.text).join('').trim();
        if (linkText && result.includes(linkText)) {
          const safeUrl = url.replace(/\)/g, '%29').replace(/ /g, '%20');
          result = result.replace(linkText, `[${linkText}](${safeUrl})`);
        }
      }
      return result;
    },

    /**
     * Main entry point: turn a loaded PDFDocumentProxy into an AI-ready
     * Markdown string, reporting progress via onProgress(pageNum, total).
     */
    async convert(pdfDoc, onProgress) {
      const totalPages = Math.min(pdfDoc.numPages, CONFIG.MAX_PAGES);
      const pagesData = [];

      for (let p = 1; p <= totalPages; p++) {
        const pageData = await this.extractPage(pdfDoc, p);
        pagesData.push(pageData);
        onProgress(p, totalPages, 'reading');
        if (p % CONFIG.YIELD_EVERY_N_PAGES === 0) await Utils.yieldToBrowser();
      }

      const stats = this.computeGlobalStats(pagesData);

      const pagesLines = pagesData.map((page) => {
        const rawLines = this.groupIntoLines(page.items);
        const ordered = this.resolveColumns(rawLines, page.width);
        return ordered.map((l) => ({ y: l.y, items: l.items, text: this.buildLineText(l) }));
      });

      const chromeSet = this.detectRepeatedChrome(pagesLines, pagesData.map((p) => p.height));

      const md = [];
      const docStats = { headings: 0, tables: 0, links: 0 };
      let paragraphBuffer = [];
      let listBuffer = []; // { ordered, items: [{text, level}] }
      let tableBuffer = []; // array of {cells}
      let inCodeBlock = false;
      let codeBuffer = [];

      const flushParagraph = () => {
        if (!paragraphBuffer.length) return;
        let text = paragraphBuffer.join(' ').replace(/\s+/g, ' ').trim();
        md.push(text);
        md.push('');
        paragraphBuffer = [];
      };
      const flushList = () => {
        if (!listBuffer.length) return;
        for (const item of listBuffer) {
          const indentLevel = item.indentLevel || 0;
          const prefix = '  '.repeat(indentLevel) + (item.ordered ? `${item.num}.` : '-');
          md.push(`${prefix} ${item.text}`);
        }
        md.push('');
        listBuffer = [];
      };
      const flushTable = () => {
        if (tableBuffer.length < 1) { tableBuffer = []; return; }
        const colCount = Math.max(...tableBuffer.map((r) => r.cells.length));
        if (colCount < 2 || tableBuffer.length < 2) {
          // Not really a table — dump as paragraph lines instead.
          for (const row of tableBuffer) md.push(row.cells.join('  '));
          md.push('');
          tableBuffer = [];
          return;
        }
        docStats.tables++;
        const pad = (cells) => {
          const c = cells.slice(0, colCount);
          while (c.length < colCount) c.push('');
          return c;
        };
        const header = pad(tableBuffer[0].cells);
        md.push(`| ${header.join(' | ')} |`);
        md.push(`| ${header.map(() => '---').join(' | ')} |`);
        for (let i = 1; i < tableBuffer.length; i++) {
          md.push(`| ${pad(tableBuffer[i].cells).join(' | ')} |`);
        }
        md.push('');
        tableBuffer = [];
      };
      const flushCode = () => {
        if (!codeBuffer.length) return;
        md.push('```');
        md.push(...codeBuffer);
        md.push('```');
        md.push('');
        codeBuffer = [];
      };
      const flushAll = () => { flushParagraph(); flushList(); flushTable(); flushCode(); };

      let lastIndent = null;
      let orderedCounter = 1;
      let prevLineY = null;

      for (let pi = 0; pi < pagesLines.length; pi++) {
        const page = pagesData[pi];
        const lines = pagesLines[pi];
        prevLineY = null;

        if (pi > 0) {
          flushAll();
          md.push(`<!-- Page ${page.pageNum} -->`);
          md.push('');
        }

        for (const line of lines) {
          if (this.isChromeLine(line, chromeSet, page.height)) continue;

          // A vertical gap noticeably bigger than a normal line-to-line step
          // means a new paragraph in the source PDF, even though nothing
          // else about the line signals it — this keeps wrapped lines merged
          // while still preserving genuine paragraph breaks.
          if (prevLineY !== null) {
            const lineHeight = Math.max(8, line.text.fontSize * 1.15);
            if (prevLineY - line.y > lineHeight * 1.7) flushParagraph();
          }
          prevLineY = line.y;

          const cls = this.classifyLine(line, stats);

          if (cls.type === 'blank') continue;

          if (cls.type === 'code') {
            flushParagraph(); flushList(); flushTable();
            codeBuffer.push(cls.text);
            inCodeBlock = true;
            continue;
          }
          if (inCodeBlock && cls.type !== 'code') { flushCode(); inCodeBlock = false; }

          if (cls.type === 'tablerow') {
            flushParagraph(); flushList();
            tableBuffer.push({ cells: cls.cells.map((c) => Utils.escapeMdInline(c)) });
            continue;
          }
          if (cls.type !== 'tablerow' && tableBuffer.length) flushTable();

          if (cls.type === 'hr') {
            flushParagraph(); flushList();
            md.push('---'); md.push('');
            continue;
          }

          if (cls.type === 'heading') {
            flushParagraph(); flushList();
            docStats.headings++;
            const headingEscaped = Utils.escapeMdInline(cls.text);
            const linked = this.applyLinks(headingEscaped, line.items, page.annotations, page.height);
            md.push(`${'#'.repeat(cls.level)} ${linked}`);
            md.push('');
            continue;
          }

          if (cls.type === 'caption') {
            flushParagraph(); flushList();
            md.push(`*${Utils.escapeMdInline(cls.text)}*`);
            md.push('');
            continue;
          }

          if (cls.type === 'quote') {
            flushParagraph(); flushList();
            md.push(`> ${Utils.escapeMdInline(cls.text)}`);
            continue;
          }

          if (cls.type === 'tocentry') {
            flushParagraph(); flushList();
            md.push(`- ${Utils.escapeMdInline(cls.text)} — p.${cls.page}`);
            continue;
          }

          if (cls.type === 'bullet' || cls.type === 'ordered') {
            flushParagraph();
            const indentLevel = lastIndent === null ? 0 : (cls.indent > lastIndent + 8 ? 1 : cls.indent < lastIndent - 8 ? 0 : listBuffer.length ? listBuffer[listBuffer.length - 1].indentLevel : 0);
            lastIndent = cls.indent;
            const listEscaped = Utils.escapeMdInline(cls.text);
            const linked = this.applyLinks(listEscaped, line.items, page.annotations, page.height);
            listBuffer.push({
              ordered: cls.type === 'ordered',
              num: cls.type === 'ordered' ? orderedCounter++ : null,
              text: linked,
              indentLevel,
            });
            if (cls.type === 'bullet') orderedCounter = 1;
            continue;
          }

          // Regular paragraph line
          flushList();
          lastIndent = null;
          orderedCounter = 1;
          let text = Utils.escapeMdInline(cls.text);
          text = this.applyLinks(text, line.items, page.annotations, page.height);
          if (cls.bold) text = `**${text}**`;
          else if (cls.italic) text = `*${text}*`;
          paragraphBuffer.push(text);
        }

        if (page.hasImages) {
          flushAll();
          md.push(`![Image on page ${page.pageNum}](image-placeholder-p${page.pageNum}.png)`);
          md.push('');
        }

        onProgress(pi + 1, pagesLines.length, 'structuring');
        if (pi % CONFIG.YIELD_EVERY_N_PAGES === 0) await Utils.yieldToBrowser();
      }

      flushAll();

      // Count links from generated markdown for the stats bar.
      const linkMatches = md.join('\n').match(/\]\(https?:\/\/[^\s)]+\)/g);
      docStats.links = linkMatches ? linkMatches.length : 0;

      // Collapse 3+ blank lines to a max of 2, trim trailing whitespace.
      let result = md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      return { markdown: result, docStats, totalPages };
    },
  };

  function FriendlyError(title, detail) {
    const e = new Error(detail);
    e.friendlyTitle = title;
    e.friendlyDetail = detail;
    return e;
  }

  /* ---------------------------------------------------------
     PASSWORD MODAL controller
  --------------------------------------------------------- */
  const PasswordModal = {
    _cb: null,
    open(isRetry, cb) {
      this._cb = cb;
      el.passwordError.hidden = !isRetry;
      el.passwordInput.value = '';
      el.passwordModal.hidden = false;
      setTimeout(() => el.passwordInput.focus(), 50);
    },
    submit() {
      const pwd = el.passwordInput.value;
      el.passwordModal.hidden = true;
      if (this._cb) this._cb(pwd || '');
    },
    cancel() {
      el.passwordModal.hidden = true;
      if (this._cb) this._cb(null);
    },
  };
  el.passwordSubmit.addEventListener('click', () => PasswordModal.submit());
  el.passwordCancel.addEventListener('click', () => PasswordModal.cancel());
  el.passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') PasswordModal.submit(); });

  /* ---------------------------------------------------------
     7. UI CONTROLLER
  --------------------------------------------------------- */
  const App = {
    file: null,
    pdfDoc: null,
    markdown: '',
    docMeta: {},

    init() {
      ThemeManager.init();
      this.bindUpload();
      this.bindWorkspace();
      this.bindShortcuts();
      this.restoreDraft();
    },

    bindUpload() {
      el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
      el.dropZone.addEventListener('click', (e) => {
        if (e.target.closest('#browseBtn')) return; // browseBtn already opened the dialog
        if (!this.file && e.target.closest('#dropIdleState')) el.fileInput.click();
      });
      el.dropZone.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !this.file) { e.preventDefault(); el.fileInput.click(); }
      });

      el.fileInput.addEventListener('change', () => {
        if (el.fileInput.files[0]) this.handleFile(el.fileInput.files[0]);
      });

      ['dragenter', 'dragover'].forEach((evt) => {
        el.dropZone.addEventListener(evt, (e) => {
          e.preventDefault(); e.stopPropagation();
          el.dropZone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach((evt) => {
        el.dropZone.addEventListener(evt, (e) => {
          e.preventDefault(); e.stopPropagation();
          el.dropZone.classList.remove('is-dragover');
        });
      });
      el.dropZone.addEventListener('drop', (e) => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleFile(f);
      });

      el.convertBtn.addEventListener('click', () => this.startConversion());
      el.clearBtn.addEventListener('click', () => this.reset());
    },

    handleFile(file) {
      hideError();
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!isPdf) {
        showError('Unsupported format', 'Folio only reads PDF files. Please choose a .pdf document.');
        return;
      }
      if (file.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
        showError('File too large', `This file is ${Utils.formatBytes(file.size)}. Folio works best under ${CONFIG.MAX_FILE_MB}MB — very large files may freeze your browser tab.`);
      }
      this.file = file;
      el.fileName.textContent = file.name;
      el.fileMeta.textContent = `${Utils.formatBytes(file.size)} · PDF document`;
      el.dropIdleState.hidden = true;
      el.dropFileState.hidden = false;
    },

    reset() {
      this.file = null;
      this.pdfDoc = null;
      this.markdown = '';
      el.fileInput.value = '';
      el.dropIdleState.hidden = false;
      el.dropFileState.hidden = true;
      el.progressBlock.hidden = true;
      el.workspace.hidden = true;
      hideError();
      localStorage.removeItem(CONFIG.DRAFT_STORE_KEY);
    },

    async startConversion() {
      if (!this.file) return;
      hideError();
      el.workspace.hidden = true;
      el.progressBlock.hidden = false;
      el.convertBtn.disabled = true;
      el.progressLabel.textContent = 'Loading document…';
      el.progressFill.style.width = '4%';
      el.progressPct.textContent = '4%';
      el.progressStamps.textContent = '';

      try {
        const buffer = await this.file.arrayBuffer();
        const pdfDoc = await PdfEngine.loadDocument(buffer);
        this.pdfDoc = pdfDoc;

        if (pdfDoc.numPages > CONFIG.MAX_PAGES) {
          el.progressStamps.textContent = `Document has ${pdfDoc.numPages} pages — converting the first ${CONFIG.MAX_PAGES}.`;
        }

        const onProgress = (done, total, phase) => {
          const phaseShare = phase === 'reading' ? 0.6 : 0.4;
          const phaseBase = phase === 'reading' ? 0 : 0.6;
          const pct = Math.round((phaseBase + (done / total) * phaseShare) * 100);
          el.progressFill.style.width = `${pct}%`;
          el.progressPct.textContent = `${pct}%`;
          el.progressLabel.textContent = phase === 'reading'
            ? `Reading page ${done} of ${total}…`
            : `Detecting structure — page ${done} of ${total}…`;
        };

        const { markdown, docStats, totalPages } = await PdfEngine.convert(pdfDoc, onProgress);
        this.markdown = markdown;

        el.progressFill.style.width = '100%';
        el.progressPct.textContent = '100%';
        el.progressLabel.textContent = 'Done';

        const meta = { name: this.file.name, pages: totalPages, size: this.file.size };
        this.docMeta = meta;
        this.renderResult(markdown, meta, docStats);

        RecentFiles.save({
          name: this.file.name,
          size: this.file.size,
          pages: totalPages,
          date: Date.now(),
          markdown: markdown.length < 500000 ? markdown : null,
        });

        setTimeout(() => { el.progressBlock.hidden = true; }, 600);
      } catch (err) {
        el.progressBlock.hidden = true;
        this.reportConversionError(err);
      } finally {
        el.convertBtn.disabled = false;
      }
    },

    reportConversionError(err) {
      if (err && err.friendlyTitle) {
        showError(err.friendlyTitle, err.friendlyDetail);
        return;
      }
      const name = err && err.name;
      if (name === 'PasswordException') {
        showError('Password required', "This PDF is protected and no password was provided, so it couldn't be opened.");
      } else if (name === 'InvalidPDFException') {
        showError('Invalid PDF', "This file doesn't look like a valid PDF — it may be corrupted or mislabeled.");
      } else if (name === 'MissingPDFException') {
        showError('File not found', 'The file could not be read from disk.');
      } else if (name === 'UnexpectedResponseException') {
        showError('Couldn\'t read file', 'The file could not be loaded. Try re-saving or re-exporting the PDF.');
      } else if (err instanceof RangeError || /memory/i.test((err && err.message) || '')) {
        showError('Ran out of memory', 'This file is too large for your browser to process. Try a smaller file, or split the PDF first.');
      } else {
        console.error(err);
        showError('Conversion failed', (err && err.message) || 'An unexpected error occurred while converting this file.');
      }
    },

    renderResult(markdown, meta, docStats) {
      this.markdown = markdown;
      this.docMeta = meta;
      el.docTitle.textContent = meta.name;
      const words = Utils.wordCount(markdown);
      const readMin = Math.max(1, Math.round(words / 200));
      el.docStats.textContent = `${meta.pages} pages · ${words.toLocaleString()} words · ${readMin} min read`;

      el.statWords.textContent = words.toLocaleString();
      el.statChars.textContent = markdown.length.toLocaleString();
      el.statHeadings.textContent = (docStats ? docStats.headings : (markdown.match(/^#{1,4}\s/gm) || []).length).toLocaleString();
      el.statTables.textContent = (docStats ? docStats.tables : (markdown.match(/^\|.*\|$/gm) || []).length).toLocaleString();
      el.statLinks.textContent = (docStats ? docStats.links : (markdown.match(/\]\(https?:\/\//g) || []).length).toLocaleString();

      el.sourcePane.value = markdown;
      this.updatePreview();
      el.workspace.hidden = false;
      el.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.saveDraft();
    },

    updatePreview() {
      const html = marked.parse(this.markdown, { breaks: false, gfm: true });
      el.previewPane.innerHTML = html;
    },

    bindWorkspace() {
      el.viewToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.view-toggle__btn');
        if (!btn) return;
        el.viewToggle.querySelectorAll('.view-toggle__btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const view = btn.dataset.view;
        el.previewPane.hidden = view !== 'preview';
        el.sourcePane.hidden = view !== 'source';
        if (view === 'source') el.sourcePane.value = this.markdown;
      });

      el.sourcePane.addEventListener('input', Utils.debounce(() => {
        this.markdown = el.sourcePane.value;
        this.updatePreview();
        this.saveDraft();
      }, 300));

      el.copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(this.markdown);
          showToast('Markdown copied to clipboard');
        } catch {
          el.sourcePane.select();
          document.execCommand('copy');
          showToast('Markdown copied to clipboard');
        }
      });

      el.downloadMdBtn.addEventListener('click', () => {
        const base = Utils.slugTitle(this.docMeta.name || 'document');
        Utils.downloadBlob(this.markdown, `${base}.md`, 'text/markdown;charset=utf-8');
      });
      el.downloadTxtBtn.addEventListener('click', () => {
        const base = Utils.slugTitle(this.docMeta.name || 'document');
        const plain = this.markdown
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/^>\s?/gm, '')
          .replace(/^\|.*\|$/gm, (l) => l.replace(/\|/g, '').trim())
          .replace(/^---$/gm, '');
        Utils.downloadBlob(plain, `${base}.txt`, 'text/plain;charset=utf-8');
      });

      el.searchInput.addEventListener('input', Utils.debounce(() => this.runSearch(), 200));
    },

    runSearch() {
      const q = el.searchInput.value.trim();
      // Reset preview to clean render first.
      this.updatePreview();
      if (!q) { el.searchCount.textContent = ''; return; }
      const walker = document.createTreeWalker(el.previewPane, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let count = 0;
      for (const node of nodes) {
        if (!re.test(node.nodeValue)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        let m;
        while ((m = re.exec(node.nodeValue))) {
          count++;
          frag.appendChild(document.createTextNode(node.nodeValue.slice(lastIndex, m.index)));
          const mark = document.createElement('mark');
          mark.textContent = m[0];
          frag.appendChild(mark);
          lastIndex = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(node.nodeValue.slice(lastIndex)));
        node.parentNode.replaceChild(frag, node);
      }
      el.searchCount.textContent = count ? `${count} match${count === 1 ? '' : 'es'}` : 'No matches';
      const firstMark = el.previewPane.querySelector('mark');
      if (firstMark) firstMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },

    saveDraft() {
      try {
        localStorage.setItem(CONFIG.DRAFT_STORE_KEY, JSON.stringify({
          name: this.docMeta.name, pages: this.docMeta.pages, size: this.docMeta.size, markdown: this.markdown,
        }));
      } catch { /* storage full — skip autosave */ }
    },

    restoreDraft() {
      try {
        const draft = JSON.parse(localStorage.getItem(CONFIG.DRAFT_STORE_KEY));
        if (draft && draft.markdown) {
          this.renderResult(draft.markdown, { name: draft.name, pages: draft.pages, size: draft.size });
        }
      } catch { /* no draft */ }
    },

    bindShortcuts() {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea';

        if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); }
        else if (mod && e.key === 'Enter') { e.preventDefault(); if (this.file) this.startConversion(); }
        else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (this.markdown) el.downloadMdBtn.click(); }
        else if (!typing && e.key.toLowerCase() === 'f') { e.preventDefault(); el.searchInput.focus(); }
        else if (!typing && e.key.toLowerCase() === 't') { ThemeManager.toggle(); }
        else if (e.key === 'Escape') { closeDrawer(); if (!el.passwordModal.hidden) PasswordModal.cancel(); }
      });
    },
  };

  window.App = App;

  /* ---------------------------------------------------------
     8. INIT
  --------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => App.init());
})();