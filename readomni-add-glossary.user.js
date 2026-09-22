// ==UserScript==
// @name         ReadOmni Quick Glossary Importer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a 1-click "Import CSV" button to the ReadOmni Glossary tab to bulk-add terms.
// @author       You
// @match        https://app.readomni.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Waits for an element to appear in the DOM
    async function waitForElement(selector, textFilter = null, exactText = false, timeout = 15000) {
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
                    setTimeout(check, 250);
                }
            };
            check();
        });
    }

    // Forces React to register input changes
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

    // Dispatches pointer and mouse events to trigger Radix UI components
    function reactClick(element) {
        if (!element) return;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        });
    }

    // Merges multiple CSV files, stripping duplicate header rows
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

    // --- IMPORT ACTION ---

    async function addGlossaryFromFiles(files) {
        try {
            console.log("[Glossary-Importer] Processing selected files...", files);
            const combinedCsv = await processCsvFiles(files);

            if (!combinedCsv.trim()) {
                alert("The selected file(s) are empty.");
                return;
            }

            // 1. Click Add
            console.log("[Glossary-Importer] Opening Add dialog...");
            const addBtn = await waitForElement('button', 'Add', true, 5000);
            reactClick(addBtn);
            await sleep(500);

            // 2. Click Bulk tab
            console.log("[Glossary-Importer] Selecting Bulk tab...");
            const bulkTab = await waitForElement('button, [role="tab"]', 'Bulk', false, 5000);
            reactClick(bulkTab);
            await sleep(500);

            // 3. Paste CSV and submit
            console.log("[Glossary-Importer] Pasting glossary CSV terms...");
            const bulkTextarea = await waitForElement('textarea[name="input"]', null, false, 5000);
            setReactInputValue(bulkTextarea, combinedCsv);

            console.log("[Glossary-Importer] Submitting terms...");
            const addTermsBtn = await waitForElement('button[type="submit"]', 'Add Terms', false, 5000);
            reactClick(addTermsBtn);

            console.log("[Glossary-Importer] Glossary terms added successfully!");
        } catch (error) {
            console.error("[Glossary-Importer] Error adding glossary:", error);
            alert("Failed to add glossary. Check console for details.");
        }
    }

    function triggerFilePicker() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = '.csv';

        fileInput.onchange = (e) => {
            const files = e.target.files;
            if (!files || !files.length) return;
            addGlossaryFromFiles(files);
        };

        fileInput.click();
    }

    // --- UI INJECTION ---

    function injectGlossaryButton() {
        // Target active glossary panel on the thread page
        const glossaryPanel = document.querySelector('[role="tabpanel"][id*="glossary"][data-state="active"]') ||
                              document.querySelector('[id*="content-glossary"]:not([hidden])');

        // If not on an active Glossary tab, remove button if present
        if (!glossaryPanel) {
            const existingBtn = document.getElementById('ro-import-glossary-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        if (document.getElementById('ro-import-glossary-btn')) return;

        // Find the native "Add" button inside the active glossary tab
        const nativeAddBtn = Array.from(glossaryPanel.querySelectorAll('button')).find(b => b.textContent.trim() === 'Add');

        const btn = document.createElement('button');
        btn.id = 'ro-import-glossary-btn';
        btn.innerHTML = '📂 <span class="hidden sm:inline">Import</span> CSV';
        btn.title = "Bulk Import Glossary CSV file(s)";
        btn.type = 'button';
        // Matches native OmniTranslate styling
        btn.className = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] ring-ring/10 dark:ring-ring/20 outline-ring/50 focus-visible:ring-4 focus-visible:outline-1 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 h-9 px-3 shrink-0";

        btn.onclick = triggerFilePicker;

        if (nativeAddBtn && nativeAddBtn.parentElement) {
            nativeAddBtn.parentElement.insertBefore(btn, nativeAddBtn);
        } else {
            glossaryPanel.insertBefore(btn, glossaryPanel.firstChild);
        }
    }

    // Continually observe for tab switches into "Glossary"
    new MutationObserver(() => {
        injectGlossaryButton();
    }).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state', 'class', 'hidden']
    });

    injectGlossaryButton();

})();