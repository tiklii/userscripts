// ==UserScript==
// @name         sto9 chapter downloader
// @namespace    https://github.com/tiklii/userscripts
// @version      1.0
// @description  Downloads complete single-page novel chapters on sto9.com with preserved indentations and clean formatting.
// @author       tiklii
// @match        *://sto9.com/txt/*/*.html
// @match        *://www.sto9.com/txt/*/*.html
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /**
     * Extracts raw novel name and chapter title without stripping any text characters.
     */
    function getMetaInfo() {
        let novelName = '';
        let chapterTitle = '';

        // 1. Try extracting from breadcrumbs (.bread)
        // Format: 首頁 > 武俠仙俠 > 玄鑒仙族 > 第1614章 宮寺
        const bookLink = document.querySelector('.bread a[href*="/book/"]');
        if (bookLink) {
            novelName = bookLink.textContent.trim();
        }

        // 2. Try extracting from chapter heading
        const h1 = document.querySelector('.txtnav h1');
        if (h1) {
            chapterTitle = h1.textContent.trim();
        }

        // 3. Fallback to <title> tag
        // Format: 玄鑒仙族_第1614章 宮寺|思兔sto9
        if (!novelName || !chapterTitle) {
            const rawTitle = document.title.split('|')[0].trim();
            const parts = rawTitle.split('_');
            if (parts.length >= 2) {
                novelName = novelName || parts[0].trim();
                chapterTitle = chapterTitle || parts.slice(1).join('_').trim();
            } else {
                chapterTitle = chapterTitle || rawTitle;
            }
        }

        return {
            novelName: novelName || '未知書名',
            chapterTitle: chapterTitle || '未知章節'
        };
    }

    /**
     * Only sanitize characters when generating the file name on disk.
     */
    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|\r\n\t]+/g, '').trim();
    }

    /**
     * Extracts raw text from .txtnav while removing ad blocks and preserving <br> spacing.
     */
    function extractText() {
        const txtnav = document.querySelector('.txtnav');
        if (!txtnav) return [];

        // Clone container so live page DOM is not altered
        const clone = txtnav.cloneNode(true);

        // Remove title heading, scripts, styles, and ad containers
        clone.querySelectorAll('h1, script, style, ins, .txtad, .txtright, .txtcenter, .sf-hidden').forEach(el => el.remove());

        // Replace <br> tags with \n, stripping the source-code newline right after <br>
        clone.querySelectorAll('br').forEach(br => {
            if (br.nextSibling && br.nextSibling.nodeType === Node.TEXT_NODE) {
                br.nextSibling.nodeValue = br.nextSibling.nodeValue.replace(/^[\r\n]+/, '');
            }
            br.replaceWith('\n');
        });

        // Split text into lines to preserve indentations and intentional blank lines
        const rawText = clone.textContent.replace(/\r/g, '');
        return rawText.split('\n');
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
     * Orchestrates extraction and file saving
     */
    function downloadChapter(btn) {
        btn.disabled = true;
        const originalText = btn.textContent;

        try {
            const { novelName, chapterTitle } = getMetaInfo();
            const lines = extractText();

            // 1. Remove initial empty lines before content
            while (lines.length > 0 && lines[0].trim() === '') {
                lines.shift();
            }

            // 2. Remove duplicate title if repeated at the top of the body
            if (
                lines.length > 0 &&
                lines[0].trim().replace(/\s+/g, ' ') === chapterTitle.trim().replace(/\s+/g, ' ')
            ) {
                lines.shift();
            }

            // 3. Ensure strictly ONE empty line between chapter title and the text body
            while (lines.length > 0 && lines[0].trim() === '') {
                lines.shift();
            }

            // 4. Remove any trailing empty lines at the very bottom
            while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
                lines.pop();
            }

            // 5. Build text: title, empty line, followed by raw lines as-is
            const fileText = [
                chapterTitle,
                '',
                ...lines
            ].join('\n');

            // 6. Name convention: "<Novel name> _ <chapter name> (sto9).txt"
            const safeNovelName = sanitizeFilename(novelName);
            const safeChapterTitle = sanitizeFilename(chapterTitle);
            const filename = `${safeNovelName} _ ${safeChapterTitle} (sto9).txt`;

            triggerDownload(fileText, filename);

            btn.textContent = '下載完成！';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.disabled = false;
            }, 2000);

        } catch (err) {
            console.error('[Sto9 Downloader Error]:', err);
            alert('下載失敗，請查看控制台輸出');
            btn.textContent = '下載出錯';
            btn.disabled = false;
        }
    }

    /**
     * Injects the floating download button styled to sto9's palette
     */
    function initUI() {
        const btn = document.createElement('button');
        btn.id = 'sto9-download-btn';
        btn.textContent = '📥 下載本章 TXT';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '80px',
            right: '25px',
            zIndex: '999999',
            padding: '10px 16px',
            backgroundColor: '#1E2A5E',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            transition: 'background-color 0.2s, transform 0.1s'
        });

        btn.onmouseover = () => { btn.style.backgroundColor = '#2a3b83'; };
        btn.onmouseout = () => { btn.style.backgroundColor = '#1E2A5E'; };
        btn.onmousedown = () => { btn.style.transform = 'scale(0.96)'; };
        btn.onmouseup = () => { btn.style.transform = 'scale(1)'; };

        btn.addEventListener('click', () => downloadChapter(btn));
        document.body.appendChild(btn);
    }

    initUI();
})();
