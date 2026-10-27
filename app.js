/**
 * Manual Duplex PDF - Application Logic
 * Version: 1.01
 */

'use strict';

(function () {
  const APP_VERSION = '1.01';

  // Application State
  const state = {
    file: null,
    fileName: '',
    fileBytes: null,
    totalPages: 0,
    splits: null,
    partABusy: false,
    partBBusy: false,
    deferredInstallPrompt: null
  };

  // DOM Elements
  const elements = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    browseBtn: document.getElementById('browse-btn'),
    fileLoading: document.getElementById('file-loading'),
    fileLoadingText: document.getElementById('file-loading-text'),

    docInfoCard: document.getElementById('doc-info-card'),
    resetDocBtn: document.getElementById('reset-doc-btn'),
    infoFilename: document.getElementById('info-filename'),
    infoTotalPages: document.getElementById('info-total-pages'),
    infoPartACount: document.getElementById('info-part-a-count'),
    infoPartBCount: document.getElementById('info-part-b-count'),
    partASequence: document.getElementById('part-a-sequence'),
    partBSequence: document.getElementById('part-b-sequence'),

    downloadSection: document.getElementById('download-section'),
    downloadPartABtn: document.getElementById('download-part-a-btn'),
    downloadPartBBtn: document.getElementById('download-part-b-btn'),
    partAFilenamePreview: document.getElementById('part-a-filename-preview'),
    partBFilenamePreview: document.getElementById('part-b-filename-preview'),
    partABadge: document.getElementById('part-a-badge'),
    partBBadge: document.getElementById('part-b-badge'),
    partBDisabledReason: document.getElementById('part-b-disabled-reason'),

    statusBanner: document.getElementById('status-banner'),
    statusMessage: document.getElementById('status-message'),
    statusIcon: document.getElementById('status-icon'),
    statusCloseBtn: document.getElementById('status-close-btn'),
    updateBanner: document.getElementById('update-banner'),
    updateBtn: document.getElementById('update-btn'),
    forceCacheClearBtn: document.getElementById('force-cache-clear-btn'),
    networkBadge: document.getElementById('network-badge'),
    networkStatusText: document.getElementById('network-status-text'),
    installBtn: document.getElementById('install-btn'),
    appVersionBadge: document.getElementById('app-version-badge')
  };

  if (elements.appVersionBadge) {
    elements.appVersionBadge.textContent = `v${APP_VERSION}`;
  }

  // ==========================================================================
  // Resilient PDF Engine Loader (Multi-CDN + Local Failover)
  // ==========================================================================
  async function ensurePdfEngine() {
    if (window.PDFLib) return true;

    // Prioritize local file, then Cloudflare CDN (works across all ISPs)
    const sources = [
      './pdf-lib.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
      'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
      'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'
    ];

    for (const src of sources) {
      if (window.PDFLib) return true;
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.onload = () => resolve();
          script.onerror = () => reject();
          document.head.appendChild(script);
          setTimeout(() => reject(new Error('Timeout')), 4000);
        });
        if (window.PDFLib) return true;
      } catch {
        // Continue to next mirror
      }
    }
    return !!window.PDFLib;
  }

  // ==========================================================================
  // Core Page Splitting Algorithm
  // ==========================================================================
  function calculatePageSplits(totalPages) {
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new Error('Total pages must be a positive integer.');
    }

    // Part A: Odd-numbered pages ascending (1, 3, 5, ...) -> 0, 2, 4...
    const partAIndices = [];
    const partAPageNumbers = [];
    for (let p = 1; p <= totalPages; p += 2) {
      partAPageNumbers.push(p);
      partAIndices.push(p - 1);
    }

    // Part B: Even-numbered pages descending (e.g. 4, 2)
    const partBIndices = [];
    const partBPageNumbers = [];
    const maxEven = totalPages % 2 === 0 ? totalPages : totalPages - 1;
    for (let p = maxEven; p >= 2; p -= 2) {
      partBPageNumbers.push(p);
      partBIndices.push(p - 1);
    }

    return {
      partA: { indices: partAIndices, pageNumbers: partAPageNumbers, count: partAIndices.length },
      partB: { indices: partBIndices, pageNumbers: partBPageNumbers, count: partBIndices.length }
    };
  }

  async function createSubPdf(sourceBytes, indices) {
    const isReady = await ensurePdfEngine();
    if (!isReady) {
      throw new Error('PDF processing library could not be loaded. Please check your connection.');
    }
    if (!indices || indices.length === 0) {
      throw new Error('No pages available for this part.');
    }

    const srcDoc = await window.PDFLib.PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    const outDoc = await window.PDFLib.PDFDocument.create();
    const copiedPages = await outDoc.copyPages(srcDoc, indices);
    for (const page of copiedPages) {
      outDoc.addPage(page);
    }
    return await outDoc.save();
  }

  function sanitizeBaseName(originalName) {
    if (!originalName || typeof originalName !== 'string') return 'Document';
    let name = originalName.replace(/\.pdf$/i, '').trim();
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
    return name || 'Document';
  }

  function formatOutputFilename(originalName, partLetter) {
    const base = sanitizeBaseName(originalName);
    return `Part.${partLetter}.${base}.pdf`;
  }

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
  // UI Display & Alerts
  // ==========================================================================
  function showStatus(message, type = 'info') {
    elements.statusBanner.className = `status-banner banner-${type}`;
    elements.statusMessage.textContent = message;

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
    if (numbers.length <= 12) return numbers.join(', ');
    return `${numbers.slice(0, 8).join(', ')}, … (${numbers.length} pages total) … ${numbers.slice(-2).join(', ')}`;
  }

  function renderDocumentState() {
    if (!state.fileBytes || state.totalPages === 0 || !state.splits) {
      elements.docInfoCard.hidden = true;
      elements.downloadSection.hidden = true;
      elements.dropZone.hidden = false;
      return;
    }

    const { partA, partB } = state.splits;
    elements.infoFilename.textContent = state.fileName;
    elements.infoTotalPages.textContent = state.totalPages;
    elements.infoPartACount.textContent = `${partA.count} pages`;
    elements.infoPartBCount.textContent = `${partB.count} pages`;
    elements.partASequence.textContent = formatSequencePreview(partA.pageNumbers);
    elements.partBSequence.textContent = formatSequencePreview(partB.pageNumbers);

    elements.partAFilenamePreview.textContent = formatOutputFilename(state.fileName, 'A');
    elements.partABadge.textContent = `${partA.count} ${partA.count === 1 ? 'Page' : 'Pages'}`;

    elements.partBFilenamePreview.textContent = formatOutputFilename(state.fileName, 'B');
    elements.partBBadge.textContent = `${partB.count} ${partB.count === 1 ? 'Page' : 'Pages'}`;

    if (partB.count === 0) {
      elements.downloadPartBBtn.disabled = true;
      elements.partBDisabledReason.hidden = false;
    } else {
      elements.downloadPartBBtn.disabled = false;
      elements.partBDisabledReason.hidden = true;
    }

    elements.downloadPartABtn.disabled = false;
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
  // File Parsing
  // ==========================================================================
  async function processSelectedFile(file) {
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      showStatus('Invalid file format. Please select a valid PDF document (.pdf).', 'error');
      return;
    }

    hideStatus();
    elements.dropZone.hidden = true;
    elements.fileLoading.hidden = false;
    elements.fileLoadingText.textContent = `Connecting to PDF engine...`;

    try {
      const isReady = await ensurePdfEngine();
      if (!isReady) {
        throw new Error('The PDF processing engine could not be loaded. Please check your internet connection.');
      }

      elements.fileLoadingText.textContent = `Reading "${file.name}"...`;
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      let pdfDoc;
      try {
        pdfDoc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false });
      } catch (loadErr) {
        const errMsg = String(loadErr.message || loadErr);
        if (errMsg.toLowerCase().includes('encrypted') || errMsg.toLowerCase().includes('password')) {
          throw new Error('This PDF is password-protected or encrypted. Please remove password encryption before splitting.');
        } else {
          throw new Error('Unable to read this PDF. The file may be damaged or not a standard PDF.');
        }
      }

      const totalPages = pdfDoc.getPageCount();
      if (totalPages < 1) {
        throw new Error('This document contains no readable pages.');
      }

      state.file = file;
      state.fileName = file.name;
      state.fileBytes = bytes;
      state.totalPages = totalPages;
      state.splits = calculatePageSplits(totalPages);

      renderDocumentState();
      showStatus(`Analyzed "${file.name}" (${totalPages} total pages). Ready to download parts.`, 'success');
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
  // Event Listeners & Cache Clearing
  // ==========================================================================
  function initEventListeners() {
    elements.browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.fileInput.click();
    });

    elements.dropZone.addEventListener('click', () => elements.fileInput.click());

    elements.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        elements.fileInput.click();
      }
    });

    elements.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) processSelectedFile(file);
    });

    ['dragenter', 'dragover'].forEach((name) => {
      elements.dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.add('drag-active');
      });
    });

    ['dragleave', 'dragend'].forEach((name) => {
      elements.dropZone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.remove('drag-active');
      });
    });

    elements.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      elements.dropZone.classList.remove('drag-active');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        processSelectedFile(e.dataTransfer.files[0]);
      }
    });

    elements.resetDocBtn.addEventListener('click', resetApplication);
    elements.downloadPartABtn.addEventListener('click', handleDownloadPartA);
    elements.downloadPartBBtn.addEventListener('click', handleDownloadPartB);
    elements.statusCloseBtn.addEventListener('click', hideStatus);

    // Online / Offline Monitor
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

    // PWA Install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      elements.installBtn.hidden = false;
    });

    elements.installBtn.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      const choice = await state.deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        elements.installBtn.hidden = true;
      }
      state.deferredInstallPrompt = null;
    });

    // Force Cache Clear & Hard Reload Button
    elements.forceCacheClearBtn.addEventListener('click', async () => {
      if (confirm('This will purge all cached assets, reset the service worker, and refresh to the newest version. Continue?')) {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const reg of regs) await reg.unregister();
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const key of keys) await caches.delete(key);
        }
        window.location.reload(true);
      }
    });

    // Update banner action
    elements.updateBtn.addEventListener('click', () => {
      window.location.reload(true);
    });
  }

  // Service Worker Registration with Background Update Detection
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js', { scope: './' })
          .then((registration) => {
            registration.onupdatefound = () => {
              const installing = registration.installing;
              if (installing) {
                installing.onstatechange = () => {
                  if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    elements.updateBanner.hidden = false;
                  }
                };
              }
            };
          })
          .catch((err) => console.warn('Service worker registration failed:', err));
      });
    }
  }

  initEventListeners();
  registerServiceWorker();
})();
