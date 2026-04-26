// ==UserScript==
// @name         ReadOmni Auto-Workflow
// @namespace    http://tampermonkey.net/
// @version      1.11
// @description  Automates the ReadOmni thread creation, glossary, and renaming workflow.
// @author       You
// @match        https://app.readomni.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SAMPLE_TEXT = `第99887章 “牌位”\n\n诸葛真人看到了荀老先生那熟悉的，严格的字迹，头皮都是麻的。\n\n他有一种毕业多年了，突然做了个梦，回到了弟子时代，被“教习”耳提面命的紧张和局促感。`;

    // --- HELPER FUNCTIONS ---

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Waits for an element to appear in the DOM
    async function waitForElement(selector, textFilter = null, exactText = false, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const endTime = Date.now() + timeout;
            const check = () => {
                let elements = Array.from(document.querySelectorAll(selector));
                if (textFilter) {
                    elements = elements.filter(el => {
                        const txt = el.textContent.trim();
                        return exactText ? txt === textFilter : txt.includes(textFilter);
                    });
                }
                if (elements.length > 0) {
                    resolve(elements[0]);
                } else if (Date.now() > endTime) {
                    reject(new Error(`Timeout waiting for ${selector} ${textFilter ? '(' + textFilter + ')' : ''}`));
                } else {
                    setTimeout(check, 300);
                }
            };
            check();
        });
    }

    // Forces React to register value changes in inputs/textareas
    function setReactInputValue(element, value) {
        let lastValue = element.value;
        element.value = value;
        let event = new Event('input', { bubbles: true });
        let tracker = element._valueTracker;
        if (tracker) {
            tracker.setValue(lastValue);
        }
        const nativeSetter = Object.getOwnPropertyDescriptor(
            element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
            'value'
        ).set;
        nativeSetter.call(element, value);
        element.dispatchEvent(event);
    }

    // Forces stubborn React UI components (like dropdowns/tabs) to trigger
    function reactClick(element) {
        if (!element) return;
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        element.click();
    }

    async function processCsvFiles(files) {
        let finalCsv = "";
        for (let i = 0; i < files.length; i++) {
            const text = await files[i].text();
            let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (i > 0 && lines[0].startsWith("raw,translation")) {
                lines.shift();
            }
            finalCsv += lines.join('\n') + '\n';
        }
        return finalCsv;
    }

    function getNextThreadName(filename) {
        let namePart = filename.replace(/^glossary-\d+of\d+-/i, '').replace(/\.csv$/i, '');
        const match = namePart.match(/(.*?)(\d+)$/);

        if (match) {
            let textPart = match[1];
            let numberPart = parseInt(match[2], 10);
            return textPart + (numberPart + 1);
        } else {
            return namePart + "1";
        }
    }

    // --- MAIN WORKFLOW ---

    async function startWorkflow(files) {
        try {
            console.log("Starting ReadOmni Workflow...");

            const nextName = getNextThreadName(files[0].name);
            const combinedCsv = await processCsvFiles(files);

            // 1. Paste text and submit
            const mainTextarea = await waitForElement('textarea');
            setReactInputValue(mainTextarea, SAMPLE_TEXT);

            const submitBtn = await waitForElement('button[type="submit"]');
            reactClick(submitBtn);

            // 2. Settings Gear
            const settingsBtn = await waitForElement('svg.lucide-sliders-horizontal');
            reactClick(settingsBtn.closest('button') || settingsBtn.parentElement);
            await sleep(300);

            // 3. Appearance -> Conditional Font Logic
            const appearanceBtn = await waitForElement('button', 'Appearance');
            reactClick(appearanceBtn);
            await sleep(300);

            const fontInput = await waitForElement('input[inputmode="numeric"]');
            const currentFontSize = parseInt(fontInput.value, 10);

            // Only click the plus button if the current font is strictly less than 18
            if (!isNaN(currentFontSize) && currentFontSize < 18) {
                console.log(`Current font size is ${currentFontSize}. Adjusting to 18 using + button.`);

                // Find the plus icon and its parent button
                const plusIcon = await waitForElement('svg.lucide-plus');
                const plusBtn = plusIcon.closest('button');

                // Calculate how many times to click
                const clicksNeeded = 18 - currentFontSize;

                for (let i = 0; i < clicksNeeded; i++) {
                    reactClick(plusBtn);
                    await sleep(100); // Small pause between clicks for state updates
                }
                await sleep(300); // Give React state a moment to settle
            } else {
                console.log(`Current font size is ${currentFontSize}. No changes needed.`);
            }

            // Close the settings modal
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

            // 4. Click generated thread name to go to the Library
            const threadNameSpan = await waitForElement('span.truncate.font-medium');
            reactClick(threadNameSpan);

            // Wait for the library page to fully mount and URL to update
            await sleep(2000);

            // 5. Go to Context (Explicitly targeting the a-tag with the thread ID)
            const contextLink = await waitForElement('a[href*="/context?thread="]');
            contextLink.click();

            // CRITICAL: Wait for React Router to parse the ?thread= URL parameter.
            await sleep(2000);

            // 6. Click Add -> Bulk
            const addBtn = await waitForElement('button', 'Add', true);
            reactClick(addBtn);
            await sleep(500);

            const bulkTab = await waitForElement('button, [role="tab"]', 'Bulk');
            reactClick(bulkTab);
            await sleep(500);

            // 7. Paste CSV and submit
            const bulkTextarea = await waitForElement('textarea[name="input"]');
            setReactInputValue(bulkTextarea, combinedCsv);

            const addTermsBtn = await waitForElement('button[type="submit"]', 'Add Terms');
            reactClick(addTermsBtn);

            // 8. Wait for saving, then go back
            await sleep(1500);
            window.history.back();

            // 9. Wait for routing back to the Library page
            await sleep(1500);
            await waitForElement('a[href*="/?thread="]', 'Add Translation');

            // 10. Rename Thread
            const ellipsisIcon = await waitForElement('.lucide-ellipsis-vertical');
            const ellipsisBtn = ellipsisIcon.closest('button') || ellipsisIcon.closest('[role="button"]') || ellipsisIcon.parentElement;
            reactClick(ellipsisBtn);
            await sleep(500);

            const editItem = await waitForElement('[role="menuitem"], button, div', 'Edit', true);
            reactClick(editItem);
            await sleep(500);

            const titleInput = await waitForElement('input[name="title"]');
            setReactInputValue(titleInput, nextName);

            const saveChangesBtn = await waitForElement('button[type="submit"]', 'Save changes');
            reactClick(saveChangesBtn);

            await sleep(1000);
            const addTranslationAnchor = await waitForElement('a[href*="/?thread="]', 'Add Translation');
            addTranslationAnchor.click();

            console.log("Workflow Complete! Thread Renamed to: " + nextName);

        } catch (error) {
            console.error("Workflow Error:", error);
            alert("Workflow stopped due to an error. Check console.");
        }
    }

    // --- UI INJECTION & TRIGGER ---

    function triggerFilePickerAndStart() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = '.csv';

        fileInput.onchange = (e) => {
            const files = e.target.files;
            if (!files.length) return;
            startWorkflow(files);
        };

        fileInput.click();
    }

    function injectTriggerButton() {
        if (window.location.pathname !== '/' || window.location.search !== '') {
            const existingBtn = document.getElementById('ro-workflow-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        if (document.getElementById('ro-workflow-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'ro-workflow-btn';
        btn.textContent = '🚀 Run Workflow';
        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            padding: '12px 20px',
            backgroundColor: '#000',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            zIndex: '999999',
            cursor: 'pointer',
            fontWeight: 'bold',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        });

        btn.onclick = triggerFilePickerAndStart;
        document.body.appendChild(btn);
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            injectTriggerButton();
        }
    }).observe(document, {subtree: true, childList: true});

    injectTriggerButton();

})();
