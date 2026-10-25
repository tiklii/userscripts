// ==UserScript==
// @name         ReadOmni Chapters ZIP & EPUB Downloader
// @namespace    https://github.com/tiklii/userscripts
// @version      39
// @description  Download chapters from readomni
// @author       tiklii
// @match        https://app.readomni.com/*
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.26/dist/zip.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STATE_KEY = 'ro_bulk_v23_state';
    const LOCK_KEY = 'ro_v23_active_tab_lock';
    const PREF_GLOSSARY_KEY = 'ro_include_glossary_opt';
    const IDB_NAME = 'ro_app_db';
    const STORE_GLOSSARY = 'glossary_cache';
    const STORE_CHAPTERS = 'chapters_cache';
    let isPreparing = false;

    if (typeof zip !== 'undefined') {
        zip.configure({ useWebWorkers: false });
    }

    // --- LOGGING SYSTEM ---
    function logDebug(stateObj, msg) {
        const time = new Date().toISOString().split('T')[1].slice(0, -1);
        const formatted = `[${time}] ${msg}`;
        console.log(formatted);
        if (stateObj && stateObj.logs) {
            stateObj.logs.push(formatted);
            try { localStorage.setItem(STATE_KEY, JSON.stringify(stateObj)); } catch (e) { }
        }
    }

    // --- HELPER FUNCTIONS ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function isCancelled() {
        const stateStr = localStorage.getItem(STATE_KEY);
        if (!stateStr) return true;
        try {
            const state = JSON.parse(stateStr);
            return !state.active;
        } catch (e) {
            return true;
        }
    }

    async function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const endTime = Date.now() + timeout;
            const check = () => {
                const elements = Array.from(document.querySelectorAll(selector));
                const el = elements.find(e => !e.closest('[inert]')) || elements[0];
                if (el) resolve(el);
                else if (Date.now() > endTime) resolve(null);
                else setTimeout(check, 100);
            };
                check();
        });
    }

    function omniClick(element) {
        if (!element) return;
        try {
            if (typeof element.click === 'function') {
                element.click();
                return;
            }
        } catch (e) { }
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function escapeXml(unsafe) {
        return unsafe.replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    function getBookTitle() {
        const threadH1 = document.querySelector('h1');
        return threadH1 && threadH1.textContent ? threadH1.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '_') : 'ReadOmni_Book';
    }

    function getChapterLinksFromPage() {
        const allLinks = Array.from(document.querySelectorAll('a[href*="/translation/"]'));
        return allLinks.filter(l => {
            if (l.closest('aside')) return false;
            if (l.textContent.includes('Continue reading')) return false;
            return Boolean(l.href && l.href.includes('/translation/'));
        });
    }

    function extractChapterTitle(linkEl) {
        const truncateSpan = linkEl.querySelector('span.truncate, [class*="truncate"]');
        if (truncateSpan && truncateSpan.textContent.trim()) return truncateSpan.textContent.trim();

        const p = linkEl.querySelector('p');
        if (p && p.textContent.trim()) return p.textContent.trim();

        const h3 = linkEl.querySelector('h3');
        if (h3 && h3.textContent.trim()) return h3.textContent.trim();

        const clone = linkEl.cloneNode(true);
        clone.querySelectorAll('.tabular-nums, svg, button').forEach(el => el.remove());
        return clone.textContent.trim() || 'Untitled Chapter';
    }

    // --- INDEXEDDB STORAGE (CHAPTERS & GLOSSARY) ---
    function openAppDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 2);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_GLOSSARY)) {
                    db.createObjectStore(STORE_GLOSSARY);
                }
                if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
                    db.createObjectStore(STORE_CHAPTERS);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function appendChapter(runId, chapterObj) {
        try {
            const db = await openAppDB();
            const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
            const store = tx.objectStore(STORE_CHAPTERS);
            const req = store.get(runId);
            req.onsuccess = () => {
                const list = req.result || [];
                list.push(chapterObj);
                store.put(list, runId);
            };
            return new Promise(resolve => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch (e) {
            console.error("IndexedDB append chapter error:", e);
            return false;
        }
    }

    async function loadChapters(runId) {
        try {
            const db = await openAppDB();
            const tx = db.transaction(STORE_CHAPTERS, 'readonly');
            const req = tx.objectStore(STORE_CHAPTERS).get(runId);
            return new Promise(resolve => {
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        } catch (e) {
            console.error("IndexedDB load chapters error:", e);
            return [];
        }
    }

    async function saveGlossaryFiles(runId, files) {
        try {
            const db = await openAppDB();
            const tx = db.transaction(STORE_GLOSSARY, 'readwrite');
            tx.objectStore(STORE_GLOSSARY).put(files, runId);
            return new Promise(resolve => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
            });
        } catch (e) {
            console.error("IndexedDB save glossary error:", e);
            return false;
        }
    }

    async function loadGlossaryFiles(runId) {
        try {
            const db = await openAppDB();
            const tx = db.transaction(STORE_GLOSSARY, 'readonly');
            const req = tx.objectStore(STORE_GLOSSARY).get(runId);
            return new Promise(resolve => {
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            });
        } catch (e) {
            console.error("IndexedDB load glossary error:", e);
            return [];
        }
    }

    async function clearRunData(runId) {
        try {
            const db = await openAppDB();
            const tx = db.transaction([STORE_CHAPTERS, STORE_GLOSSARY], 'readwrite');
            tx.objectStore(STORE_CHAPTERS).delete(runId);
            tx.objectStore(STORE_GLOSSARY).delete(runId);
        } catch (e) { }
    }

    // --- GLOSSARY EXPORT INTERCEPTOR (DESKTOP & MOBILE COMPATIBLE) ---
    async function exportGlossary(threadName, runId) {
        try {
            let capturedDownloads = [];
            let capturedBlobs = new Map();
            let capturedClipboard = null;
            let seenDownloadNames = new Set();
            let isExporting = true;

            const origCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function (blob) {
                const url = origCreateObjectURL.apply(this, arguments);
                if (isExporting && blob) {
                    capturedBlobs.set(url, blob);
                }
                return url;
            };

            const origAnchorClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                const downloadAttr = this.getAttribute('download');
                const href = this.href || '';
                if (downloadAttr !== null || this.hasAttribute('download')) {
                    const filename = downloadAttr || 'glossary.csv';
                    const lowerName = filename.toLowerCase();
                    const isCsv = lowerName.endsWith('.csv') || href.includes('.csv') || (this.type && this.type.includes('csv'));
                    if (isCsv || !downloadAttr) {
                        const finalName = lowerName.endsWith('.csv') ? filename : `${filename}.csv`;

                        if (!seenDownloadNames.has(finalName)) {
                            seenDownloadNames.add(finalName);
                            capturedDownloads.push({
                                name: finalName,
                                href: href
                            });
                            return origAnchorClick.apply(this, arguments);
                        } else {
                            return;
                        }
                    }
                }
                return origAnchorClick.apply(this, arguments);
            };

            let origWriteText = null;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
                navigator.clipboard.writeText = async function (text) {
                    capturedClipboard = text;
                    try { return await origWriteText(text); } catch (e) { return Promise.resolve(); }
                };
            }

            const copyListener = (e) => {
                const text = e.clipboardData?.getData('text/plain');
                if (text) capturedClipboard = text;
            };
                window.addEventListener('copy', copyListener, true);

                // 1. Switch to Glossary (Desktop Tab OR Mobile Navigation Link)
                const glossaryTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim().startsWith('Glossary'));
                const glossaryCardLink = document.querySelector('a[href*="tab=glossary"]');

                if (glossaryTab) {
                    const isActive = glossaryTab.getAttribute('aria-selected') === 'true' || glossaryTab.hasAttribute('data-active');
                    if (!isActive) {
                        omniClick(glossaryTab);
                        await waitForElement('button[aria-label="More actions"], button[aria-label="Glossary tools"]', 6000);
                    }
                } else if (glossaryCardLink) {
                    omniClick(glossaryCardLink);
                    await waitForElement('button[aria-label="Glossary tools"], button[aria-label="More actions"]', 6000);
                }

                // 2. Open "More actions" (Desktop) or "Glossary tools" (Mobile)
                const toolsBtn = await waitForElement('button[aria-label="Glossary tools"], button[aria-label="More actions"]', 5000);
                if (toolsBtn) {
                    omniClick(toolsBtn);

                    // Wait for either desktop dropdown menu or mobile drawer dialog
                    let exportBtn = null;
                    for (let i = 0; i < 30; i++) {
                        const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [data-slot="drawer-content"] button, [data-drawer-content] button, div[role="dialog"] button, button'));
                        exportBtn = candidates.find(el => {
                            const text = el.textContent || '';
                            return text.includes('Export CSV') && !el.closest('header');
                        });
                        if (exportBtn) break;
                        await sleep(100);
                    }

                    // 3. Click "Export CSV"
                    if (exportBtn) {
                        omniClick(exportBtn);

                        // Wait for download or clipboard copy
                        for (let i = 0; i < 150; i++) {
                            if (capturedDownloads.length > 0) {
                                await sleep(1000);
                                break;
                            }
                            if (capturedClipboard !== null) {
                                break;
                            }
                            await sleep(100);
                        }
                    }
                }

                isExporting = false;
                HTMLAnchorElement.prototype.click = origAnchorClick;
                URL.createObjectURL = origCreateObjectURL;
                if (origWriteText && navigator.clipboard) {
                    navigator.clipboard.writeText = origWriteText;
                }
                window.removeEventListener('copy', copyListener, true);

                const finalGlossaryFiles = [];

                // 4. Collect downloaded CSV files
                const seenFinalNames = new Set();
                for (let file of capturedDownloads) {
                    if (seenFinalNames.has(file.name)) continue;
                    seenFinalNames.add(file.name);

                    let content = '';
                    if (capturedBlobs.has(file.href)) {
                        try { content = await capturedBlobs.get(file.href).text(); } catch (e) { }
                    }
                    if (!content && file.href) {
                        try {
                            const resp = await fetch(file.href);
                            content = await resp.text();
                        } catch (e) { }
                    }
                    if (content && content.trim().length > 0) {
                        finalGlossaryFiles.push({ name: file.name, content: content });
                    }
                }

                // 5. Clipboard fallback if few terms were exported
                if (finalGlossaryFiles.length === 0) {
                    let clipText = capturedClipboard;
                    if (!clipText && navigator.clipboard && navigator.clipboard.readText) {
                        try { clipText = await navigator.clipboard.readText(); } catch (e) { }
                    }

                    if (clipText && typeof clipText === 'string') {
                        const trimmed = clipText.trim();
                        const firstLine = trimmed.replace(/^\uFEFF/, '').split(/\r?\n/)[0]?.trim().toLowerCase();
                        if (firstLine && firstLine.startsWith('raw,translation,description')) {
                            const safeTitle = threadName.replace(/[\/\\?%*:|"<>]/g, '_');
                            finalGlossaryFiles.push({
                                name: `glossary-${safeTitle}.csv`,
                                content: trimmed
                            });
                        }
                    }
                }

                if (finalGlossaryFiles.length > 0) {
                    await saveGlossaryFiles(runId, finalGlossaryFiles);
                }

                // 6. Return back to Translation / Chapters view (Desktop Tab or Mobile Back Button)
                const transTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim().startsWith('Translation'));
                const mobileBackBtn = document.querySelector('header button[aria-label="Back"]');

                if (transTab) {
                    omniClick(transTab);
                    await sleep(400);
                } else if (mobileBackBtn) {
                    omniClick(mobileBackBtn);
                    await sleep(500);
                } else if (window.location.search.includes('tab=glossary')) {
                    window.history.back();
                    await sleep(500);
                }
        } catch (err) {
            console.error("Glossary export error:", err);
        }
    }

    // --- HTML TEMPLATES ---
    function generateFullHTML(title, bodyContent, isRaw = false) {
        const htmlTag = isRaw ? '<html>' : '<html lang="en">';
        return `<!DOCTYPE html>
        ${htmlTag}
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; max-width: 800px; margin: 0 auto; padding: 30px 20px; color: #111; background-color: #fdfdfd; }
        p { margin-bottom: 1.2em; font-size: 18px; white-space: pre-line; }
        h1 { text-align: center; margin-top: 1em; margin-bottom: 1.5em; padding-bottom: 0.5em; border-bottom: 1px solid #eaeaea; font-size: 28px; }
        hr { border: 0; border-top: 1px solid #eaeaea; margin: 3em 0; }
        blockquote { border-left: 4px solid #d1d5db; padding-left: 1rem; margin-left: 0; color: #4b5563; font-style: italic; }
        .box { border: 1px solid #eaeaea; background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0; }
        .box p:last-child { margin-bottom: 0; }
        @media (prefers-color-scheme: dark) {
            body { background-color: #121212; color: #eee; }
            h1 { border-bottom: 1px solid #333; }
            hr { border-top: 1px solid #333; }
            blockquote { border-left-color: #4b5563; color: #9ca3af; }
            .box { border-color: #333; background-color: #1f1f1f; }
        }
        </style>
        </head>
        <body>
        <h1>${title}</h1>
        ${bodyContent}
        </body>
        </html>`;
    }

    // --- STRUCTURAL HTML SCRAPER WITH LINEBREAK PRESERVATION ---
    function extractChapterHTMLBlocks() {
        const root = document.querySelector('[data-reader-column="true"]') ||
        document.querySelector('section[data-reader-text="true"]') ||
        document.querySelector('.omni-box') ||
        document;

        const contentNodes = Array.from(root.querySelectorAll('p, hr, blockquote, h2, h3, h4'));
        if (contentNodes.length === 0) return "";

        let htmlBlocks = [];
        contentNodes.forEach(el => {
            if (el.closest('a') || el.closest('button') || el.closest('nav') || el.closest('header')) return;

            const tagName = el.tagName.toLowerCase();
            if (tagName === 'hr') {
                htmlBlocks.push('<hr/>');
                return;
            }

            if (tagName === 'p') {
                const rawHtml = el.innerHTML.trim();
                if (!rawHtml) return;

                if (rawHtml.includes('\n')) {
                    const lines = rawHtml.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                    lines.forEach(line => {
                        htmlBlocks.push(`<p>${line}</p>`);
                    });
                } else {
                    htmlBlocks.push(`<p>${rawHtml}</p>`);
                }
                return;
            }

            const trimmed = el.textContent.trim();
            if (trimmed.length > 0) {
                htmlBlocks.push(el.outerHTML);
            }
        });

        return htmlBlocks.join('\n');
    }

    // --- RAW CONTROLS DETECTOR ---
    function getRawToggleButton() {
        const toolbar = document.querySelector('[data-reader-toolbar], [role="toolbar"][aria-label="Chapter"]');
        if (toolbar) {
            const btn = toolbar.querySelector('button[aria-label="Original text"], button[aria-label*="Original"]');
            if (btn) return btn;
        }
        const candidates = Array.from(document.querySelectorAll('button[aria-label="Original text"], button[aria-label*="Original"]'));
        return candidates.find(b => !b.closest('[inert]')) || candidates[0] || null;
    }

    function isRawActive(rawBtn) {
        if (!rawBtn) return false;
        return rawBtn.getAttribute('aria-pressed') === 'true' ||
        rawBtn.getAttribute('data-state') === 'on' ||
        rawBtn.hasAttribute('data-pressed');
    }

    function isRawAvailable(rawBtn) {
        if (!rawBtn) return false;
        if (rawBtn.disabled || rawBtn.hasAttribute('disabled')) return false;
        if (rawBtn.getAttribute('aria-disabled') === 'true' || rawBtn.hasAttribute('data-disabled')) return false;
        return true;
    }

    function isPreviousChapterDisabled(prevBtn) {
        if (!prevBtn) return true;
        if (prevBtn.disabled || prevBtn.hasAttribute('disabled')) return true;
        if (prevBtn.getAttribute('aria-disabled') === 'true' || prevBtn.hasAttribute('data-disabled')) return true;
        if (prevBtn.tagName.toLowerCase() === 'a') {
            const href = prevBtn.getAttribute('href') || '';
            if (!href || href === '#' || (!href.includes('/translation/') && href.includes('thread'))) {
                return true;
            }
        }
        return false;
    }

    // --- EPUB GENERATOR (DIRECT CHAPTER TOC) ---
    async function generateEpubBlob(state, reversedFiles) {
        const blobWriter = new zip.BlobWriter("application/epub+zip");
        const zipWriter = new zip.ZipWriter(blobWriter);

        const title = state.threadName;
        const uuid = "urn:uuid:" + generateUUID();

        await zipWriter.add("mimetype", new zip.TextReader("application/epub+zip"), { level: 0 });
        const containerXml = `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>`;
        await zipWriter.add("META-INF/container.xml", new zip.TextReader(containerXml));

        const cssContent = `body { font-family: sans-serif; line-height: 1.6; padding: 2% 5%; color: #111; background: #fff; } h1 { text-align: center; margin-bottom: 1.5em; font-size: 1.6em; padding-bottom: 0.5em; border-bottom: 1px solid #eaeaea; } p { margin-bottom: 1.2em; font-size: 1.1em; white-space: pre-line; } blockquote { border-left: 4px solid #ccc; padding-left: 1em; margin-left: 0; font-style: italic; color: #555; } .box { border: 1px solid #eaeaea; background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0; } .box p:last-child { margin-bottom: 0; } @media (prefers-color-scheme: dark) { body { background: #121212; color: #eee; } h1 { border-color: #333; } blockquote { color: #9ca3af; border-color: #4b5563; } .box { border-color: #333; background: #1f1f1f; } }`;
        await zipWriter.add("OEBPS/Styles/style.css", new zip.TextReader(cssContent));

        let manifest = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n`;
        manifest += `<item id="css" href="Styles/style.css" media-type="text/css"/>\n`;
        let spine = ``;
        let navMap = ``;

        for (let i = 0; i < reversedFiles.length; i++) {
            const file = reversedFiles[i];
            const fileNum = String(i + 1).padStart(3, '0');
            const chapterId = `chapter_${fileNum}`;
            const chapterFilename = `Text/${chapterId}.html`;

            const safeTitle = escapeXml(`[${String(i + 1).padStart(2, '0')}] ${file.rawTitle}`);
            const safeContent = file.content.replace(/<br\s*\/?>/gi, '<br/>').replace(/<hr\s*\/?>/gi, '<hr/>');
            const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">\n<head><title>${safeTitle}</title>\n<link rel="stylesheet" href="../Styles/style.css" type="text/css"/>\n</head>\n<body>\n<h1>${safeTitle}</h1>\n${safeContent}\n</body>\n</html>`;

            await zipWriter.add(`OEBPS/${chapterFilename}`, new zip.TextReader(chapterHtml));
            manifest += `<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>\n`;
            spine += `<itemref idref="${chapterId}"/>\n`;
            navMap += `<navPoint id="navPoint-${i + 1}" playOrder="${i + 1}"><navLabel><text>${safeTitle}</text></navLabel><content src="${chapterFilename}"/></navPoint>\n`;
        }

        const opfXml = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n<dc:title>${escapeXml(title)}</dc:title>\n<dc:language>en</dc:language>\n<dc:identifier id="BookId">${uuid}</dc:identifier>\n</metadata>\n<manifest>\n${manifest}</manifest>\n<spine toc="ncx">\n${spine}</spine>\n</package>`;
        await zipWriter.add("OEBPS/content.opf", new zip.TextReader(opfXml));

        const ncxXml = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n<docTitle><text>${escapeXml(title)}</text></docTitle>\n<navMap>\n${navMap}</navMap>\n</ncx>`;
        await zipWriter.add("OEBPS/toc.ncx", new zip.TextReader(ncxXml));

        return await zipWriter.close();
    }

    // --- UI OVERLAY ---
    function showFinalScreen(dl, threadUrl, urlsToRevoke, runId) {
        const existing = document.getElementById('ro-cancel-btn');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.95)', zIndex: '9999999',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                      color: 'white', fontFamily: 'sans-serif', gap: '12px'
        });

        let html = `<h1 style="margin: 0; font-size: 24px;">🎉 Extraction Complete</h1>`;
        html += `<p style="margin: 0 0 10px 0; color: #aaa; text-align: center; max-width: 80%; font-size: 14px;">Choose your preferred download format below:</p>`;

        if (dl.epub) {
            html += `<a href="${dl.epub.url}" download="${dl.epub.name}" style="display: block; padding: 12px 30px; background-color: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📖 Save EPUB eBook</a>`;
        }

        if (dl.zip) {
            html += `<a href="${dl.zip.url}" download="${dl.zip.name}" style="display: block; padding: 12px 30px; background-color: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📦 Save ZIP Archive</a>`;
        }

        if (dl.log) {
            html += `<a href="${dl.log.url}" download="${dl.log.name}" style="display: block; padding: 12px 30px; background-color: #4b5563; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">🛠 Save Debug Log</a>`;
        }

        html += `<button id="ro-return-btn" style="margin-top: 15px; padding: 10px 24px; background: transparent; border: 2px solid #555; color: white; border-radius: 8px; font-size: 14px; cursor: pointer;">Return to Library</button>`;

        overlay.innerHTML = html;
        document.body.appendChild(overlay);

        document.getElementById('ro-return-btn').onclick = async () => {
            urlsToRevoke.forEach(url => URL.revokeObjectURL(url));
            if (runId) await clearRunData(runId);
            localStorage.removeItem(STATE_KEY);
            sessionStorage.removeItem(LOCK_KEY);
            window.location.href = threadUrl;
        };
    }

    async function prepareDownloads(state) {
        if (isPreparing) return;
        isPreparing = true;

        updateCancelButtonText("Generating Files...");

        const loadedChapters = await loadChapters(state.runId);
        logDebug(state, `Preparing downloads. Total files collected in IDB: ${loadedChapters.length}`);

        let dl = {};
        const dateStr = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

        if (state.logs && state.logs.length > 0) {
            const logContent = "--- READOMNI DEBUG LOG v39 ---\n" + navigator.userAgent + "\n\n" + state.logs.join('\n');
            dl.log = { url: URL.createObjectURL(new Blob([logContent], { type: 'text/plain' })), name: `readomni_debug_${new Date().getTime()}.txt` };
        }

        if (!loadedChapters || loadedChapters.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : [], state.runId);
            return;
        }

        let finalFiles = state.mode === 'selective' ? [...loadedChapters] : [...loadedChapters].reverse();

        if (finalFiles.length > 0) {
            const firstChap = finalFiles[0];
            const rawCheckString = (firstChap.rawTitle || "") + " " + (firstChap.rawContent || "");
            if (rawCheckString.includes("第99887章") || rawCheckString.includes("牌位")) {
                logDebug(state, "Found placeholder chapter. Removing.");
                finalFiles.shift();
            }
        }

        if (finalFiles.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : [], state.runId);
            return;
        }

        // --- EPUB GENERATION ---
        if (typeof zip !== 'undefined') {
            try {
                dl.epub = {
                    url: URL.createObjectURL(await generateEpubBlob(state, finalFiles)),
 name: `${state.threadName}_${dateStr}.epub`
                };
            } catch (e) {
                logDebug(state, `EPUB Generation Error: ${e.message}`);
            }
        }

        // --- ZIP GENERATION (SAFE AUTO-DEDUPLICATING) ---
        if (typeof zip !== 'undefined') {
            updateCancelButtonText("Compressing...");
            try {
                const blobWriter = new zip.BlobWriter("application/zip");
                const zipWriter = new zip.ZipWriter(blobWriter);
                const addedZipPaths = new Set();

                async function addZipEntry(targetPath, textContent) {
                    let finalPath = targetPath;
                    let counter = 1;
                    while (addedZipPaths.has(finalPath)) {
                        const dotIndex = targetPath.lastIndexOf('.');
                        if (dotIndex !== -1) {
                            finalPath = `${targetPath.substring(0, dotIndex)}_${counter}${targetPath.substring(dotIndex)}`;
                        } else {
                            finalPath = `${targetPath}_${counter}`;
                        }
                        counter++;
                    }
                    addedZipPaths.add(finalPath);
                    await zipWriter.add(finalPath, new zip.TextReader(textContent));
                }

                // Add translated and raw chapters
                for (let i = 0; i < finalFiles.length; i++) {
                    const file = finalFiles[i];
                    const fileNum = String(i + 1).padStart(2, '0');
                    const newTitle = `[${fileNum}] ${file.rawTitle}`;
                    const safeFilename = newTitle.replace(/[\/\\?%*:|"<>]/g, '_');

                    let singleFileHTML = generateFullHTML(newTitle, file.content, false);
                    await addZipEntry(`Translated/${safeFilename}.html`, singleFileHTML);

                    if (file.rawContent) {
                        const rawTitleDisplay = file.rawChapterTitle ? `[${fileNum}] ${file.rawChapterTitle}` : `${newTitle} (Raw)`;
                        const safeRawFilename = (file.rawChapterTitle ? `[${fileNum}] ${file.rawChapterTitle}` : `${safeFilename} (Raw)`).replace(/[\/\\?%*:|"<>]/g, '_');
                        let rawFileHTML = generateFullHTML(rawTitleDisplay, file.rawContent, true);
                        await addZipEntry(`Raw/${safeRawFilename}.html`, rawFileHTML);
                    }
                }

                // Add glossary folder to zip if enabled
                if (state.includeGlossary) {
                    const glossaryFiles = await loadGlossaryFiles(state.runId);
                    if (glossaryFiles && glossaryFiles.length > 0) {
                        for (let gFile of glossaryFiles) {
                            const safeName = gFile.name.replace(/[\/\\?%*:|"<>]/g, '_');
                            await addZipEntry(`glossary/${safeName}`, gFile.content);
                        }
                        logDebug(state, `Added ${glossaryFiles.length} glossary file(s) into zip.`);
                    }
                }

                const blob = await zipWriter.close();
                dl.zip = { url: URL.createObjectURL(blob), name: `${state.threadName}_${dateStr}.zip` };
            } catch (e) {
                logDebug(state, `ZIP Compression Error: ${e.message}`);
            }
        }

        const urlsToRevoke = Object.values(dl).map(item => item.url);
        showFinalScreen(dl, state.threadUrl, urlsToRevoke, state.runId);
    }

    // --- AUTOMATION SEQUENCE (SPA LOOP) ---
    async function processQueue() {
        let stateStr = localStorage.getItem(STATE_KEY);
        if (!stateStr) return;

        let state = JSON.parse(stateStr);
        logDebug(state, "Started/Resumed processQueue.");

        while (state.active) {
            if (isCancelled()) return;

            logDebug(state, `Processing chapter #${state.count}`);
            showCancelButton(state.count);

            await sleep(400);
            if (isCancelled()) return;
            const h1 = await waitForElement('h1');
            if (isCancelled()) return;

            if (!h1) {
                logDebug(state, "ERROR: Missing H1 tag. Halting.");
                state.active = false;
                await prepareDownloads(state);
                return;
            }

            let rawTitleText = h1.textContent.trim();
            if (!rawTitleText) rawTitleText = 'Untitled';

            // Ensure we are in Translated mode first if lingering in raw view
            const rawToggleBtn = getRawToggleButton();
            if (rawToggleBtn && isRawActive(rawToggleBtn)) {
                logDebug(state, "Resetting view to Translated mode...");
                omniClick(rawToggleBtn);
                await sleep(350);
                if (isCancelled()) return;
            }

            // 1. Extract Translated
            let extractedHTMLBlocks = extractChapterHTMLBlocks();

            // 2. Extract Raw
            let rawHTMLBlocks = null;
            let rawChapterTitle = null;
            let hasRawAvailable = false;

            if (rawToggleBtn && isRawAvailable(rawToggleBtn)) {
                hasRawAvailable = true;
                logDebug(state, "Toggling to Original text (Raw)...");
                omniClick(rawToggleBtn);

                for (let i = 0; i < 35; i++) {
                    await sleep(100);
                    if (isCancelled()) return;
                    const currentHTML = extractChapterHTMLBlocks();
                    if (isRawActive(rawToggleBtn) && currentHTML && currentHTML !== extractedHTMLBlocks) {
                        rawHTMLBlocks = currentHTML;
                        break;
                    }
                }

                if (!rawHTMLBlocks) {
                    rawHTMLBlocks = extractChapterHTMLBlocks();
                }

                const curH1 = document.querySelector('h1');
                if (curH1 && curH1.textContent.trim() && curH1.textContent.trim() !== rawTitleText) {
                    rawChapterTitle = curH1.textContent.trim();
                }

                if (!rawChapterTitle && rawHTMLBlocks) {
                    const match = rawHTMLBlocks.match(/<p>(第[0-9一二三四五六七八九十百千万]+章[^\n<]*)<\/p>/);
                    if (match && match[1]) {
                        rawChapterTitle = match[1].trim();
                    }
                }
            }

            const collectedTranslated = !!(extractedHTMLBlocks && extractedHTMLBlocks.trim().length > 0);
            const collectedRaw = !hasRawAvailable || !!(rawHTMLBlocks && rawHTMLBlocks.trim().length > 0);

            if (collectedTranslated && collectedRaw) {
                state.retryCount = 0;

                const freshStr = localStorage.getItem(STATE_KEY);
                if (!freshStr) return;
                state = JSON.parse(freshStr);
                if (!state.active) return;

                // Save chapter data directly to IndexedDB (completely bypasses localStorage quota)
                await appendChapter(state.runId, {
                    rawTitle: rawTitleText,
                    rawChapterTitle: rawChapterTitle,
                    content: extractedHTMLBlocks,
                    rawContent: rawHTMLBlocks
                });

                logDebug(state, `Collected: ${rawTitleText} (Trans: ${extractedHTMLBlocks.length}, Raw: ${rawHTMLBlocks ? rawHTMLBlocks.length : 0})`);
            } else {
                logDebug(state, `WARNING: Extracted HTML empty or incomplete for ${rawTitleText}.`);
                if (!state.retryCount) state.retryCount = 0;
                if (state.retryCount < 1) {
                    const freshStr = localStorage.getItem(STATE_KEY);
                    if (!freshStr) return;
                    state = JSON.parse(freshStr);
                    if (!state.active) return;

                    state.retryCount = 1;
                    localStorage.setItem(STATE_KEY, JSON.stringify(state));
                    logDebug(state, "Retrying chapter... Forcing hard reload.");
                    window.location.reload();
                    return;
                } else {
                    logDebug(state, "Retry failed. Moving on.");
                    state.retryCount = 0;
                }
            }

            if (isCancelled()) return;

            // 3. Navigate to next chapter
            if (state.mode === 'selective') {
                state.queueIndex++;
                if (state.queueIndex >= state.queue.length) {
                    logDebug(state, "Reached the end of selective queue.");
                    state.active = false;
                    await prepareDownloads(state);
                    return;
                }
                state.count++;

                const freshStr = localStorage.getItem(STATE_KEY);
                if (!freshStr) return;
                let freshState = JSON.parse(freshStr);
                if (!freshState.active) return;

                freshState.queueIndex = state.queueIndex;
                freshState.count = state.count;
                state = freshState;

                localStorage.setItem(STATE_KEY, JSON.stringify(state));
                logDebug(state, "Navigating to next selective chapter via Hard URL Redirect...");
                window.location.href = state.queue[state.queueIndex].url;
                return;
            }
            else {
                // Sequential Mode
                const prevBtn = await waitForElement('[aria-label="Previous chapter"]');
                if (isCancelled()) return;

                if (isPreviousChapterDisabled(prevBtn)) {
                    logDebug(state, "Reached the end of sequential chapter sequence.");
                    state.active = false;
                    await prepareDownloads(state);
                    return;
                }

                state.count++;

                const freshStr = localStorage.getItem(STATE_KEY);
                if (!freshStr) return;
                let freshState = JSON.parse(freshStr);
                if (!freshState.active) return;

                freshState.count = state.count;
                state = freshState;

                localStorage.setItem(STATE_KEY, JSON.stringify(state));

                logDebug(state, "Navigating backward directly from raw view...");
                const nextHref = prevBtn.getAttribute('href');
                omniClick(prevBtn);

                // Shortened watchdog timeout: 1.5s max before direct href navigation
                let contentChanged = false;
                for (let i = 0; i < 15; i++) {
                    await sleep(100);
                    if (isCancelled()) return;
                    const checkH1 = document.querySelector('h1');
                    if (checkH1) {
                        let checkTitle = checkH1.textContent.trim();
                        if (!checkTitle) checkTitle = 'Untitled';
                        if (checkTitle !== rawTitleText) {
                            contentChanged = true; break;
                        }
                    }
                }
                if (!contentChanged) {
                    if (nextHref && nextHref.includes('/translation/')) {
                        logDebug(state, "SPA navigation timed out. Directing via href...");
                        window.location.href = nextHref;
                        return;
                    }
                    logDebug(state, "Watchdog timeout! Page hung. Forcing hard reload.");
                    window.location.reload();
                    return;
                }
            }
        }
    }

    // --- SETUP UI & MODALS ---
    function showSetupModal() {
        if (document.getElementById('ro-setup-modal')) return;

        const currentTitle = getBookTitle();
        const savedGlossaryPref = localStorage.getItem(PREF_GLOSSARY_KEY);
        const includeGlossaryDefault = savedGlossaryPref !== null ? savedGlossaryPref === 'true' : true;

        const overlay = document.createElement('div');
        overlay.id = 'ro-setup-modal';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.85)', zIndex: '9999999',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'sans-serif'
        });

        overlay.innerHTML = `
        <div style="background: var(--card, #fff); color: var(--foreground, #111); padding: 24px; border-radius: 12px; width: 90%; max-width: 450px; border: 1px solid var(--border, #ccc); box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
        <h2 style="margin: 0 0 20px 0; font-size: 20px; font-weight: bold;">OmniDownloader Setup</h2>

        <label style="display: block; margin: 0 0 8px; font-weight: 600; font-size: 14px;">Book Title (Used for EPUB & Filenames):</label>
        <input id="ro-setup-title" type="text" value="${currentTitle}" style="width: 100%; padding: 10px; border-radius: 6px; background: var(--input, #f3f4f6); color: var(--foreground, #111); border: 1px solid var(--border, #ccc); margin-bottom: 20px; font-size: 14px;">

        <label style="display: block; margin: 0 0 8px; font-weight: 600; font-size: 14px;">Download Mode:</label>
        <select id="ro-setup-mode" style="width: 100%; padding: 10px; border-radius: 6px; background: var(--input, #f3f4f6); color: var(--foreground, #111); border: 1px solid var(--border, #ccc); margin-bottom: 16px; font-size: 14px;">
        <option value="selective">Selective (Custom Selection & Reorder)</option>
        <option value="sequential">Sequential (Latest to First)</option>
        </select>

        <div style="margin-bottom: 24px;">
        <label style="display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 600; cursor: pointer; user-select: none;">
        <input id="ro-setup-glossary" type="checkbox" ${includeGlossaryDefault ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: #8b5cf6; cursor: pointer;">
        Include Glossary
        </label>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 12px;">
        <button id="ro-btn-cancel" style="padding: 10px 20px; border-radius: 6px; background: transparent; color: var(--foreground, #111); border: 1px solid var(--border, #ccc); cursor: pointer; font-weight: bold;">Cancel</button>
        <button id="ro-btn-start" style="padding: 10px 20px; border-radius: 6px; background: #8b5cf6; color: #fff; border: none; cursor: pointer; font-weight: bold;">Next →</button>
        </div>
        </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('ro-btn-cancel').onclick = () => overlay.remove();
        document.getElementById('ro-btn-start').onclick = async () => {
            const mode = document.getElementById('ro-setup-mode').value;
            const chosenTitle = document.getElementById('ro-setup-title').value.trim() || 'ReadOmni_Book';
            const includeGlossary = document.getElementById('ro-setup-glossary').checked;

            localStorage.setItem(PREF_GLOSSARY_KEY, String(includeGlossary));

            const startBtn = document.getElementById('ro-btn-start');
            if (startBtn) {
                startBtn.disabled = true;
                startBtn.textContent = "Please wait...";
            }

            if (mode === 'sequential') {
                initSequential(chosenTitle, includeGlossary, overlay);
            } else {
                overlay.remove();
                if (window.location.pathname.includes('/thread/')) {
                    initSelectiveScrape(chosenTitle, includeGlossary);
                } else {
                    const threadLink = document.querySelector('a[href*="/thread/"]');
                    if (threadLink) {
                        sessionStorage.setItem('ro_sel_init', chosenTitle);
                        window.location.href = threadLink.href;
                    } else {
                        alert("Could not find Library page. Please navigate to the Thread manually to start Selective Download.");
                    }
                }
            }
        };
    }

    async function initSequential(customTitle, includeGlossary, modalOverlay) {
        const runId = Date.now().toString();
        sessionStorage.setItem(LOCK_KEY, runId);

        if (includeGlossary) {
            if (modalOverlay) {
                const h2 = modalOverlay.querySelector('h2');
                if (h2) h2.textContent = "Exporting Glossary...";
            }
            await exportGlossary(customTitle, runId);
        }

        if (modalOverlay) modalOverlay.remove();

        const transTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim().startsWith('Translation'));
        if (transTab) {
            omniClick(transTab);
            await sleep(300);
        }

        let rewindTries = 0;
        while (rewindTries++ < 50) {
            const prevPageBtn = document.querySelector('button[aria-label="Previous page"]');
            if (!prevPageBtn || prevPageBtn.disabled || prevPageBtn.hasAttribute('disabled')) break;
            omniClick(prevPageBtn);
            await sleep(300);
        }
        const chapterLinks = getChapterLinksFromPage();
        const firstLink = chapterLinks[0];
        if (!firstLink) return alert("Could not find any chapters to start with! Ensure the Translation tab is active.");

        const state = {
            mode: 'sequential', active: true, runId: runId,
 threadUrl: window.location.href.split('?')[0], includeRaws: true,
 includeGlossary: includeGlossary,
 threadName: customTitle, count: 1, retryCount: 0, logs: []
        };
        logDebug(state, `--- NEW RUN INITIALIZED (V39 Sequential) ---`);
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        const runUrl = new URL(firstLink.href, window.location.origin);
        runUrl.searchParams.set('ro_start_download', 'true');
        window.location.href = runUrl.toString();
    }

    // --- SELECTIVE SCRAPING (PAGINATION ONLY) ---
    async function initSelectiveScrape(customTitle, includeGlossary = true) {
        const fallbackTitle = getBookTitle();
        const threadName = customTitle || fallbackTitle;

        const transTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim().startsWith('Translation'));
        if (transTab) {
            const isTabActive = transTab.hasAttribute('data-active') || transTab.getAttribute('aria-selected') === 'true' || transTab.getAttribute('data-state') === 'active';
            if (!isTabActive) {
                omniClick(transTab);
                await sleep(400);
            }
        }

        const allRadio = Array.from(document.querySelectorAll('button[role="radio"]')).find(b => b.textContent.includes('All'));
        if (allRadio) {
            const isAllChecked = allRadio.getAttribute('aria-checked') === 'true' || allRadio.hasAttribute('data-checked');
            if (!isAllChecked) {
                omniClick(allRadio);
                await sleep(400);
            }
        }

        const loading = document.createElement('div');
        Object.assign(loading.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.85)', zIndex: '9999999', display: 'flex',
                      flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff',
                      fontFamily: 'sans-serif'
        });

        loading.innerHTML = `
        <div style="background: var(--card, #1f2023); color: var(--foreground, #fff); padding: 26px 32px; border-radius: 12px; max-width: 440px; width: 90%; text-align: center; border: 1px solid var(--border, #333); box-shadow: 0 10px 30px rgba(0,0,0,0.6);">
        <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: bold;">Scraping Chapter List...</h2>
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px; margin: 18px 0;">
        <svg style="animation: ro-spin 1s linear infinite;" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill=none stroke="#8b5cf6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
        <span id="ro-scrape-count" style="font-size: 16px; font-weight: 600; color: #8b5cf6;">Scanning chapters...</span>
        </div>
        <p id="ro-scrape-info" style="color: var(--muted-foreground, #aaa); font-size: 13px; margin: 0 0 20px 0; line-height: 1.5;">Navigating pages to collect all chapters.</p>
        <div style="display: flex; gap: 10px; justify-content: center;">
        <button id="ro-scrape-abort" style="padding: 9px 16px; border-radius: 6px; background: transparent; color: var(--foreground, #eee); border: 1px solid var(--border, #555); cursor: pointer; font-size: 13px;">Cancel</button>
        <button id="ro-scrape-proceed" style="padding: 9px 20px; border-radius: 6px; background: #8b5cf6; color: #fff; border: none; cursor: pointer; font-weight: bold; font-size: 13px;">Proceed with Loaded</button>
        </div>
        </div>
        <style>@keyframes ro-spin { to { transform: rotate(360deg); } }</style>
        `;
        document.body.appendChild(loading);

        let isAborted = false;
        let forceProceed = false;

        document.getElementById('ro-scrape-abort').onclick = () => {
            isAborted = true;
            loading.remove();
        };

        document.getElementById('ro-scrape-proceed').onclick = () => {
            forceProceed = true;
        };

        try {
            let allLinksMap = new Map();
            const countEl = document.getElementById('ro-scrape-count');
            const infoEl = document.getElementById('ro-scrape-info');
            const proceedBtn = document.getElementById('ro-scrape-proceed');

            let rewindTries = 0;
            while (!isAborted && !forceProceed && rewindTries++ < 50) {
                const prevBtn = document.querySelector('button[aria-label="Previous page"]');
                if (!prevBtn || prevBtn.disabled || prevBtn.hasAttribute('disabled')) break;

                if (infoEl) infoEl.textContent = "Rewinding to Page 1...";
                const oldFirst = getChapterLinksFromPage()[0]?.href;
                omniClick(prevBtn);

                for (let i = 0; i < 30; i++) {
                    await sleep(100);
                    if (isAborted || forceProceed) break;
                    const curFirst = getChapterLinksFromPage()[0]?.href;
                    if (curFirst && curFirst !== oldFirst) break;
                }
            }

            let pageNum = 1;
            while (!isAborted && !forceProceed) {
                const links = getChapterLinksFromPage();
                links.forEach(l => {
                    const title = extractChapterTitle(l);
                    allLinksMap.set(l.href, title);
                });

                const currentCount = allLinksMap.size;
                if (countEl) countEl.textContent = `Found ${currentCount} chapters (Page ${pageNum})...`;
                if (proceedBtn) proceedBtn.textContent = `Proceed with Loaded (${currentCount})`;
                if (infoEl) infoEl.textContent = `Scraped page ${pageNum}. Loading next...`;

                const nextBtn = document.querySelector('button[aria-label="Next page"]');
                if (!nextBtn || nextBtn.disabled || nextBtn.hasAttribute('disabled')) {
                    break;
                }

                const oldFirst = links[0]?.href;
                const oldPageSpan = document.querySelector('nav[aria-label="Pages"] span')?.textContent;

                omniClick(nextBtn);

                let changed = false;
                for (let i = 0; i < 40; i++) {
                    await sleep(100);
                    if (isAborted || forceProceed) break;
                    const newFirst = getChapterLinksFromPage()[0]?.href;
                    const newPageSpan = document.querySelector('nav[aria-label="Pages"] span')?.textContent;
                    if ((newFirst && newFirst !== oldFirst) || (newPageSpan && newPageSpan !== oldPageSpan)) {
                        changed = true;
                        break;
                    }
                }

                if (!changed) break;
                pageNum++;
                await sleep(200);
            }

            if (isAborted) return;
            loading.remove();

            if (allLinksMap.size === 0) {
                alert("No chapters found. Please make sure the Translation tab is active and visible.");
                return;
            }

            let rawList = Array.from(allLinksMap.entries()).map(([url, title]) => ({ url, title, selected: true }));

            let isDescending = true;
            const sortTh = document.querySelector('th[aria-sort]');
            if (sortTh) {
                isDescending = sortTh.getAttribute('aria-sort') !== 'ascending';
            } else {
                const sortBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Descending') || b.textContent.includes('Ascending'));
                if (sortBtn) {
                    isDescending = sortBtn.textContent.includes('Descending');
                }
            }

            if (isDescending) {
                rawList.reverse();
            }

            if (rawList.length > 0 && (rawList[0].title.includes("99887") || rawList[0].title.includes("牌位"))) {
                rawList.shift();
            }

            showSelectiveUI(rawList, threadName, window.location.href, includeGlossary);

        } catch (e) {
            loading.remove();
            alert("Error during scraping: " + e.message);
        }
    }

    function showSelectiveUI(listArray, threadName, threadUrl, includeGlossary = true) {
        const ui = document.createElement('div');
        Object.assign(ui.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'var(--background, #fdfdfd)', color: 'var(--foreground, #111)', zIndex: '9999999',
                      display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif'
        });

        ui.innerHTML = `
        <div style="padding: 16px 24px; border-bottom: 1px solid var(--border, #ccc); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
        <div style="display:flex; flex-direction:column; gap: 4px;">
        <h2 style="margin: 0; font-size: 20px;">Select & Reorder</h2>
        <input id="ro-sel-title" type="text" value="${threadName}" style="padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border, #ccc); background: var(--input, #f3f4f6); color: var(--foreground, #111); font-size: 13px; width: 100%; max-width: 300px;">
        </div>
        <div style="display:flex; gap:10px;">
        <button id="ro-sel-cancel" style="padding: 10px 16px; border-radius: 6px; background: transparent; color: var(--foreground); border: 1px solid var(--border, #ccc); cursor: pointer; font-weight: bold;">Cancel</button>
        <button id="ro-sel-start" style="padding: 10px 24px; border-radius: 6px; background: #8b5cf6; color: #fff; border: none; cursor: pointer; font-weight: bold;">Download Selected</button>
        </div>
        </div>
        <div style="padding: 12px 24px; background: var(--muted, #f3f4f6); display: flex; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid var(--border, #ccc);">
        <button id="ro-sel-all" style="padding: 8px 14px; border-radius: 4px; border: 1px solid var(--border, #ccc); background: var(--card, #fff); color: var(--foreground, #111); cursor: pointer; font-size: 13px;">Select All</button>
        <button id="ro-sel-none" style="padding: 8px 14px; border-radius: 4px; border: 1px solid var(--border, #ccc); background: var(--card, #fff); color: var(--foreground, #111); cursor: pointer; font-size: 13px;">Deselect All</button>
        <span style="margin-left:auto; align-self:center; font-size:12px; color:var(--muted-foreground, #888);">(Hold/Shift+Click row for multi-select • Drag handle to reorder)</span>
        </div>
        <div id="ro-sel-list" style="flex: 1; overflow-y: auto; padding: 10px 0; display: flex; flex-direction: column; position: relative;">
        </div>
        `;
        document.body.appendChild(ui);

        const listContainer = document.getElementById('ro-sel-list');

        listArray.forEach((itemData) => {
            const row = document.createElement('div');
            row.className = 'ro-list-row selected';
            row.dataset.url = itemData.url;
            row.dataset.title = itemData.title;

            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--border, #eaeaea)',
                          cursor: 'pointer', userSelect: 'none', transition: 'background 0.1s'
            });

            row.innerHTML = `
            <input type="checkbox" checked style="pointer-events: none; margin-right: 16px; width: 18px; height: 18px; accent-color: #8b5cf6;">
            <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 15px;">${escapeXml(itemData.title)}</span>
            <div class="ro-drag-handle" style="padding: 10px; cursor: grab; touch-action: none; color: var(--muted-foreground, #888);" title="Drag to reorder">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
            </div>
            `;

            listContainer.appendChild(row);
        });

        const styleId = 'ro-sel-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
            .ro-list-row:hover { filter: brightness(0.95); }
            .ro-list-row.selected { background-color: rgba(139, 92, 246, 0.15); }
            .dark .ro-list-row:hover { filter: brightness(1.2); }
            .ro-drag-handle:hover { color: var(--foreground, #111) !important; }
            #ro-sel-list {
            scrollbar-width: auto;
            scrollbar-color: rgba(139, 92, 246, 0.5) var(--background, #fdfdfd);
            }
            #ro-sel-list::-webkit-scrollbar { width: 14px; }
            #ro-sel-list::-webkit-scrollbar-track {
            background: var(--background, #fdfdfd);
            border-left: 1px solid var(--border, #eaeaea);
            }
            #ro-sel-list::-webkit-scrollbar-thumb {
            background-color: rgba(139, 92, 246, 0.5);
            border-radius: 7px;
            border: 3px solid var(--background, #fdfdfd);
            background-clip: padding-box;
            }
            #ro-sel-list::-webkit-scrollbar-thumb:hover {
            background-color: rgba(139, 92, 246, 0.85);
            }
            `;
            document.head.appendChild(style);
        }

        let lastSelectedIdx = -1;
        let longPressTimer = null;
        let pressStartY = 0;

        function toggleRowSelection(row, isMultiSelect) {
            if (row.classList.contains('ro-placeholder')) return;
            const currentIdx = Array.from(listContainer.children).indexOf(row);

            if (isMultiSelect && lastSelectedIdx > -1) {
                const start = Math.min(currentIdx, lastSelectedIdx);
                const end = Math.max(currentIdx, lastSelectedIdx);
                const targetState = !row.classList.contains('selected');
                for (let i = start; i <= end; i++) {
                    const child = listContainer.children[i];
                    child.classList.toggle('selected', targetState);
                    child.querySelector('input').checked = targetState;
                }
            } else {
                const targetState = !row.classList.contains('selected');
                row.classList.toggle('selected', targetState);
                row.querySelector('input').checked = targetState;
                lastSelectedIdx = currentIdx;
            }
        }

        listContainer.addEventListener('click', (e) => {
            const handle = e.target.closest('.ro-drag-handle');
            if (handle) return;
            const row = e.target.closest('.ro-list-row');
            if (!row) return;
            toggleRowSelection(row, e.shiftKey);
        });

        listContainer.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.ro-drag-handle');
            if (!handle) return;
            const row = e.target.closest('.ro-list-row');
            if (!row) return;

            pressStartY = e.clientY;
            longPressTimer = setTimeout(() => {
                toggleRowSelection(row, true);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 500);
        });

        const clearPress = () => { if (longPressTimer) clearTimeout(longPressTimer); };
        window.addEventListener('pointerup', clearPress);
        window.addEventListener('pointercancel', clearPress);
        listContainer.addEventListener('pointermove', (e) => {
            if (longPressTimer && Math.abs(e.clientY - pressStartY) > 10) clearPress();
        });

            document.getElementById('ro-sel-all').onclick = () => {
                Array.from(listContainer.children).forEach(row => {
                    row.classList.add('selected');
                    row.querySelector('input').checked = true;
                });
            };

            document.getElementById('ro-sel-none').onclick = () => {
                Array.from(listContainer.children).forEach(row => {
                    row.classList.remove('selected');
                    row.querySelector('input').checked = false;
                });
            };

            let dragInfo = null;
            let autoScrollInterval = null;
            let lastClientY = 0;

            function stopAutoScroll() {
                if (autoScrollInterval) clearInterval(autoScrollInterval);
                autoScrollInterval = null;
            }

            function checkDragOverlap(clientY) {
                if (!dragInfo) return;
                const { row, ghost, pointerOffsetY } = dragInfo;

                ghost.style.top = (clientY - pointerOffsetY) + 'px';

                const siblings = Array.from(listContainer.children).filter(c => c !== row && !c.classList.contains('ro-placeholder'));
                const ghostCenter = clientY - pointerOffsetY + (ghost.offsetHeight / 2);

                let insertBeforeNode = null;
                for (let sibling of siblings) {
                    const sRect = sibling.getBoundingClientRect();
                    const sCenter = sRect.top + sRect.height / 2;
                    if (ghostCenter < sCenter) {
                        insertBeforeNode = sibling;
                        break;
                    }
                }

                if (row.nextElementSibling !== insertBeforeNode) {
                    const rects = new Map();
                    siblings.forEach(s => rects.set(s, s.getBoundingClientRect().top));

                    listContainer.insertBefore(row, insertBeforeNode);

                    siblings.forEach(s => {
                        const oldTop = rects.get(s);
                        const newTop = s.getBoundingClientRect().top;
                        const dY = oldTop - newTop;
                        if (dY !== 0) {
                            s.style.transform = `translateY(${dY}px)`;
                            s.style.transition = 'none';
                            requestAnimationFrame(() => {
                                s.style.transform = '';
                                s.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 1)';
                            });
                        }
                    });
                }
            }

            listContainer.addEventListener('pointerdown', (e) => {
                const handle = e.target.closest('.ro-drag-handle');
                if (!handle) return;

                const row = e.target.closest('.ro-list-row');
                if (!row) return;

                e.preventDefault();
                e.stopPropagation();

                try { handle.setPointerCapture(e.pointerId); } catch (err) { }

                const rect = row.getBoundingClientRect();

                const ghost = row.cloneNode(true);
                ghost.style.position = 'fixed';
                ghost.style.top = rect.top + 'px';
                ghost.style.left = rect.left + 'px';
                ghost.style.width = rect.width + 'px';
                ghost.style.height = rect.height + 'px';
                ghost.style.zIndex = '9999999';
                ghost.style.opacity = '0.95';
                ghost.style.boxShadow = '0 10px 25px rgba(0,0,0,0.3)';
                ghost.style.transition = 'none';
                ghost.style.pointerEvents = 'none';
                document.body.appendChild(ghost);

                row.style.opacity = '0.3';
                row.style.background = 'var(--muted, #eee)';
                row.classList.add('ro-placeholder');

                dragInfo = { row, ghost, handle, pointerOffsetY: e.clientY - rect.top };
            });

            window.addEventListener('pointermove', (e) => {
                if (!dragInfo) return;
                lastClientY = e.clientY;
                checkDragOverlap(lastClientY);

                const listRect = listContainer.getBoundingClientRect();
                const threshold = 60;
                let scrollDir = 0;

                if (lastClientY < listRect.top + threshold) {
                    scrollDir = -1;
                } else if (lastClientY > listRect.bottom - threshold) {
                    scrollDir = 1;
                }

                if (scrollDir !== 0 && !autoScrollInterval) {
                    autoScrollInterval = setInterval(() => {
                        listContainer.scrollTop += scrollDir * 12;
                        checkDragOverlap(lastClientY);
                    }, 16);
                } else if (scrollDir === 0 && autoScrollInterval) {
                    stopAutoScroll();
                }
            });

            window.addEventListener('pointerup', (e) => {
                if (!dragInfo) return;
                const { row, ghost, handle } = dragInfo;

                stopAutoScroll();
                try { handle.releasePointerCapture(e.pointerId); } catch (err) { }

                const finalRect = row.getBoundingClientRect();
                ghost.style.transition = 'top 0.2s cubic-bezier(0.2, 0, 1), left 0.2s cubic-bezier(0.2, 0, 1)';
                ghost.style.top = finalRect.top + 'px';
                ghost.style.left = finalRect.left + 'px';

                dragInfo = null;

                setTimeout(() => {
                    if (ghost && ghost.parentNode) ghost.remove();
                    row.style.opacity = '';
                    row.style.background = '';
                    row.classList.remove('ro-placeholder');
                }, 200);
            });

            document.getElementById('ro-sel-cancel').onclick = () => ui.remove();

            document.getElementById('ro-sel-start').onclick = async () => {
                const finalQueue = [];
                Array.from(listContainer.children).forEach(row => {
                    if (row.classList.contains('selected') && !row.classList.contains('ro-placeholder')) {
                        finalQueue.push({ url: row.dataset.url, title: row.dataset.title });
                    }
                });

                if (finalQueue.length === 0) return alert("No chapters selected!");

                const chosenTitle = document.getElementById('ro-sel-title').value.trim() || 'ReadOmni_Book';
                const startBtn = document.getElementById('ro-sel-start');
                if (startBtn) {
                    startBtn.disabled = true;
                    startBtn.textContent = includeGlossary ? "Exporting Glossary..." : "Starting...";
                }

                const runId = Date.now().toString();
                sessionStorage.setItem(LOCK_KEY, runId);

                if (includeGlossary) {
                    await exportGlossary(chosenTitle, runId);
                }

                ui.remove();

                const state = {
                    mode: 'selective', active: true, runId: runId,
                    threadUrl: threadUrl.split('?')[0], includeRaws: true,
 includeGlossary: includeGlossary,
 threadName: chosenTitle, count: 1, retryCount: 0, logs: [],
 queue: finalQueue, queueIndex: 0
                };
                logDebug(state, `--- NEW RUN INITIALIZED (V39 Selective) Total: ${finalQueue.length} ---`);
                localStorage.setItem(STATE_KEY, JSON.stringify(state));

                const runUrl = new URL(finalQueue[0].url, window.location.origin);
                runUrl.searchParams.set('ro_start_download', 'true');
                window.location.href = runUrl.toString();
            };
    }

    async function cancelDownload() {
        const stateStr = localStorage.getItem(STATE_KEY);
        if (stateStr) {
            const state = JSON.parse(stateStr);
            logDebug(state, "User clicked Cancel. Triggering early extraction.");
            state.active = false;
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
            sessionStorage.removeItem(LOCK_KEY);

            const btn = document.getElementById('ro-cancel-btn');
            if (btn) btn.remove();

            await prepareDownloads(state);
        } else {
            window.location.reload();
        }
        localStorage.removeItem(STATE_KEY);
        sessionStorage.removeItem(LOCK_KEY);
    }

    function updateCancelButtonText(text) {
        const btn = document.getElementById('ro-cancel-btn');
        if (btn) btn.innerHTML = `🛑 ${text}`;
    }

    function showCancelButton(count) {
        if (document.getElementById('ro-cancel-btn')) {
            updateCancelButtonText(`Cancel Auto-Download (Attempting: ${count})`);
            return;
        }
        const btn = document.createElement('button');
        btn.id = 'ro-cancel-btn';
        btn.innerHTML = `🛑 Cancel Auto-Download (Attempting: ${count})`;
        Object.assign(btn.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                      zIndex: '999999', padding: '10px 20px', backgroundColor: '#ef4444',
                      color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer',
                      fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        });
        btn.onclick = cancelDownload;
        document.body.appendChild(btn);
    }

    // --- SEAMLESS IN-PAGE DOWNLOAD BUTTON INJECTION ---
    function injectStartButton() {
        if (document.getElementById('ro-bulk-btn')) return;

        // Find the native thread header actions ("...") button
        const actionsBtn = document.querySelector('header button[aria-label="Thread actions"]');
        if (!actionsBtn || !actionsBtn.parentElement) return;

        const btn = document.createElement('button');
        btn.id = 'ro-bulk-btn';
        btn.type = 'button';
        btn.title = 'Download Book (EPUB & ZIP)';
        btn.setAttribute('aria-label', 'Download Book');

        // Inherits exact classes from ReadOmni's native header action button
        btn.className = actionsBtn.className;
        btn.style.display = 'inline-flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.cursor = 'pointer';

        btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download size-4 max-md:size-5">
        <path d="M12 15V3"></path>
        <path d="m7 10 5 5 5-5"></path>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        </svg>
        `;

        btn.onclick = showSetupModal;

        // Placed directly next to the "Thread actions" button
        actionsBtn.parentElement.insertBefore(btn, actionsBtn);
    }

    // --- SPA WATCHER ---
    let processActive = false;
    setInterval(() => {
        const selInit = sessionStorage.getItem('ro_sel_init');
        if (window.location.pathname.includes('/thread/') && selInit) {
            const title = selInit;
            sessionStorage.removeItem('ro_sel_init');
            const savedGlossaryPref = localStorage.getItem(PREF_GLOSSARY_KEY);
            const includeGlossary = savedGlossaryPref !== null ? savedGlossaryPref === 'true' : true;
            initSelectiveScrape(title, includeGlossary);
        }

        const isThreadPage = window.location.pathname.includes('/thread/');
        const isTranslation = window.location.pathname.includes('/translation/');
        const btnExists = document.getElementById('ro-bulk-btn');

        if (isThreadPage && !btnExists) injectStartButton();
        else if (!isThreadPage && btnExists) btnExists.remove();

        if (window.location.search.includes('ro_start_download=true')) {
            sessionStorage.setItem(LOCK_KEY, 'locked');
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('ro_start_download');
            window.history.replaceState(null, '', cleanUrl.toString());
        }

        const stateStr = localStorage.getItem(STATE_KEY);
        const isLockedTab = sessionStorage.getItem(LOCK_KEY) === 'locked';

        if (isTranslation && stateStr && isLockedTab && !processActive && !isPreparing) {
            processActive = true;
            processQueue().finally(() => { processActive = false; });
        }
    }, 1000);

})();
