// ==UserScript==
// @name         TWKan Single Chapter Downloader
// @namespace    https://twkan.com/
// @version      1.2
// @description  Download the current TWKan chapter as a TXT file
// @match        https://twkan.com/txt/*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /**
     * Extract the novel ID from:
     * https://twkan.com/txt/82879/59646073
     *
     * Returns:
     * 82879
     */
    function getNovelId() {
        const match = location.pathname.match(/^\/txt\/(\d+)\/\d+/);
        return match ? match[1] : null;
    }

    /**
     * Try to find the novel name on the current chapter page.
     */
    function getNovelNameFromChapterPage() {
        // Breadcrumb:
        // 首頁 > 武俠仙俠 > 仙道盡頭 > 第539章 我們無敵
        const links = document.querySelectorAll('a');

        for (const link of links) {
            const href = link.getAttribute('href') || '';

            if (href.includes('/book/')) {
                const name = link.textContent.trim();

                if (name) {
                    return name;
                }
            }
        }

        return null;
    }

    /**
     * Fetch the novel's main page in the background
     * and extract its title.
     */
    async function getNovelNameFromBookPage() {
        const novelId = getNovelId();

        if (!novelId) {
            return null;
        }

        const bookUrl = `/book/${novelId}.html`;

        try {
            const response = await fetch(bookUrl, {
                credentials: 'same-origin'
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();

            // Parse the returned HTML without navigating away.
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // On the TWKan book page the novel name is in h1.
            const h1 = doc.querySelector('h1');

            if (h1) {
                const name = h1.textContent.trim();

                if (name) {
                    return name;
                }
            }

            // Fallback: try the breadcrumb/book link.
            const bookLink = doc.querySelector('a[href*="/book/"]');

            if (bookLink) {
                const name = bookLink.textContent.trim();

                if (name) {
                    return name;
                }
            }

        } catch (error) {
            console.error('TWKan: Could not retrieve novel name:', error);
        }

        return null;
    }

    /**
     * Remove characters that are invalid in Windows filenames.
     */
    function sanitizeFilename(name) {
        return name
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Download the current chapter.
     */
    async function downloadChapter() {
        const content = document.querySelector('#txtcontent0');

        if (!content) {
            alert('找不到小說內容 (#txtcontent0)');
            return;
        }

        // Get chapter title.
        const titleElement =
            document.querySelector('.txtnav h1') ||
            document.querySelector('h1');

        const chapterName = titleElement
            ? titleElement.textContent.trim()
            : 'chapter';

        // Try current page first.
        let novelName = getNovelNameFromChapterPage();

        // If not available, retrieve it from /book/<id>.html
        if (!novelName) {
            novelName = await getNovelNameFromBookPage();
        }

        // Last-resort fallback.
        if (!novelName) {
            novelName = 'Unknown Novel';
        }

        // Extract chapter text.
        let text = content.innerText
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        // Put chapter title at the beginning of the file.
        const output =
            chapterName +
            '\n\n' +
            text +
            '\n';

        // Requested filename format:
        //
        // 仙道盡頭 _ 第539章 我們無敵 (twkan).txt
        const filename =
            sanitizeFilename(
                `${novelName} _ ${chapterName} (twkan)`
            ) + '.txt';

        // UTF-8 BOM helps Windows Notepad correctly detect Chinese text.
        const blob = new Blob(
            ['\uFEFF', output],
            {
                type: 'text/plain;charset=utf-8'
            }
        );

        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');

        link.href = url;
        link.download = filename;

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    // ------------------------------------------------------------
    // Create download button
    // ------------------------------------------------------------

    const button = document.createElement('button');

    button.id = 'twkan-txt-download';
    button.textContent = '下載 TXT';

    Object.assign(button.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',

        padding: '10px 18px',
        border: 'none',
        borderRadius: '6px',

        background: '#333',
        color: '#fff',

        fontSize: '16px',
        fontWeight: 'bold',

        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
    });

    button.addEventListener('mouseenter', () => {
        button.style.background = '#555';
    });

    button.addEventListener('mouseleave', () => {
        button.style.background = '#333';
    });

    button.addEventListener('click', downloadChapter);

    document.body.appendChild(button);

})();
