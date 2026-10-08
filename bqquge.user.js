// ==UserScript==
// @name         Bqquge Chapter Downloader
// @namespace    https://github.com/tiklii/usercripts
// @version      1.4
// @description  Downloads complete novel chapters on bqquge preserving raw indentation and empty lines as-is.
// @author       tiklii
// @match        *://*.bqquge.com/*/*
// @match        *://*.bqquge.org/*/*
// @grant        GM_xmlhttpRequest
// @connect      bqquge.com
// @connect      bqquge.org
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // 1. Identify URL structure: e.g. /5/4089119 or /5/4089119-2
    const pathRegex = /^\/(\d+)\/(\d+)(?:-(\d+))?(?:\.html)?$/;
    const currentPath = window.location.pathname;
    const match = currentPath.match(pathRegex);

    // If not on a chapter page (e.g. index/directory page), exit
    if (!match) return;

    const bookId = match[1];
    const chapterId = match[2]; // Base chapter ID

    /**
     * Extracts raw novel name and chapter title without stripping any characters.
     */
    function getMetaInfo() {
        let novelName = '';
        let chapterTitle = '';

        // Try extracting from breadcrumbs (.menu)
        // Format: 首页 ▷ 仙侠 ▷ 玄鉴仙族 ▷ 第1614章 宫寺
        const menuLinks = document.querySelectorAll('.menu a');
        if (menuLinks.length >= 3) {
            novelName = menuLinks[menuLinks.length - 1].textContent.trim();
        }

        const h1 = document.querySelector('.con h1');
        if (h1) {
            chapterTitle = h1.textContent.trim();
        }

        // Fallback to <title> tag if breadcrumbs are missing:
        if (!novelName || !chapterTitle) {
            const titleParts = document.title.split('-');
            if (titleParts.length >= 2) {
                chapterTitle = chapterTitle || titleParts[0].trim();
                novelName = novelName || titleParts[1].trim();
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
     * Extracts raw text paragraphs from the .con container without stripping indentation.
     */
    function extractTextFromDoc(doc) {
        const con = doc.querySelector('.con');
        if (!con) return [];

        // Replace <br> tags with newline characters in case any exist
        con.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

        const paragraphs = [];
        const pTags = con.querySelectorAll('p');

        pTags.forEach(p => {
            // Remove trailing newlines/returns, but preserve leading indentation & empty lines
            const text = p.textContent.replace(/[\r\n]+$/, '');
            paragraphs.push(text);
        });

        return paragraphs;
    }

    /**
     * Inspects the pagination link to see if there is another sub-page
     * belonging to the current chapter.
     */
    function getNextSubPageUrl(doc) {
        const nextLinks = Array.from(doc.querySelectorAll('.prenext a'));
        const nextBtn = nextLinks.find(a => a.textContent.includes('下一页'));

        if (!nextBtn) return null;

        const nextUrl = nextBtn.getAttribute('href');
        if (!nextUrl) return null;

        // Check if next URL belongs to this chapter (e.g. /<bookId>/<chapterId>-<part>)
        const subPageRegex = new RegExp(`^https?:\\/\\/[^\\/]+\\/${bookId}\\/${chapterId}-\\d+`);
        const relativeSubPageRegex = new RegExp(`^\\/${bookId}\\/${chapterId}-\\d+`);

        if (subPageRegex.test(nextUrl) || relativeSubPageRegex.test(nextUrl)) {
            return new URL(nextUrl, window.location.origin).href;
        }

        return null;
    }

    /**
     * Fetches HTML content via GM_xmlhttpRequest
     */
    function fetchPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'User-Agent': navigator.userAgent
                },
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(res.responseText, 'text/html');
                        resolve(doc);
                    } else {
                        reject(new Error(`Failed to load: ${url} (status: ${res.status})`));
                    }
                },
                onerror: (err) => reject(err)
            });
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

            // 1. If currently not on part 1, fetch base URL first
            const baseChapterUrl = `${window.location.origin}/${bookId}/${chapterId}`;
            let currentDoc;

            if (currentPath.includes('-')) {
                btn.textContent = '获取第 1 页...';
                currentDoc = await fetchPage(baseChapterUrl);
            } else {
                currentDoc = document;
            }

            let pageCount = 1;
            btn.textContent = `解析中 (第 ${pageCount} 页)...`;
            allParagraphs.push(...extractTextFromDoc(currentDoc));

            // 2. Loop through all subsequent sub-pages
            let nextUrl = getNextSubPageUrl(currentDoc);
            while (nextUrl) {
                pageCount++;
                btn.textContent = `下载中 (第 ${pageCount} 页)...`;
                const doc = await fetchPage(nextUrl);
                allParagraphs.push(...extractTextFromDoc(doc));
                nextUrl = getNextSubPageUrl(doc);
            }

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

            // 4. Build text content: exactly 1 blank line after title, all other text & empty lines preserved as-is
            const fileText = [
                chapterTitle,
                ...allParagraphs
            ].join('\n\n');

            // 5. Sanitize only when creating the filename
            const safeNovelName = sanitizeFilename(novelName);
            const safeChapterTitle = sanitizeFilename(chapterTitle);
            const filename = `${safeNovelName} _ ${safeChapterTitle} (bqquge).txt`;

            triggerDownload(fileText, filename);
            btn.textContent = '下载完成！';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2500);

        } catch (err) {
            console.error('[Bqquge Downloader Error]:', err);
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
            backgroundColor: '#4baacd',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            transition: 'background-color 0.2s, transform 0.1s'
        });

        btn.onmouseover = () => { btn.style.backgroundColor = '#3894b5'; };
        btn.onmouseout = () => { btn.style.backgroundColor = '#4baacd'; };
        btn.onmousedown = () => { btn.style.transform = 'scale(0.96)'; };
        btn.onmouseup = () => { btn.style.transform = 'scale(1)'; };

        btn.addEventListener('click', () => downloadChapter(btn));
        document.body.appendChild(btn);
    }

    initUI();
})();
