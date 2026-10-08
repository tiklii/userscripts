// ==UserScript==
// @name         Sudugu Chapter Downloader
// @namespace    https://github.com/tiklii/usersripts
// @version      1.6
// @description  Downloads complete novel chapters on suduguu.com using fast iframe rendering with seamless part transitions.
// @author       tiklii
// @match        *://*.suduguu.com/*/*.html
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // 1. Identify URL structure: e.g. /5/4664974.html or /53/4661428-2.html
    const pathRegex = /^\/(\d+)\/(\d+)(?:-(\d+))?\.html$/;
    const currentPath = window.location.pathname;
    const match = currentPath.match(pathRegex);

    if (!match) return;

    const bookId = match[1];
    const chapterId = match[2]; // Base chapter ID

    /**
     * Extracts raw novel name and chapter title without stripping any text characters.
     */
    function getMetaInfo() {
        let novelName = '';
        let chapterTitle = '';

        const submenuH1 = document.querySelector('.submenu h1');
        if (submenuH1) {
            const novelLink = submenuH1.querySelector('a');
            if (novelLink) {
                novelName = novelLink.textContent.trim();
            }
            const clone = submenuH1.cloneNode(true);
            const linkInClone = clone.querySelector('a');
            if (linkInClone) linkInClone.remove();
            chapterTitle = clone.textContent.replace(/^[\s>▷»—]+/, '').trim();
        }

        if (!novelName || !chapterTitle) {
            const titleFirstPart = document.title.split('-')[0].trim();
            if (novelName && !chapterTitle && titleFirstPart.startsWith(novelName)) {
                chapterTitle = titleFirstPart.slice(novelName.length).trim();
            } else if (!novelName && !chapterTitle) {
                const parts = titleFirstPart.split(/\s+/);
                if (parts.length >= 2) {
                    novelName = parts[0].trim();
                    chapterTitle = parts.slice(1).join(' ').trim();
                } else {
                    chapterTitle = titleFirstPart;
                }
            }
        }

        return {
            novelName: novelName || '未知书名',
            chapterTitle: chapterTitle || '未知章节'
        };
    }

    /**
     * Only sanitize characters when generating the file name on disk.
     */
    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|\r\n\t]+/g, '').trim();
    }

    /**
     * Extracts raw text paragraphs from the .con container.
     */
    function extractTextFromDoc(doc) {
        if (!doc) return [];
        const con = doc.querySelector('.con');
        if (!con) return [];

        const clone = con.cloneNode(true);
        clone.querySelectorAll('script, style, .sf-hidden').forEach(el => el.remove());

        const paragraphs = [];
        const pTags = clone.querySelectorAll('p');

        if (pTags.length > 0) {
            pTags.forEach(p => {
                p.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                const text = p.textContent.replace(/[\r\n]+$/, '');
                paragraphs.push(text);
            });
        } else {
            clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
            const lines = clone.textContent.split('\n');
            lines.forEach(line => {
                paragraphs.push(line.replace(/[\r\n]+$/, ''));
            });
        }

        return paragraphs;
    }

    /**
     * Inspects pagination to find the next sub-page belonging to the same chapter.
     */
    function getNextSubPageUrl(doc, currentUrl) {
        if (!doc) return null;
        const nextLinks = Array.from(doc.querySelectorAll('.prenext a, a'));
        const nextBtn = nextLinks.find(a => a.textContent.includes('下一页'));

        if (!nextBtn) return null;

        const href = nextBtn.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) return null;

        const resolvedUrl = new URL(href, currentUrl || doc.baseURI || window.location.href);

        // Subpages match: /<chapterId>-<pageNumber>.html
        const subPagePattern = new RegExp(`\\/${chapterId}-\\d+\\.html$`, 'i');
        if (subPagePattern.test(resolvedUrl.pathname)) {
            return resolvedUrl.href;
        }

        return null;
    }

    // Hidden iframe loader to execute client-side decryption scripts
    let hiddenIframe = null;

    function getIframe() {
        if (!hiddenIframe) {
            hiddenIframe = document.createElement('iframe');
            Object.assign(hiddenIframe.style, {
                width: '0px',
                height: '0px',
                border: 'none',
                position: 'fixed',
                bottom: '-9999px',
                visibility: 'hidden'
            });
            document.body.appendChild(hiddenIframe);
        }
        return hiddenIframe;
    }

    function destroyIframe() {
        if (hiddenIframe && hiddenIframe.parentNode) {
            hiddenIframe.parentNode.removeChild(hiddenIframe);
            hiddenIframe = null;
        }
    }

    /**
     * Loads a sub-page via iframe with fast 50ms polling
     */
    function loadPageViaIframe(url) {
        return new Promise((resolve, reject) => {
            const iframe = getIframe();
            let timeoutTimer = null;
            let pollTimer = null;

            const cleanup = () => {
                if (timeoutTimer) clearTimeout(timeoutTimer);
                if (pollTimer) clearInterval(pollTimer);
            };

            timeoutTimer = setTimeout(() => {
                cleanup();
                try {
                    resolve(iframe.contentDocument || iframe.contentWindow.document);
                } catch (e) {
                    reject(new Error(`Timeout loading: ${url}`));
                }
            }, 6000);

            iframe.onload = () => {
                let attempts = 0;
                pollTimer = setInterval(() => {
                    attempts++;
                    try {
                        const doc = iframe.contentDocument || iframe.contentWindow.document;
                        if (doc) {
                            const con = doc.querySelector('.con');
                            // Check if content has been injected into .con
                            const hasContent = con && (con.querySelectorAll('p').length > 0 || con.textContent.trim().length > 30);
                            if (hasContent || attempts >= 25) { // 25 * 50ms = 1.25s max after load
                                cleanup();
                                resolve(doc);
                            }
                        }
                    } catch (e) {
                        cleanup();
                        reject(e);
                    }
                }, 50);
            };

            iframe.src = url;
        });
    }

    /**
     * Triggers file download with UTF-8 BOM
     */
    function triggerDownload(content, filename) {
        const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Crawls and concatenates all pages of the chapter
     */
    async function downloadChapter(btn) {
        btn.disabled = true;
        const originalText = btn.textContent;

        try {
            const { novelName, chapterTitle } = getMetaInfo();
            const allParagraphs = [];

            let currentDoc;
            let currentUrl = window.location.href;

            // 1. If currently on a subpage (e.g., -2.html), fetch part 1 first
            if (currentPath.includes('-')) {
                const baseChapterUrl = `${window.location.origin}/${bookId}/${chapterId}.html`;
                btn.textContent = '获取第 1 页...';
                currentDoc = await loadPageViaIframe(baseChapterUrl);
                currentUrl = baseChapterUrl;
            } else {
                currentDoc = document;
            }

            // Extract part 1
            const part1 = extractTextFromDoc(currentDoc);
            // Trim boundary trailing empty tags (e.g. <p></p> at the bottom of part 1)
            while (part1.length > 0 && part1[part1.length - 1].trim() === '') {
                part1.pop();
            }
            allParagraphs.push(...part1);

            let pageCount = 1;
            btn.textContent = `解析中 (第 ${pageCount} 页)...`;

            // 2. Loop through all subsequent sub-pages via iframe
            let nextUrl = getNextSubPageUrl(currentDoc, currentUrl);
            while (nextUrl) {
                pageCount++;
                btn.textContent = `下载中 (第 ${pageCount} 页)...`;
                const doc = await loadPageViaIframe(nextUrl);
                const part = extractTextFromDoc(doc);

                // Trim boundary leading empty tags
                while (part.length > 0 && part[0].trim() === '') {
                    part.shift();
                }
                // Trim boundary trailing empty tags
                while (part.length > 0 && part[part.length - 1].trim() === '') {
                    part.pop();
                }

                allParagraphs.push(...part);
                currentDoc = doc;
                currentUrl = nextUrl;
                nextUrl = getNextSubPageUrl(currentDoc, currentUrl);
            }

            // Cleanup hidden iframe
            destroyIframe();

            // 3. Remove duplicate title if it appears as the first paragraph
            if (
                allParagraphs.length > 0 &&
                allParagraphs[0].trim().replace(/\s+/g, ' ') === chapterTitle.trim().replace(/\s+/g, ' ')
            ) {
                allParagraphs.shift();
            }

            // Ensure strictly ONE blank line between the chapter title and the start of the body text
            while (allParagraphs.length > 0 && allParagraphs[0].trim() === '') {
                allParagraphs.shift();
            }

            // Remove any trailing empty lines at the very end of the file
            while (allParagraphs.length > 0 && allParagraphs[allParagraphs.length - 1].trim() === '') {
                allParagraphs.pop();
            }

            // 4. Build text content: exactly 1 blank line after title and between connected parts
            const fileText = [
                chapterTitle,
                ...allParagraphs
            ].join('\n\n');

            // 5. Sanitize only when creating the filename
            const safeNovelName = sanitizeFilename(novelName);
            const safeChapterTitle = sanitizeFilename(chapterTitle);
            const filename = `${safeNovelName} _ ${safeChapterTitle} (sudugu).txt`;

            triggerDownload(fileText, filename);
            btn.textContent = '下载完成！';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2500);

        } catch (err) {
            destroyIframe();
            console.error('[Sudugu Downloader Error]:', err);
            alert('下载失败，请查看控制台输出');
            btn.textContent = '下载出错';
            btn.disabled = false;
        }
    }

    /**
     * Inject Download Button into the UI
     */
    function initUI() {
        const btn = document.createElement('button');
        btn.id = 'novel-download-btn';
        btn.textContent = '📥 下载本章 TXT';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '80px',
            right: '25px',
            zIndex: '999999',
            padding: '10px 16px',
            backgroundColor: '#50012d',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            transition: 'background-color 0.2s, transform 0.1s'
        });

        btn.onmouseover = () => { btn.style.backgroundColor = '#6f023f'; };
        btn.onmouseout = () => { btn.style.backgroundColor = '#50012d'; };
        btn.onmousedown = () => { btn.style.transform = 'scale(0.96)'; };
        btn.onmouseup = () => { btn.style.transform = 'scale(1)'; };

        btn.addEventListener('click', () => downloadChapter(btn));
        document.body.appendChild(btn);
    }

    initUI();
})();
