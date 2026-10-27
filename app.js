/**
 * Manual Duplex PDF - Application Logic
 * Pure Vanilla JavaScript implementation with PDF-lib
 */

'use strict';

(function () {
  // ==========================================================================
  // Application State
  // ==========================================================================
  const state = {
    file: null,
    fileName: '',
    fileBytes: null,
    totalPages: 0,
    splits: null,
    isProcessing: false,
    partABusy: false,
    partBBusy: false,
    deferredInstallPrompt: null
  };

  // ==========================================================================
  // DOM Elements
  // ==========================================================================
  const elements = {
    // Drop Zone & Inputs
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    browseBtn: document.getElementById('browse-btn'),
    fileLoading: document.getElementById('file-loading'),
    fileLoadingText: document.getElementById('file-loading-text'),

    // Document Overview
    docInfoCard: document.getElementById('doc-info-card'),
    resetDocBtn: document.getElementById('reset-doc-btn'),
    infoFilename: document.getElementById('info-filename'),
    infoTotalPages: document.getElementById('info-total-pages'),
    infoPartACount: document.getElementById('info-part-a-count'),
    infoPartBCount: document.getElementById('info-part-b-count'),
    partASequence: document.getElementById('part-a-sequence'),
    partBSequence: document.getElementById('part-b-sequence'),

    // Download Cards
    downloadSection: document.getElementById('download-section'),
    downloadPartABtn: document.getElementById('download-part-a-btn'),
    downloadPartBBtn: document.getElementById('download-part-b-btn'),
    partAFilenamePreview: document.getElementById('part-a-filename-preview'),
    partBFilenamePreview: document.getElementById('part-b-filename-preview'),
    partABadge: document.getElementById('part-a-badge'),
    partBBadge: document.getElementById('part-b-badge'),
    partBDisabledReason: document.getElementById('part-b-disabled-reason'),

    // Alerts & Network
    statusBanner: document.getElementById('status-banner'),
    statusMessage: document.getElementById('status-message'),
    statusIcon: document.getElementById('status-icon'),
    statusCloseBtn: document.getElementById('status-close-btn'),
    networkBadge: document.getElementById('network-badge'),
    networkStatusText: document.getElementById('network-status-text'),
    installBtn: document.getElementById('install-btn')
  };

  // ==========================================================================
  // PDF Splitting Logic (Core Requirement)
  // ==========================================================================

  /**
   * Calculates the exact page indices and sequences for Part A and Part B.
   *
   * @param {number} totalPages - Total pages in the source PDF
   * @returns {{
   *   partA: { indices: number[], pageNumbers: number[], count: number },
   *   partB: { indices: number[], pageNumbers: number[], count: number }
   * }}
   */
  function calculatePageSplits(totalPages) {
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new Error('Total pages must be a positive integer.');
    }

    // Part A: Odd-numbered pages in ascending order (1, 3, 5, ...)
    // 0-based indices: 0, 2, 4, ...
    const partAIndices = [];
    const partAPageNumbers = [];
    for (let p = 1; p <= totalPages; p += 2) {
      partAPageNumbers.push(p);
      partAIndices.push(p - 1);
    }

    // Part B: Even-numbered pages in descending order (e.g. 4, 2 or 6, 4, 2)
    // 0-based indices: (maxEven - 1), (maxEven - 3), ... down to 1
    const partBIndices = [];
    const partBPageNumbers = [];
    const maxEvenPage = totalPages % 2 === 0 ? totalPages : totalPages - 1;
    for (let p = maxEvenPage; p >= 2; p -= 2) {
      partBPageNumbers.push(p);
      partBIndices.push(p - 1);
    }

    return {
      partA: {
        indices: partAIndices,
        pageNumbers: partAPageNumbers,
        count: partAIndices.length
      },
      partB: {
        indices: partBIndices,
        pageNumbers: partBPageNumbers,
        count: partBIndices.length
      }
    };
  }

  /**
   * Generates a new PDF containing only the requested page indices from the source.
   *
   * @param {Uint8Array} sourceBytes - Source PDF byte buffer
   * @param {number[]} indices - Array of 0-based page indices to copy
   * @returns {Promise<Uint8Array>} Generated PDF byte buffer
   */
  async function createSubPdf(sourceBytes, indices) {
    if (!window.PDFLib) {
      throw new Error('PDF processing library is not loaded. Please verify your connection.');
    }

    if (!indices || indices.length === 0) {
      throw new Error('No pages available for this output part.');
    }

    // Load the original document without altering it
    const srcDoc = await window.PDFLib.PDFDocument.load(sourceBytes, {
      ignoreEncryption: false
    });

    // Create a new blank PDF
    const outDoc = await window.PDFLib.PDFDocument.create();

    // Copy the selected pages (preserves dimensions, vector drawings, annotations, and orientations)
    const copiedPages = await outDoc.copyPages(srcDoc, indices);
    for (const page of copiedPages) {
      outDoc.addPage(page);
    }

    return await outDoc.save();
  }

  // ==========================================================================
  // Filename Sanitization & Formatting
  // ==========================================================================

  /**
   * Sanitizes a filename, strips the trailing .pdf, and prepares the base name.
   *
   * @param {string} originalName - e.g. "Science Project.pdf"
   * @returns {string} Sanitized base name e.g. "Science Project"
   */
  function sanitizeBaseName(originalName) {
    if (!originalName || typeof originalName !== 'string') {
      return 'Document';
    }

    // Strip case-insensitive .pdf extension
    let name = originalName.replace(/\.pdf$/i, '').trim();

    // Remove characters that are unsafe across operating systems (< > : " / \ | ? *)
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();

    return name || 'Document';
  }

  /**
   * Formats the exact output filename according to the specification.
   *
   * @param {string} originalName
   * @param {'A'|'B'} partLetter
   * @returns {string} e.g. "Part.A.Science Project.pdf"
   */
  function formatOutputFilename(originalName, partLetter) {
    const base = sanitizeBaseName(originalName);
    return `Part.${partLetter}.${base}.pdf`;
  }

  /**
   * Triggers a browser download using a temporary Blob URL and cleans up.
   *
   * @param {Uint8Array} pdfBytes
   * @param {string} filename
   */
  function triggerDownload(pdfBytes, filename) {
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = blobUrl;
    link.download = filename;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    }, 1500);
  }

  // ==========================================================================
  // UI Presentation & State Rendering
  // ==========================================================================

  function showStatus(message, type = 'info') {
    elements.statusBanner.className = `status-banner banner-${type}`;
    elements.statusMessage.textContent = message;

    // SVG icons based on alert type
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (type === 'error') {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
    } else {
      iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    }

    elements.statusIcon.innerHTML = iconSvg;
    elements.statusBanner.hidden = false;
  }

  function hideStatus() {
    elements.statusBanner.hidden = true;
    elements.statusMessage.textContent = '';
  }

  function formatSequencePreview(numbers) {
    if (!numbers || numbers.length === 0) return 'None';
    if (numbers.length <= 12) {
      return numbers.join(', ');
    }
    const head = numbers.slice(0, 8).join(', ');
    const tail = numbers.slice(-2).join(', ');
    return `${head}, … (${numbers.length} pages total) … ${tail}`;
  }

  function renderDocumentState() {
    if (!state.fileBytes || state.totalPages === 0 || !state.splits) {
      elements.docInfoCard.hidden = true;
      elements.downloadSection.hidden = true;
      elements.dropZone.hidden = false;
      return;
    }

    const { partA, partB } = state.splits;
    const filenameA = formatOutputFilename(state.fileName, 'A');
    const filenameB = formatOutputFilename(state.fileName, 'B');

    // Populate Overview
    elements.infoFilename.textContent = state.fileName;
    elements.infoTotalPages.textContent = state.totalPages;
    elements.infoPartACount.textContent = `${partA.count} pages`;
    elements.infoPartBCount.textContent = `${partB.count} pages`;
    elements.partASequence.textContent = formatSequencePreview(partA.pageNumbers);
    elements.partBSequence.textContent = formatSequencePreview(partB.pageNumbers);

    // Populate Part A Details
    elements.partAFilenamePreview.textContent = filenameA;
    elements.partABadge.textContent = `${partA.count} ${partA.count === 1 ? 'Page' : 'Pages'}`;

    // Populate Part B Details
    elements.partBFilenamePreview.textContent = filenameB;
    elements.partBBadge.textContent = `${partB.count} ${partB.count === 1 ? 'Page' : 'Pages'}`;

    // One-page PDF edge case handling
    if (partB.count === 0) {
      elements.downloadPartBBtn.disabled = true;
      elements.partBDisabledReason.hidden = false;
    } else {
      elements.downloadPartBBtn.disabled = false;
      elements.partBDisabledReason.hidden = true;
    }

    elements.downloadPartABtn.disabled = false;

    // Show cards
    elements.docInfoCard.hidden = false;
    elements.downloadSection.hidden = false;
    elements.dropZone.hidden = true;
  }

  function resetApplication() {
    state.file = null;
    state.fileName = '';
    state.fileBytes = null;
    state.totalPages = 0;
    state.splits = null;
    state.isProcessing = false;
    state.partABusy = false;
    state.partBBusy = false;

    elements.fileInput.value = '';
    elements.docInfoCard.hidden = true;
    elements.downloadSection.hidden = true;
    elements.dropZone.hidden = false;
    elements.fileLoading.hidden = true;
    hideStatus();
  }

  // ==========================================================================
  // File Ingestion & Parsing
  // ==========================================================================

  async function processSelectedFile(file) {
    if (!file) return;

    // Validation 1: MIME or Extension check
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      showStatus('Invalid file format. Please select a valid PDF document (.pdf).', 'error');
      return;
    }

    // Validation 2: Ensure PDF-lib is ready
    if (!window.PDFLib) {
      showStatus('The PDF processing engine has not finished loading. Please check your internet connection.', 'error');
      return;
    }

    hideStatus();
    elements.dropZone.hidden = true;
    elements.fileLoading.hidden = false;
    elements.fileLoadingText.textContent = `Reading "${file.name}"...`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Attempt to load the PDF structure
      let pdfDoc;
      try {
        pdfDoc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false });
      } catch (loadErr) {
        const errMsg = String(loadErr.message || loadErr);
        if (errMsg.toLowerCase().includes('encrypted') || errMsg.toLowerCase().includes('password')) {
          throw new Error('This PDF is password-protected or encrypted. Please remove encryption before splitting.');
        } else {
          throw new Error('Unable to read this PDF. The file may be damaged or not a valid PDF.');
        }
      }

      const totalPages = pdfDoc.getPageCount();
      if (totalPages < 1) {
        throw new Error('This document contains no readable pages.');
      }

      // Calculate the splits
      const splits = calculatePageSplits(totalPages);

      // Save to state
      state.file = file;
      state.fileName = file.name;
      state.fileBytes = bytes;
      state.totalPages = totalPages;
      state.splits = splits;

      renderDocumentState();
      showStatus(`Successfully analyzed "${file.name}" (${totalPages} total pages). Ready to download parts.`, 'success');
    } catch (err) {
      resetApplication();
      showStatus(err.message || 'An error occurred while loading the PDF document.', 'error');
    } finally {
      elements.fileLoading.hidden = true;
    }
  }

  // ==========================================================================
  // Download Handlers
  // ==========================================================================

  async function handleDownloadPartA() {
    if (!state.fileBytes || !state.splits || state.partABusy) return;

    const originalBtnHtml = elements.downloadPartABtn.innerHTML;
    state.partABusy = true;
    elements.downloadPartABtn.disabled = true;
    elements.downloadPartABtn.innerHTML = `
      <div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;" aria-hidden="true"></div>
      <span>Generating Part A...</span>
    `;

    try {
      const partAIndices = state.splits.partA.indices;
      const pdfBytes = await createSubPdf(state.fileBytes, partAIndices);
      const filename = formatOutputFilename(state.fileName, 'A');

      triggerDownload(pdfBytes, filename);
      showStatus(`Part A downloaded successfully as "${filename}".`, 'success');
    } catch (err) {
      showStatus(`Failed to generate Part A: ${err.message}`, 'error');
    } finally {
      state.partABusy = false;
      elements.downloadPartABtn.disabled = false;
      elements.downloadPartABtn.innerHTML = originalBtnHtml;
    }
  }

  async function handleDownloadPartB() {
    if (!state.fileBytes || !state.splits || state.partBBusy) return;

    if (state.splits.partB.count === 0) {
      showStatus('Part B cannot be generated for a single-page PDF.', 'warning');
      return;
    }

    const originalBtnHtml = elements.downloadPartBBtn.innerHTML;
    state.partBBusy = true;
    elements.downloadPartBBtn.disabled = true;
    elements.downloadPartBBtn.innerHTML = `
      <div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;" aria-hidden="true"></div>
      <span>Generating Part B...</span>
    `;

    try {
      const partBIndices = state.splits.partB.indices;
      const pdfBytes = await createSubPdf(state.fileBytes, partBIndices);
      const filename = formatOutputFilename(state.fileName, 'B');

      triggerDownload(pdfBytes, filename);
      showStatus(`Part B downloaded successfully as "${filename}".`, 'success');
    } catch (err) {
      showStatus(`Failed to generate Part B: ${err.message}`, 'error');
    } finally {
      state.partBBusy = false;
      elements.downloadPartBBtn.disabled = false;
      elements.downloadPartBBtn.innerHTML = originalBtnHtml;
    }
  }

  // ==========================================================================
  // Event Listeners & Drag and Drop Setup
  // ==========================================================================

  function initEventListeners() {
    // File browse click
    elements.browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.fileInput.click();
    });

    elements.dropZone.addEventListener('click', () => {
      elements.fileInput.click();
    });

    elements.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        elements.fileInput.click();
      }
    });

    // File input change
    elements.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        processSelectedFile(file);
      }
    });

    // Drag and Drop handling
    ['dragenter', 'dragover'].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.add('drag-active');
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.remove('drag-active');
      });
    });

    elements.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      elements.dropZone.classList.remove('drag-active');

      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        processSelectedFile(dt.files[0]);
      }
    });

    // Clear document
    elements.resetDocBtn.addEventListener('click', () => {
      resetApplication();
    });

    // Download buttons
    elements.downloadPartABtn.addEventListener('click', handleDownloadPartA);
    elements.downloadPartBBtn.addEventListener('click', handleDownloadPartB);

    // Dismiss status alert
    elements.statusCloseBtn.addEventListener('click', hideStatus);

    // Online / Offline monitor
    function updateNetworkStatus() {
      if (navigator.onLine) {
        elements.networkBadge.className = 'badge badge-online';
        elements.networkStatusText.textContent = 'Online';
      } else {
        elements.networkBadge.className = 'badge badge-offline';
        elements.networkStatusText.textContent = 'Offline Ready';
      }
    }

    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();

    // PWA Install prompt handling
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      elements.installBtn.hidden = false;
    });

    elements.installBtn.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      const choiceResult = await state.deferredInstallPrompt.userChoice;
      if (choiceResult.outcome === 'accepted') {
        elements.installBtn.hidden = true;
      }
      state.deferredInstallPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      elements.installBtn.hidden = true;
      state.deferredInstallPrompt = null;
      showStatus('Manual Duplex PDF was installed successfully!', 'success');
    });
  }

  // ==========================================================================
  // Service Worker Registration
  // ==========================================================================

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        // Use relative path './service-worker.js' so it works on GitHub Pages sub-directories
        navigator.serviceWorker
          .register('./service-worker.js', { scope: './' })
          .then((registration) => {
            // Check for service worker updates periodically
            registration.onupdatefound = () => {
              const installingWorker = registration.installing;
              if (installingWorker) {
                installingWorker.onstatechange = () => {
                  if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    showStatus('New version available. Refresh the page to update.', 'info');
                  }
                };
              }
            };
          })
          .catch((err) => {
            console.warn('Service worker registration skipped or unsupported:', err);
          });
      });
    }
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================
  initEventListeners();
  registerServiceWorker();

  // Expose algorithm for automated testing / console validation
  window.__ManualDuplexPDF = {
    calculatePageSplits,
    sanitizeBaseName,
    formatOutputFilename
  };
})();