// ==UserScript==
// @name         ReadOmni Context Glossary Adder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Quickly add bulk glossary terms from CSV on the Context page.
// @author       You
// @match        https://app.readomni.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- HELPER FUNCTIONS ---

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

    function reactClick(element) {
        if (!element) return;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        });
    }

    async function processCsvFiles(files) {
        let finalCsv = "";
        for (let i = 0; i < files.length; i++) {
            const text = await files[i].text();
            let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            // Skip headers on the second file onwards
            if (i > 0 && lines[0].startsWith("raw,translation")) {
                lines.shift();
            }
            finalCsv += lines.join('\n') + '\n';
        }
        return finalCsv;
    }

    // --- MAIN WORKFLOW ---

    async function addGlossaryWorkflow(files) {
        try {
            console.log("Starting Bulk Glossary Addition...");
            const combinedCsv = await processCsvFiles(files);

            // 1. Click Add
            const addBtn = await waitForElement('button', 'Add', true);
            reactClick(addBtn);
            await sleep(500);

            // 2. Click Bulk Tab
            const bulkTab = await waitForElement('button, [role="tab"]', 'Bulk');
            reactClick(bulkTab);
            await sleep(500);

            // 3. Paste CSV
            const bulkTextarea = await waitForElement('textarea[name="input"]');
            setReactInputValue(bulkTextarea, combinedCsv);

            // 4. Submit
            const addTermsBtn = await waitForElement('button[type="submit"]', 'Add Terms');
            reactClick(addTermsBtn);

            console.log("Glossary Workflow Complete!");
        } catch (error) {
            console.error("Workflow Error:", error);
            alert("Error adding glossary terms. Check the console.");
        }
    }

    // --- UI INJECTION ---

    function triggerFilePickerAndStart() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = '.csv';

        fileInput.onchange = (e) => {
            const files = e.target.files;
            if (!files.length) return;
            addGlossaryWorkflow(files);
        };

        fileInput.click();
    }

    function injectTriggerButton() {
        // Only inject on context pages that have a thread query parameter
        if (window.location.pathname !== '/context' || !window.location.search.includes('thread=')) {
            const existingBtn = document.getElementById('ro-context-workflow-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        if (document.getElementById('ro-context-workflow-btn')) return;

        // Try to find the native "Add" button to place our custom button next to it
        const addBtns = Array.from(document.querySelectorAll('button')).filter(el => el.textContent.trim() === 'Add');
        const nativeAddBtn = addBtns.length > 0 ? addBtns[0] : null;

        if (nativeAddBtn && nativeAddBtn.parentElement) {
            const btn = document.createElement('button');
            btn.id = 'ro-context-workflow-btn';
            btn.innerHTML = '🚀 Add Bulk CSV';
            
            // Reusing ReadOmni native styling classes so it blends perfectly
            btn.className = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 ring-ring/10 dark:ring-ring/20 outline-ring/50 focus-visible:ring-4 focus-visible:outline-1 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 h-9 px-4 shrink-0";
            btn.style.marginRight = '8px'; // Slight spacing between the buttons
            btn.type = "button";
            btn.onclick = triggerFilePickerAndStart;

            nativeAddBtn.parentElement.insertBefore(btn, nativeAddBtn);
        }
    }

    // Watch the DOM to continually re-inject the button as React navigates or renders the page
    let lastUrl = location.href;
    new MutationObserver(() => {
        injectTriggerButton();
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            injectTriggerButton();
        }
    }).observe(document, {subtree: true, childList: true});

    // Initial check
    injectTriggerButton();

})();