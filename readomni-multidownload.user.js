// ==UserScript==
// @name         ReadOmni Sequential ZIP & EPUB Downloader
// @namespace    http://tampermonkey.net/
// @version      20.4
// @description  Permanent Bottom Nav, Faster Watchdog Timeout, Pro Reader UI, Box Styles, and First-Chapter Filtering.
// @author       You
// @match        https://app.readomni.com/*
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.26/dist/zip.min.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const STATE_KEY = 'ro_bulk_v20_state';
    const LOCK_KEY = 'ro_v20_active_tab_lock';
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
            try { localStorage.setItem(STATE_KEY, JSON.stringify(stateObj)); } catch(e) {}
        }
    }

    // --- HELPER FUNCTIONS ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
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

    function generateWebnovelHTML(bookTitle, chaptersArray) {
        const chaptersJSON = JSON.stringify(chaptersArray).replace(/<\//g, "<\\/");
        const safeBookId = escapeXml(bookTitle).replace(/[^a-zA-Z0-9]/g, '_');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${bookTitle}</title>
        <style>
        :root { --bg: #fdfdfd; --text: #111; --border: #eaeaea; --btn-bg: #fff; --btn-hover: #f0f0f0; --accent: #8b5cf6; --raw: #ef4444; --box-bg: #f4f4f5; }
        body.dark-mode { --bg: #121212; --text: #eee; --border: #333; --btn-bg: #1e1e1e; --btn-hover: #2a2a2a; --box-bg: #1f1f1f; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; transition: background 0.2s, color 0.2s; -webkit-tap-highlight-color: transparent;}
        .container { max-width: 800px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }

        /* Toolbars */
        .toolbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 100; gap: 12px; flex-wrap: wrap; box-shadow: 0 2px 10px rgba(0,0,0,0.05);}
        .toolbar-group { display: flex; gap: 8px; }
        .bottom-nav { display: flex; justify-content: space-between; padding: 30px 20px 50px 20px; border-top: 1px solid var(--border); margin-top: auto; background: var(--bg); gap: 20px; }

        /* UI State Controllers */
        body.hide-ui .toolbar { display: none !important; }
        body.index-active #reader-view, body.index-active .bottom-nav { display: none !important; }
        body.index-active #index-view { display: block !important; }

        /* Buttons */
        button { background: var(--btn-bg); color: var(--text); border: 1px solid var(--border); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; transition: background 0.2s, transform 0.1s; display: flex; align-items: center; gap: 6px; user-select: none; touch-action: manipulation;}
        button:hover:not(:disabled) { background: var(--btn-hover); }
        button:active:not(:disabled) { transform: scale(0.96); }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .bottom-nav button { padding: 12px 24px; font-size: 16px; flex: 1; justify-content: center; }

        /* Reader Area */
        .content-area { padding: 50px 20px 80px 20px; flex-grow: 1; }
        body.hide-ui .content-area { padding-top: 30px; }
        .chapter-title { text-align: center; margin-top: 0; margin-bottom: 30px; font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 15px; transition: color 0.3s; }
        .chapter-body { line-height: 1.8; font-size: 18px; }
        .chapter-body p { margin-bottom: 1.2em; }
        .chapter-body blockquote { border-left: 4px solid var(--accent); padding-left: 1rem; margin-left: 0; font-style: italic; opacity: 0.85; }
        .chapter-body hr { border: 0; border-top: 1px solid var(--border); margin: 3em 0; }
        .box { border: 1px solid var(--border); background-color: var(--box-bg); border-radius: 8px; padding: 16px; margin: 24px 0; }
        .box p:last-child { margin-bottom: 0; }

        /* Index View */
        .index-view { display: none; }
        .section-title { font-size: 1.2em; border-bottom: 2px solid var(--accent); padding-bottom: 5px; margin-bottom: 10px; color: var(--accent); margin-top: 2em; }
        .index-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 30px;}
        .index-item { padding: 16px 20px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 16px; transition: background 0.2s;}
        .index-item:last-child { border-bottom: none; }
        .index-item:hover { background: var(--btn-hover); }
        .index-item.active { font-weight: bold; color: var(--accent); background: var(--btn-hover); border-left: 4px solid var(--accent); padding-left: 16px;}

        @media (max-width: 500px) {
            .toolbar { flex-direction: column-reverse; padding: 12px 15px; }
            .toolbar-group { width: 100%; justify-content: space-between; }
            button { flex: 1; justify-content: center; }
            .content-area { padding: 40px 15px 40px 15px; }
            .bottom-nav { padding: 20px 15px 40px 15px; gap: 10px; }
        }
        </style>
        </head>
        <body>
        <div class="container">
        <div class="toolbar">
        <div class="toolbar-group">
        <button id="btn-prev">◀ Prev</button>
        <button id="btn-index" style="color: var(--accent);" title="Hold to toggle Raws">📑 Index</button>
        <button id="btn-next">Next ▶</button>
        </div>
        <div class="toolbar-group">
        <button id="btn-font-dec" title="Decrease Font">A-</button>
        <button id="btn-font-inc" title="Increase Font">A+</button>
        <button id="btn-theme" title="Toggle Theme">🌙</button>
        </div>
        </div>

        <div class="content-area" id="content-area">
        <div id="reader-view">
        <h1 id="chapter-title" class="chapter-title"></h1>
        <div id="chapter-body" class="chapter-body"></div>
        </div>

        <div id="index-view" class="index-view">
        <h1 class="chapter-title" style="border:none;">Table of Contents</h1>
        <p id="random-tip" style="text-align:center; color:#888; font-size:14px; margin-top:-20px; padding: 0 10px;"></p>

        <h3 class="section-title" id="trans-header">Translated</h3>
        <ul id="index-list-trans" class="index-list"></ul>

        <h3 class="section-title" id="raw-header" style="display:none; color: var(--raw); border-color: var(--raw);">Raws</h3>
        <ul id="index-list-raw" class="index-list" style="display: none;"></ul>
        </div>
        </div>

        <div id="bottom-nav" class="bottom-nav">
        <button id="btn-prev-btm">◀ Previous</button>
        <button id="btn-next-btm">Next ▶</button>
        </div>
        </div>

        <script>
        const chapters = ${chaptersJSON};
        const BOOK_ID = "${safeBookId}";
        let currentIndex = 0;
        let fontSize = 18;
        let isIndexView = false;
        let isShowingRaw = false;

        const tips = [
            "Hold the Index button for 0.5s to instantly toggle between Translation & Raw.",
 "Double-tap anywhere on the text to hide the reading UI for full immersion.",
 "Hold the Previous button to instantly jump to the top of the chapter.",
 "Hold the Next button to instantly jump to the bottom of the chapter."
        ];

        const els = {
            title: document.getElementById('chapter-title'),
 body: document.getElementById('chapter-body'),
 contentArea: document.getElementById('content-area'),
 indexListTrans: document.getElementById('index-list-trans'),
 indexListRaw: document.getElementById('index-list-raw'),
 rawHeader: document.getElementById('raw-header'),
 tip: document.getElementById('random-tip'),
 btnPrev: document.getElementById('btn-prev'),
 btnNext: document.getElementById('btn-next'),
 btnPrevBtm: document.getElementById('btn-prev-btm'),
 btnNextBtm: document.getElementById('btn-next-btm'),
 btnIndex: document.getElementById('btn-index'),
 btnFontDec: document.getElementById('btn-font-dec'),
 btnFontInc: document.getElementById('btn-font-inc'),
 btnTheme: document.getElementById('btn-theme')
        };

        let scrollMap = JSON.parse(localStorage.getItem('ro_scroll_' + BOOK_ID) || '{}');

        // Throttled Scroll Saver
        let scrollTimeout;
        window.addEventListener('scroll', () => {
            if (isIndexView) return;
            if (!scrollTimeout) {
                scrollTimeout = setTimeout(() => {
                    scrollMap[currentIndex + '_' + isShowingRaw] = window.scrollY;
                    localStorage.setItem('ro_scroll_' + BOOK_ID, JSON.stringify(scrollMap));
                    scrollTimeout = null;
                }, 150);
            }
        });

        // Double Tap to toggle top UI only
        let lastClick = 0;
        els.contentArea.addEventListener('click', function(e) {
            if (isIndexView) return;
            if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
            let currentTime = new Date().getTime();
            let tapLength = currentTime - lastClick;
            if (tapLength < 300 && tapLength > 0) {
                document.body.classList.toggle('hide-ui');
                e.preventDefault();
            }
            lastClick = currentTime;
        });

        function updateTip() {
            if(els.tip) els.tip.textContent = "(Tip: " + tips[Math.floor(Math.random() * tips.length)] + ")";
        }

        function renderChapter(index, showRaw) {
            if (index < 0 || index >= chapters.length) return;

            if (!isIndexView) {
                scrollMap[currentIndex + '_' + isShowingRaw] = window.scrollY;
                localStorage.setItem('ro_scroll_' + BOOK_ID, JSON.stringify(scrollMap));
            }

            currentIndex = index;
            isShowingRaw = showRaw;
            const chapter = chapters[currentIndex];

            els.title.textContent = showRaw ? chapter.title + ' (Raw)' : chapter.title;
            els.body.innerHTML = showRaw ? chapter.rawContent : chapter.content;

            els.btnPrev.disabled = currentIndex === 0;
            els.btnPrevBtm.disabled = currentIndex === 0;
            els.btnNext.disabled = currentIndex === chapters.length - 1;
            els.btnNextBtm.disabled = currentIndex === chapters.length - 1;
            els.title.style.color = showRaw ? 'var(--raw)' : '';

            // Restore Scroll Position
            const targetScroll = scrollMap[currentIndex + '_' + isShowingRaw] || 0;
            setTimeout(() => { window.scrollTo(0, targetScroll); }, 30);

            localStorage.setItem('ro_progress_' + BOOK_ID, currentIndex + '_' + isShowingRaw);
            if(isIndexView) populateIndex();
        }

        function populateIndex() {
            els.indexListTrans.innerHTML = '';
            chapters.forEach((chap, idx) => {
                const li = document.createElement('li');
                li.className = 'index-item' + (idx === currentIndex && !isShowingRaw ? ' active' : '');
                li.textContent = chap.title;
                li.onclick = () => { toggleIndex(); renderChapter(idx, false); };
                els.indexListTrans.appendChild(li);
            });

            const hasRaws = chapters.some(c => c.rawContent);
            if (hasRaws) {
                els.rawHeader.style.display = 'block';
                els.indexListRaw.style.display = 'block';
                els.indexListRaw.innerHTML = '';
                chapters.forEach((chap, idx) => {
                    if (!chap.rawContent) return;
                    const li = document.createElement('li');
                    li.className = 'index-item' + (idx === currentIndex && isShowingRaw ? ' active' : '');
                    li.textContent = chap.title + ' (Raw)';
                    if (idx === currentIndex && isShowingRaw) {
                        li.style.color = 'var(--raw)';
                        li.style.borderLeftColor = 'var(--raw)';
                    }
                    li.onclick = () => { toggleIndex(); renderChapter(idx, true); };
                    els.indexListRaw.appendChild(li);
                });
            }
        }

        function toggleIndex() {
            isIndexView = !isIndexView;
            if (isIndexView) {
                updateTip();
                document.body.classList.add('index-active');
                populateIndex();
                setTimeout(() => {
                    const activeEl = document.querySelector('.index-view .active');
                    if (activeEl) activeEl.scrollIntoView({ block: 'center' });
                }, 50);
            } else {
                document.body.classList.remove('index-active');
                window.scrollTo(0, scrollMap[currentIndex + '_' + isShowingRaw] || 0);
            }
        }

        function toggleTheme() {
            document.body.classList.toggle('dark-mode');
            const isDark = document.body.classList.contains('dark-mode');
            els.btnTheme.textContent = isDark ? '☀️' : '🌙';
            localStorage.setItem('ro_theme', isDark ? 'dark' : 'light');
        }

        function changeFontSize(delta) {
            if (isIndexView) return;
            const oldScroll = window.scrollY;
            const oldHeight = document.documentElement.scrollHeight || 1;

            fontSize += delta;
            if (fontSize < 12) fontSize = 12;
            if (fontSize > 36) fontSize = 36;
            els.body.style.fontSize = fontSize + 'px';
            localStorage.setItem('ro_fontsize', fontSize);

            setTimeout(() => {
                const newHeight = document.documentElement.scrollHeight;
                window.scrollTo(0, oldScroll * (newHeight / oldHeight));
            }, 10);
        }

        // --- ADVANCED BUTTON LOGIC (HOLD DETECTION) ---
        function setupHoldButton(btn, onClick, onHold) {
            if (!btn) return;
            let pressTimer;
            let startY = 0;
            let isLongPress = false;
            let isDragging = false;

            btn.addEventListener('pointerdown', (e) => {
                if (btn.disabled) return;
                startY = e.clientY;
                isLongPress = false;
                isDragging = false;
                btn.setPointerCapture(e.pointerId);
                pressTimer = setTimeout(() => {
                    isLongPress = true;
                    onHold();
                }, 500);
            });

            btn.addEventListener('pointermove', (e) => {
                if (Math.abs(e.clientY - startY) > 15) {
                    isDragging = true;
                    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                }
            });

            btn.addEventListener('pointerup', (e) => {
                if (btn.disabled) return;
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                btn.releasePointerCapture(e.pointerId);
                if (!isLongPress && !isDragging) {
                    onClick();
                }
            });

            btn.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
        }

        const goPrev = () => renderChapter(currentIndex - 1, isShowingRaw);
        const goNext = () => renderChapter(currentIndex + 1, isShowingRaw);
        const goTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
        const goBottom = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

        setupHoldButton(els.btnPrev, goPrev, goTop);
        setupHoldButton(els.btnPrevBtm, goPrev, goTop);
        setupHoldButton(els.btnNext, goNext, goBottom);
        setupHoldButton(els.btnNextBtm, goNext, goBottom);

        setupHoldButton(els.btnIndex, toggleIndex, () => {
            const chap = chapters[currentIndex];
            if (chap && chap.rawContent) {
                if (isIndexView) toggleIndex();
                renderChapter(currentIndex, !isShowingRaw);
            }
        });

        els.btnTheme.onclick = toggleTheme;
        els.btnFontInc.onclick = () => changeFontSize(2);
        els.btnFontDec.onclick = () => changeFontSize(-2);

        // Boot
        const savedTheme = localStorage.getItem('ro_theme');
        if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            toggleTheme();
        }
        const savedSize = localStorage.getItem('ro_fontsize');
        if (savedSize) {
            fontSize = parseInt(savedSize, 10);
            els.body.style.fontSize = fontSize + 'px';
        }

        const savedProgress = localStorage.getItem('ro_progress_' + BOOK_ID);
        if (savedProgress) {
            const [idxStr, rawStr] = savedProgress.split('_');
            renderChapter(parseInt(idxStr, 10), rawStr === 'true');
        } else {
            renderChapter(0, false);
        }
        </script>
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
                if (el.closest('a') || el.closest('button')) return; // Ignore interactive UI

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

        let manifest = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n`;
        let spine = ``;
        let navMap = ``;
        let playOrder = 1;

        if (mode === 'tl' || mode === 'combined') {
            for (let i = 0; i < reversedFiles.length; i++) {
                const file = reversedFiles[i];
                const fileNum = String(i + 1).padStart(3, '0');
                const chapterId = `chapter_trans_${fileNum}`;
                const chapterFilename = `Text/${chapterId}.html`;

                const safeTitle = escapeXml(`[${String(i + 1).padStart(2, '0')}] ${file.rawTitle}`);
                const safeContent = file.content.replace(/<br\s*\/?>/gi, '<br/>').replace(/<hr\s*\/?>/gi, '<hr/>');

                const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${safeTitle}</title>\n<style>body { font-family: sans-serif; line-height: 1.6; padding: 2% 5%; } h1 { text-align: center; margin-bottom: 1.5em; font-size: 1.5em; } p { margin-bottom: 1em; } blockquote { border-left: 3px solid #ccc; padding-left: 1em; margin-left: 0; font-style: italic; } .box { border: 1px solid #ccc; background-color: #f9f9f9; border-radius: 6px; padding: 1em; margin: 1.5em 0; } .box p:last-child { margin-bottom: 0; }</style>\n</head>\n<body>\n<h1>${safeTitle}</h1>\n${safeContent}\n</body>\n</html>`;

                await zipWriter.add(`OEBPS/${chapterFilename}`, new zip.TextReader(chapterHtml));
                manifest += `<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${chapterId}"/>\n`;
                navMap += `<navPoint id="navPoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${safeTitle}</text></navLabel><content src="${chapterFilename}"/></navPoint>\n`;
                playOrder++;
            }
        }

        if (mode === 'raw' || mode === 'combined') {
            for (let i = 0; i < reversedFiles.length; i++) {
                const file = reversedFiles[i];
                if (!file.rawContent) continue;

                const fileNum = String(i + 1).padStart(3, '0');
                const chapterId = `chapter_raw_${fileNum}`;
                const chapterFilename = `Text/${chapterId}.html`;

                const safeTitle = escapeXml(`[${String(i + 1).padStart(2, '0')}] ${file.rawTitle} - Raw`);
                const safeContent = file.rawContent.replace(/<br\s*\/?>/gi, '<br/>').replace(/<hr\s*\/?>/gi, '<hr/>');

                const chapterHtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${safeTitle}</title>\n<style>body { font-family: sans-serif; line-height: 1.6; padding: 2% 5%; } h1 { text-align: center; margin-bottom: 1.5em; font-size: 1.5em; color: #555; } p { margin-bottom: 1em; } .box { border: 1px solid #ccc; background-color: #f9f9f9; border-radius: 6px; padding: 1em; margin: 1.5em 0; } .box p:last-child { margin-bottom: 0; }</style>\n</head>\n<body>\n<h1>${safeTitle}</h1>\n${safeContent}\n</body>\n</html>`;

                await zipWriter.add(`OEBPS/${chapterFilename}`, new zip.TextReader(chapterHtml));
                manifest += `<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>\n`;
                spine += `<itemref idref="${chapterId}"/>\n`;
                navMap += `<navPoint id="navPoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${safeTitle}</text></navLabel><content src="${chapterFilename}"/></navPoint>\n`;
                playOrder++;
            }
        }

        const opfXml = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n<dc:title>${escapeXml(title)}</dc:title>\n<dc:language>en</dc:language>\n<dc:identifier id="BookId">${uuid}</dc:identifier>\n</metadata>\n<manifest>\n${manifest}</manifest>\n<spine toc="ncx">\n${spine}</spine>\n</package>`;
        await zipWriter.add("OEBPS/content.opf", new zip.TextReader(opfXml));

        const ncxXml = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n<head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n<docTitle><text>${escapeXml(title)}</text></docTitle>\n<navMap>\n${navMap}</navMap>\n</ncx>`;
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

        if (dl.merged) {
            html += `<a href="${dl.merged.url}" download="${dl.merged.name}" style="display: block; padding: 12px 30px; background-color: #3b82f6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; width: 80%; text-align: center; max-width: 350px;">📱 Save Webnovel App (.html)</a>`;
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
            const logContent = "--- READOMNI DEBUG LOG v20.4 ---\n" + navigator.userAgent + "\n\n" + state.logs.join('\n');
            dl.log = { url: URL.createObjectURL(new Blob([logContent], { type: 'text/plain' })), name: `readomni_debug_${new Date().getTime()}.txt` };
        }

        if (!state.files || state.files.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : []);
            return;
        }

        let reversedFiles = [...state.files].reverse();

        // Custom filter: check if the first chronologically scraped chapter is the placeholder "第99887章 “牌位”"
        if (reversedFiles.length > 0) {
            const firstChap = reversedFiles[0];
            const rawCheckString = (firstChap.rawTitle || "") + " " + (firstChap.rawContent || "");
            if (rawCheckString.includes("第99887章") && rawCheckString.includes("牌位")) {
                logDebug(state, "Found ignore-flagged placeholder chapter '第99887章 “牌位”' as [01]. Removing and renumbering.");
                reversedFiles.shift(); // Remove the chapter, automatically renumbering the rest.
            }
        }

        if (reversedFiles.length === 0) {
            showFinalScreen(dl, state.threadUrl, dl.log ? [dl.log.url] : []);
            return;
        }

        const hasRaws = reversedFiles.some(f => f.rawContent);

        // --- WEBNOVEL HTML GENERATION ---
        try {
            let webnovelChapters = reversedFiles.map((f, i) => {
                const fileNum = String(i + 1).padStart(2, '0');
                return {
                    title: `[${fileNum}] ${f.rawTitle}`,
                    content: f.content,
                    rawContent: f.rawContent || null
                };
            });
            let fullMergedHTML = generateWebnovelHTML(state.threadName, webnovelChapters);
            dl.merged = { url: URL.createObjectURL(new Blob([fullMergedHTML], { type: 'text/html' })), name: `${state.threadName}_Reader_${dateStr}.html` };
        } catch (e) {
            logDebug(state, `Merged HTML Error: ${e.message}`);
        }

        // --- EPUB GENERATION ---
        if (typeof zip !== 'undefined') {
            try {
                dl.epubTl = { url: URL.createObjectURL(await generateEpubBlob(state, reversedFiles, 'tl')), name: `${state.threadName}_TL_${dateStr}.epub` };
                if (hasRaws) {
                    dl.epubRaw = { url: URL.createObjectURL(await generateEpubBlob(state, reversedFiles, 'raw')), name: `${state.threadName}_RAW_${dateStr}.epub` };
                    dl.epubCombined = { url: URL.createObjectURL(await generateEpubBlob(state, reversedFiles, 'combined')), name: `${state.threadName}_Combined_${dateStr}.epub` };
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

                for (let i = 0; i < reversedFiles.length; i++) {
                    const file = reversedFiles[i];
                    const fileNum = String(i + 1).padStart(2, '0');
                    const newTitle = `[${fileNum}] ${file.rawTitle}`;
                    // Replace illegal characters specifically for the ZIP file paths
                    const safeFilename = newTitle.replace(/[\/\\?%*:|"<>]/g, '_');

                    let singleFileHTML = generateFullHTML(newTitle, file.content);
                    await zipWriter.add(`Translated/${safeFilename}.html`, new zip.TextReader(singleFileHTML));

                    if (file.rawContent) {
                        let rawFileHTML = generateFullHTML(`${newTitle} - Raw`, file.rawContent);
                        await zipWriter.add(`Raw/${safeFilename} - Raw.html`, new zip.TextReader(rawFileHTML));
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
            if (!localStorage.getItem(STATE_KEY)) return;

            logDebug(state, `Processing chapter #${state.count}`);
            showCancelButton(state.count);

            await sleep(400);

            const h1 = await waitForElement('h1');
            const prevBtn = await waitForElement('[aria-label="Previous chapter"]');

            if (!h1) {
                logDebug(state, "ERROR: Missing H1 tag. Halting.");
                state.active = false;
                await prepareDownloads(state);
                return;
            }

            // Get pure title exactly as it appears
            let rawTitleText = h1.textContent.trim();
            if (!rawTitleText) rawTitleText = 'Untitled';

            // Extract Translated
            let translatedTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.includes('Translated'));
            if (translatedTab && translatedTab.getAttribute('aria-selected') !== 'true') {
                fireOmniClick(translatedTab);
                await sleep(300);
            }
            let extractedHTMLBlocks = extractChapterHTMLBlocks();

            // Always Attempt to Extract Raw (Without prompt)
            let rawHTMLBlocks = null;
            let rawTab = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.includes('Raw'));
            if (rawTab) {
                if (rawTab.getAttribute('aria-selected') !== 'true') {
                    fireOmniClick(rawTab);
                    await sleep(400);
                }
                rawHTMLBlocks = extractChapterHTMLBlocks();
            }
            if (translatedTab) {
                fireOmniClick(translatedTab);
                await sleep(200);
            }

            if (extractedHTMLBlocks && extractedHTMLBlocks.length > 0) {
                state.retryCount = 0;
                state.files.push({
                    rawTitle: rawTitleText,
                    content: extractedHTMLBlocks,
                    rawContent: rawHTMLBlocks
                });
                logDebug(state, `Collected: ${rawTitleText} (Trans: ${extractedHTMLBlocks.length}, Raw: ${rawHTMLBlocks ? rawHTMLBlocks.length : 0})`);
            } else {
                logDebug(state, `WARNING: Extracted HTML was empty for ${rawTitleText}`);
                if (!state.retryCount) state.retryCount = 0;

                if (state.retryCount < 1) {
                    state.retryCount++;
                    localStorage.setItem(STATE_KEY, JSON.stringify(state));
                    logDebug(state, "Retrying chapter... Forcing hard reload.");
                    window.location.reload();
                    return;
                } else {
                    logDebug(state, "Retry failed. Moving on to prevent infinite loop.");
                    state.retryCount = 0;
                }
            }

            if (!prevBtn || prevBtn.hasAttribute('disabled') || prevBtn.tagName.toLowerCase() === 'button') {
                logDebug(state, "Reached the end of the chapter sequence.");
                state.active = false;
                await prepareDownloads(state);
                return;
            }

            state.count++;
            try {
                localStorage.setItem(STATE_KEY, JSON.stringify(state));
            } catch (e) {
                logDebug(state, "Storage limit hit. Generating early ZIP.");
                state.active = false;
                await prepareDownloads(state);
                return;
            }

            logDebug(state, "Navigating backward...");
            fireOmniClick(prevBtn);

            let contentChanged = false;
            // Shorter 4.5s watchdog for snappier hard refresh detection
            for (let i = 0; i < 45; i++) {
                await sleep(100);
                if (!localStorage.getItem(STATE_KEY)) return;

                const checkH1 = document.querySelector('h1');
                if (checkH1) {
                    let checkTitle = checkH1.textContent.trim();
                    if (!checkTitle) checkTitle = 'Untitled';
                    if (checkTitle !== rawTitleText) {
                        contentChanged = true;
                        break;
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

    function startBulkDownload() {
        const firstLink = document.querySelector('a[href*="/translation/"]');
        const threadH1 = document.querySelector('h1');

        if (!firstLink) return alert("Could not find any chapters to start with!");

        const confirmDownload = confirm("Start automated downloading?\n\nNote: You can cancel mid-way to package whatever has been collected.");
        if (!confirmDownload) return;

        const runId = Date.now().toString();
        sessionStorage.setItem(LOCK_KEY, runId);

        const state = {
            active: true,
            runId: runId,
            threadUrl: window.location.href,
            threadName: threadH1 && threadH1.textContent ? threadH1.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '_') : 'ReadOmni_Thread',
 count: 1,
 retryCount: 0,
 files: [],
 logs: []
        };

        logDebug(state, `--- NEW RUN INITIALIZED (V20.4) Auto-Extracting Raws ---`);
        localStorage.setItem(STATE_KEY, JSON.stringify(state));

        const runUrl = new URL(firstLink.href, window.location.origin);
        runUrl.searchParams.set('ro_start_download', 'true');
        window.location.href = runUrl.toString();
    }

    async function cancelDownload() {
        const stateStr = localStorage.getItem(STATE_KEY);
        if (stateStr) {
            const state = JSON.parse(stateStr);
            logDebug(state, "User clicked Cancel. Triggering early extraction.");
            state.active = false;
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
        btn.onclick = startBulkDownload;
        document.body.appendChild(btn);
    }

    // --- SPA WATCHER ---
    let processActive = false;
    setInterval(() => {
        // SPA Routing Handler
        const isThreadPage = window.location.pathname.includes('/thread/');
        const btnExists = document.getElementById('ro-bulk-btn');

        if (isThreadPage && !btnExists) injectStartButton();
        else if (!isThreadPage && btnExists) btnExists.remove();

        // Handshake Check
        if (window.location.search.includes('ro_start_download=true')) {
            sessionStorage.setItem(LOCK_KEY, 'locked');
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('ro_start_download');
            window.history.replaceState(null, '', cleanUrl.toString());
        }

        // Trigger Queue
        const isTranslation = window.location.pathname.includes('/translation/');
        const stateStr = localStorage.getItem(STATE_KEY);
        const isLockedTab = sessionStorage.getItem(LOCK_KEY) === 'locked';

        if (isTranslation && stateStr && isLockedTab && !processActive && !isPreparing) {
            processActive = true;
            processQueue().finally(() => { processActive = false; });
        }
    }, 1000);

})();
