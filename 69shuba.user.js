// ==UserScript==
// @name         69shuba Chapter Downloader
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Adds a button to download chapters as a txt file from 69shuba
// @author       You
// @match        *://*.69shuba.com/txt/*/*
// @match        *://*.69shuba.pro/txt/*/*
// @match        *://*.69shuba.cx/txt/*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function downloadChapter() {
        // Extract Novel Name and Chapter Name from the Page Title
        // Example: "阵问长生-第1389章三品阵法-69书吧"
        let titleParts = document.title.split('-');
        let novelName = titleParts[0] ? titleParts[0].trim() : 'Unknown_Novel';
        let chapterName = titleParts[1] ? titleParts[1].trim() : 'Unknown_Chapter';

        // Fallback for chapter name if the title structure is unexpected
        if (chapterName === 'Unknown_Chapter') {
            let h1 = document.querySelector('h1');
            if (h1) chapterName = h1.innerText.trim();
        }

        // Prepare the file name with the new format
        let fileName = `${novelName} - ${chapterName} (69shuba).txt`;

        // The reading content is wrapped in a div with the class 'txtnav'
        let contentDiv = document.querySelector('.txtnav');
        if (!contentDiv) {
            alert('Could not find chapter content! The layout might have changed.');
            return;
        }

        // Clone the content div so we can manipulate and clean it without affecting the actual webpage
        let clone = contentDiv.cloneNode(true);

        // Remove unwanted UI elements (titles, bottom navigation, scripts, ads)
        let unwantedSelectors = [
            '.txtinfo', '.bottom', '.page1', '.hide720',
            'script', 'style', 'h1', '.ad', '.adsbygoogle', 'center'
        ];

        unwantedSelectors.forEach(selector => {
            let elements = clone.querySelectorAll(selector);
            elements.forEach(el => el.remove());
        });

        // Get the clean text
        // InnerText respects <br> tags and visual linebreaks
        let textContent = clone.innerText.trim();

        // If you want to include the Chapter Title inside the text file, you can prepend it:
        textContent = `${chapterName}\n\n${textContent}`;

        // Create a blob containing the text
        let blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
        let url = URL.createObjectURL(blob);

        // Create a temporary hidden anchor element to trigger the download
        let a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();

        // Clean up the object URL and the anchor element
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // Function to inject the Download Button into the page
    function addDownloadButton() {
        let btn = document.createElement('button');
        btn.innerText = '📥 Download TXT';

        // Styling the floating button
        btn.style.position = 'fixed';
        btn.style.bottom = '30px';
        btn.style.right = '30px';
        btn.style.zIndex = '99999';
        btn.style.padding = '12px 18px';
        btn.style.backgroundColor = '#2c3e50';
        btn.style.color = '#ffffff';
        btn.style.border = 'none';
        btn.style.borderRadius = '8px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '16px';
        btn.style.fontWeight = 'bold';
        btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
        btn.style.transition = 'background-color 0.2s';

        // Hover effects
        btn.onmouseover = () => btn.style.backgroundColor = '#34495e';
        btn.onmouseout = () => btn.style.backgroundColor = '#2c3e50';

        // Attach click event
        btn.addEventListener('click', downloadChapter);

        // Append to body
        document.body.appendChild(btn);
    }

    // Initialize the script once the window finishes loading
    window.addEventListener('load', addDownloadButton);

})();
