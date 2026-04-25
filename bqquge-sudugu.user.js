// ==UserScript==
// @name         Universal Single Chapter Downloader (Bqquge & Sudugu)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Downloads multi-part chapters from bqquge.com and sudugu.org safely.
// @author       You
// @match        *://www.bqquge.com/*/*
// @match        *://www.sudugu.org/*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. Create a floating download button
    const btn = document.createElement('button');
    btn.innerText = '📥 Download This Chapter';
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px';
    btn.style.zIndex = '999999';
    btn.style.padding = '12px 18px';
    btn.style.background = '#28a745';
    btn.style.color = '#fff';
    btn.style.border = 'none';
    btn.style.borderRadius = '8px';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    btn.style.fontWeight = 'bold';
    btn.style.fontSize = '14px';
    document.body.appendChild(btn);

    // 2. Helper function to extract text securely 
    function extractContent(doc) {
        let selectors = [
            '#chaptercontent', '#content', '#BookText', '#nr1', '#nr', 
            '.showtxt', '.read-content', '#htmlContent', '.article-content', 
            '.txt', '#txt'
        ];
        
        let contentDiv = null;
        
        // Strategy A: Look for known IDs
        for (let sel of selectors) {
            let el = doc.querySelector(sel);
            if (el && el.textContent.length > 100) {
                contentDiv = el;
                break;
            }
        }
        
        // Strategy B: Fallback heuristic (find the div with the most text and fewest sub-divs)
        if (!contentDiv) {
            let divs = Array.from(doc.querySelectorAll('div'));
            let bestScore = 0;
            for (let div of divs) {
                let textLen = div.textContent.length;
                let childDivCount = div.querySelectorAll('div').length;
                if (childDivCount <= 3 && textLen > bestScore) {
                    bestScore = textLen;
                    contentDiv = div;
                }
            }
        }

        if (!contentDiv) {
            console.warn("Could not find text container on this page.");
            return '';
        }

        let clone = contentDiv.cloneNode(true);
        
        // Remove unwanted elements
        let unwanted = clone.querySelectorAll('script, style, a, h1, .readinline, .bottem, center');
        unwanted.forEach(el => el.remove());

        // Process line breaks manually
        let html = clone.innerHTML;
        html = html.replace(/<br\s*[\/]?>/gi, "\n");
        html = html.replace(/<\/p>/gi, "\n\n");
        html = html.replace(/<p[^>]*>/gi, "");
        
        // Strip remaining HTML tags
        let temp = document.createElement('div');
        temp.innerHTML = html;
        let text = temp.textContent || '';

        // Clean up weird spaces and excessive blank lines
        text = text.replace(/&nbsp;/gi, ' ');
        text = text.replace(/[\r\n]{3,}/g, '\n\n');
        
        return text.trim();
    }

    // 3. Main download logic
    btn.addEventListener('click', async () => {
        btn.innerText = '⏳ Downloading...';
        btn.disabled = true;
        btn.style.background = '#6c757d';

        let currentUrl = window.location.href;
        
        // Extract Book and Chapter ID for boundary limits
        // Matches things like /115/3390379 (ignores .html or -2.html)
        let match = currentUrl.match(/\/(\d+)\/(\d+)/);
        if (!match) {
            alert("Could not detect book and chapter ID from URL.");
            return;
        }
        let bookId = match[1];
        let chapterId = match[2];

        // Format the title
        let chapterTitle = document.querySelector('h1').innerText.trim();
        chapterTitle = chapterTitle.replace(/\(\d+\/\d+\)$/, '').trim(); // Remove fraction markers
        
        let fullText = chapterTitle + '\n\n';

        try {
            while (true) {
                let doc;

                if (currentUrl === window.location.href) {
                    doc = document;
                } else {
                    const response = await fetch(currentUrl);
                    const html = await response.text();
                    const parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                }

                let text = extractContent(doc);
                if (text) {
                    fullText += text + '\n\n';
                }

                // Find Next Button
                let links = Array.from(doc.querySelectorAll('a'));
                let nextLink = links.find(a => a.innerText.includes('下一页') || a.innerText.includes('下一章'));
                
                if (!nextLink) break;

                let nextUrl = new URL(nextLink.getAttribute('href'), window.location.origin).href;

                // Stop conditions
                if (nextUrl.endsWith(`/${bookId}/`) || nextUrl.includes('index')) break; // Loop to index
                if (nextLink.innerText.includes('下一章')) break; // Next Chapter explicitly declared
                
                // Sudugu uses .html at the end, so the part separator check is still identical: chapterId + "-"
                if (!nextUrl.includes(`${chapterId}-`)) break; // Different base chapter ID entirely

                // Continue to next split part
                currentUrl = nextUrl;
            }

            // 4. File download
            const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${chapterTitle}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            btn.innerText = '✅ Downloaded!';
            btn.style.background = '#28a745';
        } catch (error) {
            console.error('Error downloading chapter:', error);
            btn.innerText = '❌ Error!';
            btn.style.background = '#dc3545';
        } finally {
            setTimeout(() => {
                btn.innerText = '📥 Download This Chapter';
                btn.disabled = false;
                btn.style.background = '#28a745';
            }, 3000);
        }
    });
})();