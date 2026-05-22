// ==UserScript==
// @name         ReadOmni Sequential ZIP & EPUB Downloader
// @namespace    http://tampermonkey.net/
// @version      23.3
// @description  Permanent Bottom Nav, Faster Watchdog, Pro UI, Box Styles, and Animated Drag & Drop Selective Downloader.
// @author       You
// @match        https://app.readomni.com/*
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.26/dist/zip.min.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STATE_KEY = 'ro_bulk_v23_state';
    const LOCK_KEY = 'ro_v23_active_tab_lock';
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
                const el = document.querySelector(selector);
                if (el) resolve(el);
                else if (Date.now() > endTime) resolve(null);
                else setTimeout(check, 100);
            };
            check();
        });
    }

    function fireOmniClick(element) {
        if (!element) return;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
            const event = new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window });
            element.dispatchEvent(event);
        });
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

    // --- HTML TEMPLATES ---
    function generateFullHTML(title, bodyContent) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.8; max-width: 800px; margin: 0 auto; padding: 30px 20px; color: #111; background-color: #fdfdfd; }
        p { margin-bottom: 1.2em; font-size: 18px; }
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

    // --- STRUCTURAL HTML SCRAPER ---
    function extractChapterHTMLBlocks() {
        const activeTab = document.querySelector('[role="tabpanel"][data-state="active"]') || document;
        let textWrappers = Array.from(activeTab.querySelectorAll('.prose-p\\:last\\:mb-0'));

        if (textWrappers.length === 0) {
            textWrappers = Array.from(activeTab.querySelectorAll('.relative.group .w-full > div:last-child'));
        }
        if (textWrappers.length === 0) return "";

        let htmlBlocks = [];
        textWrappers.forEach(wrapper => {
            Array.from(wrapper.children).forEach(el => {
                const tagName = el.tagName.toLowerCase();
                if (tagName === 'hr') { htmlBlocks.push('<hr/>'); return; }

                let text = el.textContent.trim();
                if (text.length === 0 && tagName !== 'br') return;
                if (el.closest('a') || el.closest('button')) return;

                htmlBlocks.push(el.outerHTML);
            });
        });

        return htmlBlocks.join('\n');
    }

    // --- EPUB GENERATOR ---
    async function generateEpubBlob(state, reversedFiles, mode = 'tl') {
        const blobWriter = new zip.BlobWriter("application/epub+zip");
        const zipWriter = new zip.ZipWriter(blobWriter);

        const baseTitle = state.threadName;
        const title = mode === 'raw' ? `${baseTitle} (Raws Only)` : (mode === 'combined' ? `${baseTitle} (Combined)` : baseTitle);
        const uuid = "urn:uuid:" + generateUUID();

        await zipWriter.add("mimetype", new zip.TextReader("application/epub+zip"), { level: 0 });
        const containerXml = `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>`;
        await zipWriter.add("META-INF/container.xml", new zip.TextReader(containerXml));

        // Inject Stylesheet File
        const cssContent = `body { font-family: sans-serif; line-height: 1.6; padding: 2% 5%; color: #111; background: #fff; } h1 { text-align: center; margin-bottom: 1.5em; font-size: 1.6em; padding-bottom: 0.5em; border-bottom: 1px solid #eaeaea; } h1 a { color: inherit; text-decoration: none; border-bottom: 2px dashed #8b5cf6; transition: color 0.2s; } h1 a:hover { color: #8b5cf6; } p { margin-bottom: 1.2em; font-size: 1.1em; } blockquote { border-left: 4px solid #ccc; padding-left: 1em; margin-left: 0; font-style: italic; color: #555; } .box { border: 1px solid #eaeaea; background-color: #f4f4f5; border-radius: 8px; padding: 16px; margin: 24px 0; } .box p:last-child { margin-bottom: 0; } @media (prefers-color-scheme: dark) { body { background: #121212; color: #eee; } h1 { border-color: #333; } blockquote { color: #9ca3af; border-color: #4b5563; } .box { border-color: #333; background: #1f1f1f; } }`;
        await zipWriter.add("OEBPS/Styles/style.css", new zip.TextReader(cssContent));

        let manifest = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n`;
        manifest += `<item id="css" href="Styles/style.css" media-type="text/css"/>\n`;
        let spine = ``;
        let navMap = ``;
        let playOrder = 1;

        if (mode === 'tl' || mode === 'combined') {
            const firstTransId = `chapter_trans_001`;
            navMap += `<navPoint id="navGroup-tl" playOrder="${playOrder++}">\n<navLabel><text>Translated</text></navLabel>\n<content src="Text/${firstTransId}.html"/>\n`;

            for (let i = 0; i < reversedFiles.length; i++) {
                const file = reversedFiles[i];
                const fileNum = String(i + 1).padStart(3, '0');
                const chapterId = `chapter_trans_${fileNum}`;
                const chapterFilename = `Text/${chapterId}.html`;

                const safeTitle = escapeXml(`[${String(i + 1).padStart(2, '0')}] ${file.rawTitle}`);
                const safeContent = file.content.replace(/<br\s*\/?>/gi, '<br/>').replace(/<hr\s*\/?>/gi, '<hr/>');

                // Add link back to raw if combined
                const h1Content = (mode === 'combined' && file.rawContent) ? `<a href="chapter_raw_${fileNum}.html" title="Jump to Raw">${safeTitle}</a>` : safeTitle;

                const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${safeTitle}</title>\n<link rel="stylesheet" href="../Styles/style.css" type="text/css"/>\n</head>\n<body>\n<h1>${h1Content}</h1>\n${safeContent}\n</body>\n</html>`;

                await zipWriter.add(`OEBPS/${chapterFilename}`, new zip.TextReader(chapterHtml));
                manifest += `<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${chapterId}"/>\n`;
                navMap += `<navPoint id="navPoint-tl-${playOrder}" playOrder="${playOrder}"><navLabel><text>${safeTitle}</text></navLabel><content src="${chapterFilename}"/></navPoint>\n`;
                playOrder++;
            }
            navMap += `</navPoint>\n`;
        }

        if (mode === 'raw' || mode === 'combined') {
            let firstRawIdx = reversedFiles.findIndex(f => f.rawContent);
            if (firstRawIdx !== -1) {
                const firstRawId = `chapter_raw_${String(firstRawIdx + 1).padStart(3, '0')}`;
                navMap += `<navPoint id="navGroup-raw" playOrder="${playOrder++}">\n<navLabel><text>Raw</text></navLabel>\n<content src="Text/${firstRawId}.html"/>\n`;

                for (let i = 0; i < reversedFiles.length; i++) {
                    const file = reversedFiles[i];
                    if (!file.rawContent) continue;

                    const fileNum = String(i + 1).padStart(3, '0');
                    const chapterId = `chapter_raw_${fileNum}`;
                    const chapterFilename = `Text/${chapterId}.html`;

                    const safeTitle = escapeXml(`[${String(i + 1).padStart(2, '0')}] ${file.rawTitle} (Raw)`);
                    const safeContent = file.rawContent.replace(/<br\s*\/?>/gi, '<br/>').replace(/<hr\s*\/?>/gi, '<hr/>');

                    // Add link back to trans if combined
                    const h1Content = (mode === 'combined') ? `<a href="chapter_trans_${fileNum}.html" title="Jump to Translated">${safeTitle}</a>` : safeTitle;

                    const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${safeTitle}</title>\n<link rel="stylesheet" href="../Styles/style.css" type="text/css"/>\n</head>\n<body>\n<h1>${h1Content}</h1>\n${safeContent}\n</body>\n</html>`;

                    await zipWriter.add(`OEBPS/${chapterFilename}`, new zip.TextReader(chapterHtml));
                    manifest += `<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>\n`;
                    spine += `<itemref idref="${chapterId}"/>\n`;
                    navMap += `<navPoint id="navPoint-raw-${playOrder}" playOrder="${playOrder}"><navLabel><text>${safeTitle}</text></navLabel><content src="${chapterFilename}"/></navPoint>\n`;
                    playOrder++;
                }
                navMap += `</navPoint>\n`;
            }
        }

        const opfXml = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n<dc:title>${escapeXml(title)}</dc:title>\n<dc:language>en</dc:language>\n<dc:identifier id="BookId">${uuid}</dc:identifier>\n</metadata>\n<manifest>\n${manifest}</manifest>\n<spine toc="ncx">\n${spine}</spine>\n</package>`;
        await zipWriter.add("OEBPS/content.opf", new zip.TextReader(opfXml));

        const ncxXml = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n<docTitle><text>${escapeXml(title)}</text></docTitle>\n<navMap>\n${navMap}</navMap>\n</ncx>`;
        await zipWriter.add("OEBPS/toc.ncx", new zip.TextReader(ncxXml));

        return await zipWriter.close();
    }

    // --- UI OVERLAY ---
    function showFinalScreen(dl, threadUrl, urlsToRevoke) {
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

        if (dl.epubTl && dl.epubRaw && dl.epubCombined) {
            html += `<a href="${dl.epubCombined.url}" download="${dl.epubCombined.name}" style="display: block; padding: 12px 30px; background-color: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📖 Save EPUB (Combined)</a>`;
            html += `<a href="${dl.epubTl.url}" download="${dl.epubTl.name}" style="display: block; padding: 12px 30px; background-color: #9333ea; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📖 Save EPUB (Translated Only)</a>`;
            html += `<a href="${dl.epubRaw.url}" download="${dl.epubRaw.name}" style="display: block; padding: 12px 30px; background-color: #a855f7; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📖 Save EPUB (Raws Only)</a>`;
        } else if (dl.epubTl) {
            html += `<a href="${dl.epubTl.url}" download="${dl.epubTl.name}" style="display: block; padding: 12px 30px; background-color: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📖 Save EPUB eBook</a>`;
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

        document.getElementById('ro-return-btn').onclick = () => {
            urlsToRevoke.forEach(url => URL.revokeObjectURL(url));
            localStorage.removeItem(STATE_KEY);
            sessionStorage.removeItem(LOCK_KEY);
            window.location.href = threadUrl;
        };
    }

    async function prepareDownloads(state) {
        if (isPreparing) return;
        isPreparing = true;

        updateCancelButtonText("Generating Files...");
        logDebug(state, `Preparing downloads. Total files collected: ${state.files ? state.files.length : 0}`);

        let dl = {};
        const dateStr = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');

        if (state.logs && state.logs.length > 0) {
            const logContent = "--- READOMNI DEBUG LOG v23.0 ---\n" + navigator.userAgent + "\n\n" + state.logs.join('\n');
            dl.log = { url: URL.createObjectURL(new Blob([logContent], { type: 'text/plain' })), name: `readomni_debug_${new Date().getTime()}.txt` };
        }

        if (!state.files || state.files.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : []);
            return;
        }

        let finalFiles = state.mode === 'selective' ? [...state.files] : [...state.files].reverse();

        // Custom filter: ignore the placeholder chapter "第99887章 “牌位”" at the very start
        if (finalFiles.length > 0) {
            const firstChap = finalFiles[0];
            const rawCheckString = (firstChap.rawTitle || "") + " " + (firstChap.rawContent || "");
            if (rawCheckString.includes("第99887章") && rawCheckString.includes("牌位")) {
                logDebug(state, "Found ignore-flagged placeholder chapter '第99887章 “牌位”' as [01]. Removing and renumbering.");
                finalFiles.shift();
            }
        }

        if (finalFiles.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : []);
            return;
        }

        const hasRaws = finalFiles.some(f => f.rawContent);

        // --- EPUB GENERATION ---
        if (typeof zip !== 'undefined') {
            try {
                dl.epubTl = { url: URL.createObjectURL(await generateEpubBlob(state, finalFiles, 'tl')), name: `${state.threadName}_TL_${dateStr}.epub` };
                if (hasRaws) {
                    dl.epubRaw = { url: URL.createObjectURL(await generateEpubBlob(state, finalFiles, 'raw')), name: `${state.threadName}_RAW_${dateStr}.epub` };
                    dl.epubCombined = { url: URL.createObjectURL(await generateEpubBlob(state, finalFiles, 'combined')), name: `${state.threadName}_Combined_${dateStr}.epub` };
                }
            } catch (e) {
                logDebug(state, `EPUB Generation Error: ${e.message}`);
            }
        }

        // --- ZIP GENERATION ---
        if (typeof zip !== 'undefined') {
            updateCancelButtonText("Compressing...");
            try {
                const blobWriter = new zip.BlobWriter("application/zip");
                const zipWriter = new zip.ZipWriter(blobWriter);

                for (let i = 0; i < finalFiles.length; i++) {
                    const file = finalFiles[i];
                    const fileNum = String(i + 1).padStart(2, '0');
                    const newTitle = `[${fileNum}] ${file.rawTitle}`;
                    const safeFilename = newTitle.replace(/[\/\\?%*:|"<>]/g, '_');

                    let singleFileHTML = generateFullHTML(newTitle, file.content);
                    await zipWriter.add(`Translated/${safeFilename}.html`, new zip.TextReader(singleFileHTML));

                    if (file.rawContent) {
                        let rawFileHTML = generateFullHTML(`${newTitle} (Raw)`, file.rawContent);
                        await zipWriter.add(`Raw/${safeFilename} (Raw).html`, new zip.TextReader(rawFileHTML));
                    }
                }

                const blob = await zipWriter.close();
                dl.zip = { url: URL.createObjectURL(blob), name: `${state.threadName}_${dateStr}.zip` };
            } catch (e) {
                logDebug(state, `ZIP Compression Error: ${e.message}`);
            }
        }

        const urlsToRevoke = Object.values(dl).map(item => item.url);
        showFinalScreen(dl, state.threadUrl, urlsToRevoke);
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

            // Extract Translated
            let translatedTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.includes('Translated'));
            if (translatedTab && translatedTab.getAttribute('aria-selected') !== 'true') {
                fireOmniClick(translatedTab);
                await sleep(300);
                if (isCancelled()) return;
            }
            let extractedHTMLBlocks = extractChapterHTMLBlocks();

            // Extract Raw (Always extracted)
            let rawHTMLBlocks = null;
            let rawTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.includes('Raw'));
            if (rawTab) {
                if (rawTab.getAttribute('aria-selected') !== 'true') {
                    fireOmniClick(rawTab);
                    await sleep(400);
                    if (isCancelled()) return;
                }
                rawHTMLBlocks = extractChapterHTMLBlocks();
            }
            if (translatedTab) {
                fireOmniClick(translatedTab);
                await sleep(200);
                if (isCancelled()) return;
            }

            const hasRawTab = !!rawTab;
            const collectedTranslated = !!(extractedHTMLBlocks && extractedHTMLBlocks.trim().length > 0);
            const collectedRaw = !hasRawTab || !!(rawHTMLBlocks && rawHTMLBlocks.trim().length > 0);

            if (collectedTranslated && collectedRaw) {
                state.retryCount = 0;
                
                // Re-read current state from localStorage to ensure we don't overwrite user cancellation
                const freshStr = localStorage.getItem(STATE_KEY);
                if (!freshStr) return;
                state = JSON.parse(freshStr);
                if (!state.active) return;

                state.files.push({ rawTitle: rawTitleText, content: extractedHTMLBlocks, rawContent: rawHTMLBlocks });
                logDebug(state, `Collected: ${rawTitleText} (Trans: ${extractedHTMLBlocks.length}, Raw: ${rawHTMLBlocks ? rawHTMLBlocks.length : 0})`);
            } else {
                logDebug(state, `WARNING: Extracted HTML was empty or incomplete for ${rawTitleText}. (Trans collected: ${collectedTranslated}, Raw collected: ${collectedRaw})`);
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
                    logDebug(state, "Retry failed. Moving on to prevent infinite loop.");
                    state.retryCount = 0;
                }
            }

            if (isCancelled()) return;

            // Route execution based on mode
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
                freshState.files = state.files;
                state = freshState;

                try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {
                    logDebug(state, "Storage limit hit. Generating early package.");
                    state.active = false;
                    await prepareDownloads(state);
                    return;
                }
                logDebug(state, "Navigating to next selective chapter via Hard URL Redirect...");
                window.location.href = state.queue[state.queueIndex].url;
                return;
            }
            else {
                // Sequential Mode
                const prevBtn = await waitForElement('[aria-label="Previous chapter"]');
                if (isCancelled()) return;

                if (!prevBtn || prevBtn.hasAttribute('disabled') || prevBtn.tagName.toLowerCase() === 'button') {
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
                freshState.files = state.files;
                state = freshState;

                try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {
                    state.active = false; await prepareDownloads(state); return;
                }

                logDebug(state, "Navigating backward...");
                fireOmniClick(prevBtn);

                let contentChanged = false;
                for (let i = 0; i < 45; i++) {
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
        <select id="ro-setup-mode" style="width: 100%; padding: 10px; border-radius: 6px; background: var(--input, #f3f4f6); color: var(--foreground, #111); border: 1px solid var(--border, #ccc); margin-bottom: 25px; font-size: 14px;">
        <option value="sequential">Sequential (Current to First)</option>
        <option value="selective">Selective (Custom Selection & Reorder)</option>
        </select>

        <div style="display: flex; justify-content: flex-end; gap: 12px;">
        <button id="ro-btn-cancel" style="padding: 10px 20px; border-radius: 6px; background: transparent; color: var(--foreground, #111); border: 1px solid var(--border, #ccc); cursor: pointer; font-weight: bold;">Cancel</button>
        <button id="ro-btn-start" style="padding: 10px 20px; border-radius: 6px; background: #8b5cf6; color: #fff; border: none; cursor: pointer; font-weight: bold;">Next →</button>
        </div>
        </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('ro-btn-cancel').onclick = () => overlay.remove();
        document.getElementById('ro-btn-start').onclick = () => {
            const mode = document.getElementById('ro-setup-mode').value;
            const chosenTitle = document.getElementById('ro-setup-title').value.trim() || 'ReadOmni_Book';
            overlay.remove();

            if (mode === 'sequential') {
                const firstLink = Array.from(document.querySelectorAll('a[href*="/translation/"]')).find(l => l.closest('[role="button"]'));
                if (!firstLink) return alert("Could not find any chapters to start with!");
                initSequential(firstLink.href, chosenTitle);
            } else {
                if (window.location.pathname.includes('/thread/')) {
                    initSelectiveScrape(chosenTitle);
                } else {
                    const threadLink = document.querySelector('a[href*="/thread/"]');
                    if (threadLink) {
                        sessionStorage.setItem('ro_sel_init', chosenTitle);
                        window.location.href = threadLink.href;
                    } else {
                        alert("Could not find Library page. Please go to the Library manually to start Selective Download.");
                    }
                }
            }
        };
    }

    function initSequential(startUrl, customTitle) {
        const runId = Date.now().toString();
        sessionStorage.setItem(LOCK_KEY, runId);
        const state = {
            mode: 'sequential', active: true, runId: runId,
            threadUrl: window.location.href, includeRaws: true,
            threadName: customTitle, count: 1, retryCount: 0, files: [], logs: []
        };
        logDebug(state, `--- NEW RUN INITIALIZED (V23.0 Sequential) ---`);
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        const runUrl = new URL(startUrl, window.location.origin);
        runUrl.searchParams.set('ro_start_download', 'true');
        window.location.href = runUrl.toString();
    }

    // --- SELECTIVE SCRAPING & UI ---
    async function initSelectiveScrape(customTitle) {
        const fallbackTitle = getBookTitle();
        const threadName = customTitle || fallbackTitle;

        const loading = document.createElement('div');
        Object.assign(loading.style, {
            position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
            backgroundColor: 'rgba(0,0,0,0.85)', zIndex: '9999999', display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff'
        });
        loading.innerHTML = `<h2 style="margin:0 0 10px;font-size:22px;">Scraping Chapter List...</h2><p style="color:#aaa;font-size:14px;">This might take a few seconds.</p>`;
        document.body.appendChild(loading);

        try {
            // Force 100 per page to minimize clicks
            const combo = document.querySelector('button[role="combobox"]');
            if (combo && !combo.textContent.includes('100')) {
                fireOmniClick(combo);
                await sleep(300);
                const opts = Array.from(document.querySelectorAll('[role="option"]'));
                const opt100 = opts.find(o => o.textContent.includes('100'));
                if (opt100) {
                    fireOmniClick(opt100);
                    await sleep(1500);
                }
            }

            let allLinksMap = new Map();

            while (true) {
                const links = Array.from(document.querySelectorAll('a[href*="/translation/"]')).filter(l => l.closest('[role="button"]'));
                links.forEach(l => {
                    const titleEl = l.querySelector('h3') || l.querySelector('span.truncate') || l;
                    allLinksMap.set(l.href, titleEl.textContent.trim());
                });

                const nextBtn = Array.from(document.querySelectorAll('button')).find(b => {
                    const sr = b.querySelector('span.sr-only');
                    return sr && sr.textContent.includes('Go to next page');
                });

                if (!nextBtn || nextBtn.hasAttribute('disabled') || nextBtn.disabled) break;

                const firstHref = links[0]?.href;
                fireOmniClick(nextBtn);

                let changed = false;
                for (let i = 0; i < 30; i++) {
                    await sleep(100);
                    const firstLink = Array.from(document.querySelectorAll('a[href*="/translation/"]')).find(l => l.closest('[role="button"]'));
                    const newFirst = firstLink?.href;
                    if (newFirst && newFirst !== firstHref) { changed = true; break; }
                }
                if (!changed) break;
                await sleep(200);
            }

            loading.remove();

            let rawList = Array.from(allLinksMap.entries()).map(([url, title]) => ({ url, title, selected: true }));

            // Reverse to get First -> Current
            rawList.reverse();

            // Filter out placeholder chapter if it's the absolute first entry
            if (rawList.length > 0 && rawList[0].title.includes("99887")) {
                rawList.shift();
            }

            showSelectiveUI(rawList, threadName, window.location.href);

        } catch (e) {
            loading.remove();
            alert("Error during scraping: " + e.message);
        }
    }

    function showSelectiveUI(listArray, threadName, threadUrl) {
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
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
            </div>
            `;

            listContainer.appendChild(row);
        });

        // Add Hover & Selection styles dynamically
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
            #ro-sel-list::-webkit-scrollbar {
                width: 14px;
            }
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

        // --- Interaction Logic: Selection ---
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

        // Touch long-press emulation for multi-select
        listContainer.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.ro-drag-handle');
            if (handle) return;
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

        // --- Interaction Logic: Drag & Drop Reordering with Auto-Scroll ---
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
                            s.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)';
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

            dragInfo = {
                row, ghost, handle,
                pointerOffsetY: e.clientY - rect.top
            };
        });

        window.addEventListener('pointermove', (e) => {
            if (!dragInfo) return;
            lastClientY = e.clientY;
            checkDragOverlap(lastClientY);

            // Auto-scroll logic
            const listRect = listContainer.getBoundingClientRect();
            const threshold = 60; // Distance from edge to trigger scroll
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
            ghost.style.transition = 'top 0.2s cubic-bezier(0.2, 0, 0, 1), left 0.2s cubic-bezier(0.2, 0, 0, 1)';
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

        // --- Execute Actions ---
        document.getElementById('ro-sel-cancel').onclick = () => ui.remove();

        document.getElementById('ro-sel-start').onclick = () => {
            const finalQueue = [];
            Array.from(listContainer.children).forEach(row => {
                if (row.classList.contains('selected') && !row.classList.contains('ro-placeholder')) {
                    finalQueue.push({ url: row.dataset.url, title: row.dataset.title });
                }
            });

            if (finalQueue.length === 0) return alert("No chapters selected!");

            const chosenTitle = document.getElementById('ro-sel-title').value.trim() || 'ReadOmni_Book';
            ui.remove();

            const runId = Date.now().toString();
            sessionStorage.setItem(LOCK_KEY, runId);
            const state = {
                mode: 'selective', active: true, runId: runId,
                threadUrl: threadUrl, includeRaws: true,
                threadName: chosenTitle, count: 1, retryCount: 0, files: [], logs: [],
                queue: finalQueue, queueIndex: 0
            };
            logDebug(state, `--- NEW RUN INITIALIZED (V23.0 Selective) Total: ${finalQueue.length} ---`);
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
            // Mark state as inactive and remove lock IMMEDIATELY so processQueue halts instantly
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
            sessionStorage.removeItem(LOCK_KEY);

            // Remove cancel button so user can't double-click it
            const btn = document.getElementById('ro-cancel-btn');
            if (btn) btn.remove();

            await prepareDownloads(state);
        } else {
            window.location.reload();
        }
        localStorage.removeItem(STATE_KEY);
        sessionStorage.removeItem(LOCK_KEY);
    }

    // --- UI INJECTION ---
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

    function injectStartButton() {
        if (document.getElementById('ro-bulk-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'ro-bulk-btn';
        btn.title = "Download Thread";
        btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" x2="12" y1="15" y2="3"></line>
        </svg>
        `;
        Object.assign(btn.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '999999',
            width: '56px', height: '56px', borderRadius: '50%',
            backgroundColor: '#8b5cf6', color: '#fff', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transition: 'transform 0.1s'
        });
        btn.onmousedown = () => btn.style.transform = 'scale(0.92)';
        btn.onmouseup = () => btn.style.transform = 'scale(1)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';
        btn.onclick = showSetupModal;
        document.body.appendChild(btn);
    }

    // --- SPA WATCHER ---
    let processActive = false;
    setInterval(() => {
        const selInit = sessionStorage.getItem('ro_sel_init');
        if (window.location.pathname.includes('/thread/') && selInit) {
            const title = selInit;
            sessionStorage.removeItem('ro_sel_init');
            initSelectiveScrape(title);
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
