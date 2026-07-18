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
    SETTINGS_STORE_KEY: 'folio.settings',
    YIELD_EVERY_N_PAGES: 3,
    OCR_MIN_CHARS: 20,       // pages with less real text than this are treated as scanned
    OCR_RENDER_SCALE: 2,     // higher = more accurate OCR, slower
    TESSERACT_SRC: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
    HEADING_MULTIPLIERS: { relaxed: 1.06, balanced: 1.12, strict: 1.22 },
    DEFAULT_SETTINGS: {
      ocrEnabled: false,
      ocrLanguage: 'eng',
      stripHeaderFooter: true,
      includePageBreaks: true,
      headingSensitivity: 'balanced',
      pageRange: '',
      mergeBatch: false,
    },
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
    fileQueue: $('#fileQueue'),
    addMoreBtn: $('#addMoreBtn'),
    convertBtn: $('#convertBtn'),
    retryFailedBtn: $('#retryFailedBtn'),
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
    fileSwitcher: $('#fileSwitcher'),
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
    downloadAllBtn: $('#downloadAllBtn'),
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

    settingsBtn: $('#settingsBtn'),
    settingsDrawer: $('#settingsDrawer'),
    settingsBackdrop: $('#settingsBackdrop'),
    settingsClose: $('#settingsClose'),
    settingsResetBtn: $('#settingsResetBtn'),
    settingOcr: $('#settingOcr'),
    settingOcrLang: $('#settingOcrLang'),
    ocrLangRow: $('#ocrLangRow'),
    settingStripChrome: $('#settingStripChrome'),
    settingPageBreaks: $('#settingPageBreaks'),
    settingHeadingSensitivity: $('#settingHeadingSensitivity'),
    settingPageRange: $('#settingPageRange'),
    settingMerge: $('#settingMerge'),

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
    /**
     * Parse a page-range string like "1-10, 15, 20-22" into a sorted, deduped
     * array of 1-based page numbers clamped to [1, maxPages]. An empty/blank
     * string means "all pages" and returns null so callers can distinguish
     * "no filter" from "an explicit range".
     */
    parsePageRange(str, maxPages) {
      if (!str || !str.trim()) return null;
      const pages = new Set();
      for (let part of str.split(',')) {
        part = part.trim();
        if (!part) continue;
        const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          let a = parseInt(rangeMatch[1], 10), b = parseInt(rangeMatch[2], 10);
          if (a > b) [a, b] = [b, a];
          for (let p = a; p <= b; p++) if (p >= 1 && p <= maxPages) pages.add(p);
        } else if (/^\d+$/.test(part)) {
          const p = parseInt(part, 10);
          if (p >= 1 && p <= maxPages) pages.add(p);
        }
      }
      const result = [...pages].sort((a, b) => a - b);
      return result.length ? result : null;
    },
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
    markdownToPlainText(markdown) {
      return markdown
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^>\s?/gm, '')
        .replace(/^\|.*\|$/gm, (l) => l.replace(/\|/g, '').trim())
        .replace(/^---$/gm, '');
    },
    downloadBlob(content, filename, type) {
      const blob = new Blob([content], { type });
      saveAs(blob, filename);
    },
    confidenceBadgeHtml(confidence) {
      if (!confidence) return '';
      const labelText = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence — check formatting' };
      const display = { high: 'High', medium: 'Medium', low: 'Low' };
      return `<span class="confidence-badge confidence-badge--${confidence.label}" title="${Utils.escapeHtml(labelText[confidence.label] || '')}${confidence.ocrPages ? ` · ${confidence.ocrPages} page${confidence.ocrPages === 1 ? '' : 's'} used OCR` : ''}">${display[confidence.label] || confidence.label}</span>`;
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
  function showToast(msg, actionLabel, actionFn) {
    el.toast.innerHTML = '';
    el.toast.appendChild(document.createTextNode(msg));
    if (actionLabel && actionFn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => { actionFn(); el.toast.hidden = true; clearTimeout(toastTimer); });
      el.toast.appendChild(btn);
    }
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, actionLabel ? 5000 : 2600);
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
    clear() {
      this._lastCleared = this.load();
      localStorage.removeItem(CONFIG.RECENT_STORE_KEY);
    },
    undoClear() {
      if (!this._lastCleared || !this._lastCleared.length) return false;
      try {
        localStorage.setItem(CONFIG.RECENT_STORE_KEY, JSON.stringify(this._lastCleared));
        this._lastCleared = null;
        return true;
      } catch { return false; }
    },
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
            const id = App.nextId();
            App.results[id] = { id, name: item.name, pages: item.pages, size: item.size, markdown: item.markdown, docStats: null };
            App.showWorkspace();
            App.selectFile(id);
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
  el.clearRecentBtn.addEventListener('click', () => {
    RecentFiles.clear();
    RecentFiles.render();
    showToast('History cleared', 'Undo', () => { RecentFiles.undoClear(); RecentFiles.render(); });
  });

  /* ---------------------------------------------------------
     5b. SETTINGS (localStorage-backed conversion options)
  --------------------------------------------------------- */
  const Settings = {
    current: { ...CONFIG.DEFAULT_SETTINGS },
    load() {
      try {
        const saved = JSON.parse(localStorage.getItem(CONFIG.SETTINGS_STORE_KEY));
        this.current = { ...CONFIG.DEFAULT_SETTINGS, ...(saved || {}) };
      } catch { this.current = { ...CONFIG.DEFAULT_SETTINGS }; }
      this.applyToForm();
      return this.current;
    },
    save() {
      try { localStorage.setItem(CONFIG.SETTINGS_STORE_KEY, JSON.stringify(this.current)); }
      catch { /* storage full — settings just won't persist */ }
    },
    applyToForm() {
      el.settingOcr.checked = this.current.ocrEnabled;
      el.settingOcrLang.value = this.current.ocrLanguage;
      el.ocrLangRow.style.display = this.current.ocrEnabled ? '' : 'none';
      el.settingStripChrome.checked = this.current.stripHeaderFooter;
      el.settingPageBreaks.checked = this.current.includePageBreaks;
      el.settingHeadingSensitivity.value = this.current.headingSensitivity;
      el.settingPageRange.value = this.current.pageRange;
      el.settingMerge.checked = this.current.mergeBatch;
    },
    readFromForm() {
      this.current = {
        ocrEnabled: el.settingOcr.checked,
        ocrLanguage: el.settingOcrLang.value,
        stripHeaderFooter: el.settingStripChrome.checked,
        includePageBreaks: el.settingPageBreaks.checked,
        headingSensitivity: el.settingHeadingSensitivity.value,
        pageRange: el.settingPageRange.value.trim(),
        mergeBatch: el.settingMerge.checked,
      };
      this.save();
    },
    reset() {
      this.current = { ...CONFIG.DEFAULT_SETTINGS };
      this.applyToForm();
      this.save();
    },
    bind() {
      this.load();
      [el.settingOcr, el.settingOcrLang, el.settingStripChrome, el.settingPageBreaks, el.settingHeadingSensitivity, el.settingMerge]
        .forEach((input) => input.addEventListener('change', () => {
          this.readFromForm();
          el.ocrLangRow.style.display = this.current.ocrEnabled ? '' : 'none';
        }));
      el.settingPageRange.addEventListener('input', Utils.debounce(() => this.readFromForm(), 250));
      el.settingsResetBtn.addEventListener('click', () => { this.reset(); showToast('Settings reset to defaults'); });

      el.settingsBtn.addEventListener('click', () => { el.settingsDrawer.hidden = false; });
      el.settingsClose.addEventListener('click', () => { el.settingsDrawer.hidden = true; });
      el.settingsBackdrop.addEventListener('click', () => { el.settingsDrawer.hidden = true; });
    },
  };

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

    /** A page with next to no extractable text is almost certainly a scan/photo. */
    needsOcr(pageData) {
      const totalChars = pageData.items.reduce((sum, it) => sum + it.text.trim().length, 0);
      return totalChars < CONFIG.OCR_MIN_CHARS;
    },

    /** Render a page to an offscreen canvas and recognize its text with Tesseract.js. */
    async ocrPage(pdfDoc, pageNum, worker) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: CONFIG.OCR_RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
        const { data } = await worker.recognize(canvas);
        return (data && data.text) ? data.text.trim() : '';
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
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
    computeGlobalStats(pagesData, headingMultiplier) {
      const multiplier = headingMultiplier || 1.12;
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
        .filter((s) => s > bodySize * multiplier)
        .sort((a, b) => b - a)
        .slice(0, 4);

      return { bodySize, headingSizes, headingMultiplier: multiplier };
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

      if (stats.headingSizes.length && line.text.fontSize > stats.bodySize * (stats.headingMultiplier || 1.12)) {
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
     * Markdown string, reporting progress via onProgress(done, total, phase).
     * `settings` controls OCR, header/footer stripping, page-break markers,
     * heading sensitivity, and an optional page-range filter. `ocrWorker` is
     * a ready Tesseract.js worker, or null if OCR is off.
     */
    async convert(pdfDoc, onProgress, settings, ocrWorker) {
      settings = settings || CONFIG.DEFAULT_SETTINGS;
      const capped = Math.min(pdfDoc.numPages, CONFIG.MAX_PAGES);
      const pageNumbers = Utils.parsePageRange(settings.pageRange, pdfDoc.numPages)
        ? Utils.parsePageRange(settings.pageRange, pdfDoc.numPages).filter((p) => p <= CONFIG.MAX_PAGES)
        : Array.from({ length: capped }, (_, i) => i + 1);

      const pagesData = [];
      for (let i = 0; i < pageNumbers.length; i++) {
        const pageData = await this.extractPage(pdfDoc, pageNumbers[i]);
        pagesData.push(pageData);
        onProgress(i + 1, pageNumbers.length, 'reading');
        if (i % CONFIG.YIELD_EVERY_N_PAGES === 0) await Utils.yieldToBrowser();
      }

      // OCR pass: pages with (almost) no extractable text are treated as
      // scanned images. Only runs if OCR is enabled and a worker was handed
      // to us — this can be slow, so it's opt-in.
      let ocrPagesUsed = 0;
      if (settings.ocrEnabled && ocrWorker) {
        const candidates = pagesData.filter((p) => this.needsOcr(p));
        for (let i = 0; i < candidates.length; i++) {
          const page = candidates[i];
          onProgress(i + 1, candidates.length, 'ocr');
          try {
            page.ocrText = await this.ocrPage(pdfDoc, page.pageNum, ocrWorker);
            if (page.ocrText) ocrPagesUsed++;
          } catch { /* OCR failed for this page — it just stays empty */ }
          await Utils.yieldToBrowser();
        }
      }

      const stats = this.computeGlobalStats(pagesData, CONFIG.HEADING_MULTIPLIERS[settings.headingSensitivity] || 1.12);

      const pagesLines = pagesData.map((page) => {
        const rawLines = this.groupIntoLines(page.items);
        const ordered = this.resolveColumns(rawLines, page.width);
        return ordered.map((l) => ({ y: l.y, items: l.items, text: this.buildLineText(l) }));
      });

      const chromeSet = settings.stripHeaderFooter
        ? this.detectRepeatedChrome(pagesLines, pagesData.map((p) => p.height))
        : new Set();

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
          if (settings.includePageBreaks) {
            md.push(`<!-- Page ${page.pageNum} -->`);
            md.push('');
          }
        }

        // OCR'd pages have no positioned text to build lines from — their
        // recognized text is dropped straight in as paragraphs instead.
        if (page.ocrText) {
          flushAll();
          md.push('<!-- OCR text — recognized automatically, may contain errors -->');
          md.push('');
          const ocrParagraphs = page.ocrText.split(/\n\s*\n/).map((p) => Utils.normalizeSpace(p)).filter(Boolean);
          for (const para of ocrParagraphs) { md.push(Utils.escapeMdInline(para)); md.push(''); }
          onProgress(pi + 1, pagesLines.length, 'structuring');
          continue;
        }

        for (const line of lines) {
          if (settings.stripHeaderFooter && this.isChromeLine(line, chromeSet, page.height)) continue;

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

      // A rough, honest signal for how much to trust the structure detection:
      // docs with no distinct heading sizes (flat typography) and docs that
      // leaned heavily on OCR are inherently harder to parse reliably.
      let confidenceScore = 100;
      if (stats.headingSizes.length === 0) confidenceScore -= 15;
      if (pagesData.length) confidenceScore -= Math.round((ocrPagesUsed / pagesData.length) * 60);
      confidenceScore = Utils.clamp(confidenceScore, 0, 100);
      const confidenceLabel = confidenceScore >= 75 ? 'high' : confidenceScore >= 40 ? 'medium' : 'low';

      // Collapse 3+ blank lines to a max of 2, trim trailing whitespace.
      let result = md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      return {
        markdown: result,
        docStats,
        totalPages: pagesData.length,
        confidence: { score: confidenceScore, label: confidenceLabel, ocrPages: ocrPagesUsed },
      };
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
     6b. OCR (lazy-loaded Tesseract.js)
  --------------------------------------------------------- */
  let tesseractLoadPromise = null;
  function loadTesseractScript() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoadPromise) return tesseractLoadPromise;
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CONFIG.TESSERACT_SRC;
      script.onload = () => resolve();
      script.onerror = () => { tesseractLoadPromise = null; reject(new FriendlyError('OCR unavailable', "Couldn't load the OCR library — check your connection and try again.")); };
      document.head.appendChild(script);
    });
    return tesseractLoadPromise;
  }
  const OcrManager = {
    worker: null,
    async getWorker(lang) {
      await loadTesseractScript();
      if (this.worker && this.workerLang === lang) return this.worker;
      if (this.worker) { try { await this.worker.terminate(); } catch { /* noop */ } }
      this.worker = await Tesseract.createWorker(lang);
      this.workerLang = lang;
      return this.worker;
    },
    async terminate() {
      if (this.worker) { try { await this.worker.terminate(); } catch { /* noop */ } this.worker = null; }
    },
  };

  /* ---------------------------------------------------------
     7. UI CONTROLLER
  --------------------------------------------------------- */
  const App = {
    queue: [],       // [{ id, file, status: 'queued'|'converting'|'done'|'error', errorMsg }]
    results: {},     // id -> { id, name, pages, size, markdown, docStats }
    activeId: null,  // id of the result currently shown in the workspace
    markdown: '',    // mirrors results[activeId].markdown for the copy/download/search handlers
    converting: false,
    _idCounter: 0,

    init() {
      ThemeManager.init();
      Settings.bind();
      this.bindUpload();
      this.bindWorkspace();
      this.bindShortcuts();
      this.restoreDraft();
      this.registerServiceWorker();
    },

    nextId() { return `f${Date.now()}_${this._idCounter++}`; },

    registerServiceWorker() {
      if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline support just won't be available */ });
      });
    },

    bindUpload() {
      el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
      el.addMoreBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
      el.dropZone.addEventListener('click', (e) => {
        if (e.target.closest('#browseBtn') || e.target.closest('#addMoreBtn')) return;
        if (!this.queue.length && e.target.closest('#dropIdleState')) el.fileInput.click();
      });
      el.dropZone.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !this.queue.length) { e.preventDefault(); el.fileInput.click(); }
      });

      el.fileInput.addEventListener('change', () => {
        if (el.fileInput.files.length) this.addFiles(el.fileInput.files);
        el.fileInput.value = '';
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
        if (e.dataTransfer.files && e.dataTransfer.files.length) this.addFiles(e.dataTransfer.files);
      });

      el.convertBtn.addEventListener('click', () => this.startConversion());
      el.retryFailedBtn.addEventListener('click', () => this.startConversion());
      el.clearBtn.addEventListener('click', () => this.reset());
    },

    /** Validate and enqueue one or more picked/dropped files. */
    addFiles(fileList) {
      hideError();
      let added = 0, skipped = 0;
      for (const file of fileList) {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdf) { skipped++; continue; }
        const alreadyQueued = this.queue.some((q) => q.file.name === file.name && q.file.size === file.size);
        if (alreadyQueued) { skipped++; continue; }
        if (file.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
          showError('File too large', `"${file.name}" is ${Utils.formatBytes(file.size)}. Folio works best under ${CONFIG.MAX_FILE_MB}MB — very large files may freeze your browser tab.`);
        }
        this.queue.push({ id: this.nextId(), file, status: 'queued', errorMsg: '' });
        added++;
      }
      if (added) {
        el.dropIdleState.hidden = true;
        el.dropFileState.hidden = false;
        this.renderQueue();
      }
      if (skipped && !added) showToast(skipped === 1 ? 'That file is already in the list' : 'Those files are already in the list, or not PDFs');
    },

    removeFromQueue(id) {
      this.queue = this.queue.filter((q) => q.id !== id);
      delete this.results[id];
      if (!this.queue.length) { this.reset(); return; }
      this.renderQueue();
    },

    renderQueue() {
      const pendingCount = this.queue.filter((q) => q.status !== 'done').length || this.queue.length;
      el.convertBtn.textContent = `Convert all (${pendingCount})`;
      const hasFailed = this.queue.some((q) => q.status === 'error');
      el.retryFailedBtn.hidden = !hasFailed || this.converting;

      el.fileQueue.innerHTML = this.queue.map((q) => {
        const result = this.results[q.id];
        const meta = `${Utils.formatBytes(q.file.size)}${result ? ' · ' + result.pages + ' pages' : ''}`;
        let statusHtml;
        if (q.status === 'queued') statusHtml = `<span class="queue-item__status">Queued</span>`;
        else if (q.status === 'converting') statusHtml = `<span class="queue-item__status is-converting" data-role="status">Converting…</span>`;
        else if (q.status === 'done') {
          const badge = result && result.confidence ? Utils.confidenceBadgeHtml(result.confidence) : '';
          statusHtml = `<span class="queue-item__status is-done" data-role="view" data-id="${q.id}">View</span>${badge}`;
        } else statusHtml = `<span class="queue-item__status is-error" title="${Utils.escapeHtml(q.errorMsg || '')}">Failed</span>`;
        return `
          <div class="queue-item" data-id="${q.id}" draggable="true">
            <span class="queue-item__icon" aria-hidden="true">
              <svg viewBox="0 0 40 40" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 4h16l6 6v26H9Z" stroke-linejoin="round"/><path d="M25 4v6h6" stroke-linejoin="round"/></svg>
            </span>
            <span class="queue-item__info">
              <span class="queue-item__name">${Utils.escapeHtml(q.file.name)}</span>
              <span class="queue-item__meta">${meta}</span>
            </span>
            ${statusHtml}
            <button type="button" class="queue-item__remove" data-remove="${q.id}" aria-label="Remove ${Utils.escapeHtml(q.file.name)}" ${q.status === 'converting' ? 'disabled' : ''}>&times;</button>
          </div>`;
      }).join('');

      el.fileQueue.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.removeFromQueue(btn.dataset.remove); });
      });
      el.fileQueue.querySelectorAll('[data-role="view"]').forEach((badge) => {
        badge.addEventListener('click', (e) => { e.stopPropagation(); this.showWorkspace(); this.selectFile(badge.dataset.id); });
      });
      this.bindQueueDragAndDrop();
    },

    /** Native HTML5 drag-and-drop reordering of the file queue. */
    bindQueueDragAndDrop() {
      let draggedId = null;
      const items = el.fileQueue.querySelectorAll('.queue-item');
      items.forEach((item) => {
        item.addEventListener('dragstart', (e) => {
          draggedId = item.dataset.id;
          item.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => {
          item.classList.remove('is-dragging');
          items.forEach((i) => i.classList.remove('is-drag-over'));
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (item.dataset.id !== draggedId) item.classList.add('is-drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('is-drag-over'));
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          item.classList.remove('is-drag-over');
          const targetId = item.dataset.id;
          if (!draggedId || draggedId === targetId) return;
          const fromIdx = this.queue.findIndex((q) => q.id === draggedId);
          const toIdx = this.queue.findIndex((q) => q.id === targetId);
          if (fromIdx === -1 || toIdx === -1) return;
          const [moved] = this.queue.splice(fromIdx, 1);
          this.queue.splice(toIdx, 0, moved);
          this.renderQueue();
        });
      });
    },

    setQueueItemStatus(id, status, errorMsg) {
      const q = this.queue.find((x) => x.id === id);
      if (!q) return;
      q.status = status;
      if (errorMsg) q.errorMsg = errorMsg;
      this.renderQueue();
    },

    reset() {
      this.queue = [];
      this.results = {};
      this.activeId = null;
      this.markdown = '';
      el.fileInput.value = '';
      el.dropIdleState.hidden = false;
      el.dropFileState.hidden = true;
      el.progressBlock.hidden = true;
      el.workspace.hidden = true;
      hideError();
      localStorage.removeItem(CONFIG.DRAFT_STORE_KEY);
      OcrManager.terminate();
    },

    async startConversion() {
      const pending = this.queue.filter((q) => q.status === 'queued' || q.status === 'error');
      if (!pending.length || this.converting) return;
      this.converting = true;
      hideError();
      el.workspace.hidden = true;
      el.progressBlock.hidden = false;
      el.convertBtn.disabled = true;
      el.retryFailedBtn.hidden = true;

      const settings = Settings.current;
      let ocrWorker = null;
      if (settings.ocrEnabled) {
        try {
          el.progressLabel.textContent = 'Loading OCR engine…';
          el.progressFill.style.width = '2%';
          ocrWorker = await OcrManager.getWorker(settings.ocrLanguage);
        } catch (err) {
          this.reportConversionError(err);
          ocrWorker = null; // conversion still proceeds — just without OCR
        }
      }

      for (let i = 0; i < pending.length; i++) {
        const q = pending[i];
        this.setQueueItemStatus(q.id, 'converting');
        const filePrefix = pending.length > 1 ? `File ${i + 1} of ${pending.length} — ${q.file.name}: ` : '';

        try {
          const buffer = await q.file.arrayBuffer();
          const pdfDoc = await PdfEngine.loadDocument(buffer);

          if (pdfDoc.numPages > CONFIG.MAX_PAGES) {
            el.progressStamps.textContent = `"${q.file.name}" has ${pdfDoc.numPages} pages — converting the first ${CONFIG.MAX_PAGES}.`;
          }

          const onProgress = (done, total, phase) => {
            const shares = { reading: 0.5, ocr: 0.25, structuring: 0.25 };
            const order = ['reading', 'ocr', 'structuring'];
            const base = order.slice(0, order.indexOf(phase)).reduce((s, p) => s + shares[p], 0);
            const pct = Math.round((base + (done / total) * shares[phase]) * 100);
            el.progressFill.style.width = `${pct}%`;
            el.progressPct.textContent = `${pct}%`;
            const phaseLabel = phase === 'reading' ? `Reading page ${done} of ${total}…`
              : phase === 'ocr' ? `Running OCR on scanned page ${done} of ${total}…`
              : `Detecting structure — page ${done} of ${total}…`;
            el.progressLabel.textContent = `${filePrefix}${phaseLabel}`;
          };

          const { markdown, docStats, totalPages, confidence } = await PdfEngine.convert(pdfDoc, onProgress, settings, ocrWorker);

          this.results[q.id] = { id: q.id, name: q.file.name, pages: totalPages, size: q.file.size, markdown, docStats, confidence };
          this.setQueueItemStatus(q.id, 'done');

          RecentFiles.save({
            name: q.file.name,
            size: q.file.size,
            pages: totalPages,
            date: Date.now(),
            markdown: markdown.length < 500000 ? markdown : null,
          });
        } catch (err) {
          this.setQueueItemStatus(q.id, 'error', (err && (err.friendlyDetail || err.message)) || 'Conversion failed.');
          this.reportConversionError(err, q.file.name);
        }
      }

      el.progressFill.style.width = '100%';
      el.progressPct.textContent = '100%';
      el.progressLabel.textContent = 'Done';
      this.converting = false;
      el.convertBtn.disabled = false;
      setTimeout(() => { el.progressBlock.hidden = true; }, 600);

      if (settings.mergeBatch) this.buildMergedDoc();

      const doneIds = Object.keys(this.results).filter((id) => id !== 'merged-batch');
      if (doneIds.length) {
        this.showWorkspace();
        this.selectFile(settings.mergeBatch && this.results['merged-batch'] ? 'merged-batch' : doneIds[doneIds.length - 1]);
      }
      this.renderQueue(); // refresh retry-failed visibility now that converting is false
    },

    /** Combine every converted file's Markdown (in queue order) into one extra pseudo-result. */
    buildMergedDoc() {
      const ordered = this.queue.filter((q) => this.results[q.id]);
      if (ordered.length < 2) return;
      const parts = ordered.map((q) => {
        const r = this.results[q.id];
        return `<!-- File: ${r.name} -->\n\n${r.markdown}`;
      });
      const merged = parts.join('\n\n---\n\n');
      const totalPages = ordered.reduce((sum, q) => sum + (this.results[q.id].pages || 0), 0);
      const totalSize = ordered.reduce((sum, q) => sum + (this.results[q.id].size || 0), 0);
      this.results['merged-batch'] = {
        id: 'merged-batch',
        name: `Merged (${ordered.length} files).md`,
        pages: totalPages,
        size: totalSize,
        markdown: merged,
        docStats: null,
        confidence: null,
        isMerged: true,
      };
    },

    reportConversionError(err, fileName) {
      const prefix = fileName ? `"${fileName}": ` : '';
      if (err && err.friendlyTitle) {
        showError(err.friendlyTitle, prefix + (err.friendlyDetail || ''));
        return;
      }
      const name = err && err.name;
      if (name === 'PasswordException') {
        showError('Password required', `${prefix}This PDF is protected and no password was provided, so it couldn't be opened.`);
      } else if (name === 'InvalidPDFException') {
        showError('Invalid PDF', `${prefix}This file doesn't look like a valid PDF — it may be corrupted or mislabeled.`);
      } else if (name === 'MissingPDFException') {
        showError('File not found', `${prefix}The file could not be read from disk.`);
      } else if (name === 'UnexpectedResponseException') {
        showError('Couldn\'t read file', `${prefix}The file could not be loaded. Try re-saving or re-exporting the PDF.`);
      } else if (err instanceof RangeError || /memory/i.test((err && err.message) || '')) {
        showError('Ran out of memory', `${prefix}This file is too large for your browser to process. Try a smaller file, or split the PDF first.`);
      } else {
        console.error(err);
        showError('Conversion failed', prefix + ((err && err.message) || 'An unexpected error occurred while converting this file.'));
      }
    },

    /** Build/refresh the tab strip for switching between converted files. */
    renderFileSwitcher() {
      const ids = Object.keys(this.results);
      if (ids.length < 2) { el.fileSwitcher.hidden = true; el.fileSwitcher.innerHTML = ''; return; }
      el.fileSwitcher.hidden = false;
      el.fileSwitcher.innerHTML = ids.map((id) => {
        const r = this.results[id];
        const active = id === this.activeId ? ' is-active' : '';
        const label = r.isMerged ? `📎 ${Utils.escapeHtml(r.name)}` : Utils.escapeHtml(r.name);
        return `<button type="button" class="file-switcher__tab${active}" data-id="${id}">${label} <span class="file-switcher__tab-meta">${r.pages}p</span></button>`;
      }).join('');
      el.fileSwitcher.querySelectorAll('.file-switcher__tab').forEach((tab) => {
        tab.addEventListener('click', () => this.selectFile(tab.dataset.id));
      });
    },

    showWorkspace() {
      el.workspace.hidden = false;
      el.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /** Load one converted result into the workspace panes/stats. */
    selectFile(id) {
      const result = this.results[id];
      if (!result) return;
      this.activeId = id;
      this.markdown = result.markdown;

      el.docTitle.textContent = result.name;
      const words = Utils.wordCount(result.markdown);
      const readMin = Math.max(1, Math.round(words / 200));
      const confidenceText = result.confidence ? ` · ${Utils.confidenceBadgeHtml(result.confidence)}` : '';
      el.docStats.innerHTML = `${result.pages} pages · ${words.toLocaleString()} words · ${readMin} min read${confidenceText}`;

      const docStats = result.docStats;
      el.statWords.textContent = words.toLocaleString();
      el.statChars.textContent = result.markdown.length.toLocaleString();
      el.statHeadings.textContent = (docStats ? docStats.headings : (result.markdown.match(/^#{1,4}\s/gm) || []).length).toLocaleString();
      el.statTables.textContent = (docStats ? docStats.tables : (result.markdown.match(/^\|.*\|$/gm) || []).length).toLocaleString();
      el.statLinks.textContent = (docStats ? docStats.links : (result.markdown.match(/\]\(https?:\/\//g) || []).length).toLocaleString();

      el.sourcePane.value = result.markdown;
      this.updatePreview();
      el.downloadAllBtn.hidden = Object.keys(this.results).filter((k) => k !== 'merged-batch').length < 2;
      this.renderFileSwitcher();
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
        if (this.activeId && this.results[this.activeId]) this.results[this.activeId].markdown = this.markdown;
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
        const base = Utils.slugTitle((this.results[this.activeId] && this.results[this.activeId].name) || 'document');
        Utils.downloadBlob(this.markdown, `${base}.md`, 'text/markdown;charset=utf-8');
      });
      el.downloadTxtBtn.addEventListener('click', () => {
        const base = Utils.slugTitle((this.results[this.activeId] && this.results[this.activeId].name) || 'document');
        Utils.downloadBlob(Utils.markdownToPlainText(this.markdown), `${base}.txt`, 'text/plain;charset=utf-8');
      });
      el.downloadAllBtn.addEventListener('click', () => this.downloadAllAsZip());

      el.searchInput.addEventListener('input', Utils.debounce(() => this.runSearch(), 200));
    },

    /** Bundle every converted file's Markdown into a single .zip download. */
    async downloadAllAsZip() {
      const ids = Object.keys(this.results).filter((id) => id !== 'merged-batch');
      if (!ids.length) return;
      if (typeof JSZip === 'undefined') { showToast('Zip library failed to load — check your connection'); return; }
      try {
        const zip = new JSZip();
        const usedNames = new Set();
        for (const id of ids) {
          const r = this.results[id];
          let base = Utils.slugTitle(r.name);
          let name = `${base}.md`;
          let n = 2;
          while (usedNames.has(name)) { name = `${base} (${n++}).md`; }
          usedNames.add(name);
          zip.file(name, r.markdown);
        }
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        saveAs(blob, `folio-markdown-${ids.length}-files.zip`);
        showToast(`Zipped ${ids.length} files`);
      } catch (err) {
        console.error(err);
        showToast('Could not build the zip file');
      }
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
        const r = this.results[this.activeId];
        if (!r) return;
        localStorage.setItem(CONFIG.DRAFT_STORE_KEY, JSON.stringify({
          name: r.name, pages: r.pages, size: r.size, markdown: r.markdown, docStats: r.docStats,
        }));
      } catch { /* storage full — skip autosave */ }
    },

    restoreDraft() {
      try {
        const draft = JSON.parse(localStorage.getItem(CONFIG.DRAFT_STORE_KEY));
        if (draft && draft.markdown) {
          const id = this.nextId();
          this.results[id] = { id, name: draft.name, pages: draft.pages, size: draft.size, markdown: draft.markdown, docStats: draft.docStats };
          this.showWorkspace();
          this.selectFile(id);
        }
      } catch { /* no draft */ }
    },

    bindShortcuts() {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea';

        if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); }
        else if (mod && e.key === 'Enter') { e.preventDefault(); if (this.queue.length) this.startConversion(); }
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
