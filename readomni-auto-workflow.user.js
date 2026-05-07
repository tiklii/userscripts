// ==UserScript==
// @name         ReadOmni Auto-Workflow
// @namespace    http://tampermonkey.net/
// @version      1.15
// @description  Automates the ReadOmni thread creation, glossary, and renaming workflow.
// @author       You
// @match        https://app.readomni.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SAMPLE_TEXT = `第99887章 “牌位”\n\n诸葛真人看到了荀老先生那熟悉的，严格的字迹，头皮都是麻的。\n\n他有一种毕业多年了，突然做了个梦，回到了弟子时代，被“教习”耳提面命的紧张和局促感。`;

    // State Keys for SessionStorage (Allows recovery after a hard refresh)
    const STATE_KEY = 'ro_wf_state';
    const CSV_KEY = 'ro_wf_csv';
    const NAME_KEY = 'ro_wf_name';
    const RELOAD_KEY = 'ro_wf_reloaded';

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

    // Forces stubborn React/Radix UI components (like dropdowns/tabs/ellipsis) to trigger
    function reactClick(element) {
        if (!element) return;
        // Radix UI menus often require pointer events rather than just mouse events
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        });
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
        // Strip out the .csv extension
        let namePart = filename.replace(/\.csv$/i, '');
        // Strip out 'glossary-' and an optional '1of2-' part
        namePart = namePart.replace(/^glossary-(?:\d+of\d+-)?/i, '');

        // Extract text and trailing numbers
        const match = namePart.match(/(.*?)(\d+)$/);
        if (match) {
            let textPart = match[1];
            let numberPart = parseInt(match[2], 10);
            return textPart + (numberPart + 1);
        } else {
            return namePart + "1"; // e.g., qingshan -> qingshan1
        }
    }

    function clearWorkflowState() {
        sessionStorage.removeItem(STATE_KEY);
        sessionStorage.removeItem(CSV_KEY);
        sessionStorage.removeItem(NAME_KEY);
        sessionStorage.removeItem(RELOAD_KEY);
    }

    // --- MAIN WORKFLOW ---

    async function startWorkflow(files) {
        try {
            console.log("Starting ReadOmni Workflow...");

            const nextName = getNextThreadName(files[0].name);
            const combinedCsv = await processCsvFiles(files);

            // Save variables to session storage so it survives page reloads
            sessionStorage.setItem(CSV_KEY, combinedCsv);
            sessionStorage.setItem(NAME_KEY, nextName);

            // 1. Paste text and submit
            const mainTextarea = await waitForElement('textarea');
            setReactInputValue(mainTextarea, SAMPLE_TEXT);

            const submitBtn = await waitForElement('button[type="submit"]');
            reactClick(submitBtn);

            // Set state and jump into the state machine
            sessionStorage.setItem(STATE_KEY, 'STEP_1');
            doWorkflow();

        } catch (error) {
            console.error("Workflow Start Error:", error);
            alert("Workflow stopped due to an error. Check console.");
            clearWorkflowState();
        }
    }

    // This handles the process progressively, resuming gracefully if the page gets reloaded
    async function doWorkflow() {
        let state = sessionStorage.getItem(STATE_KEY);
        if (!state) return;

        const combinedCsv = sessionStorage.getItem(CSV_KEY);
        const nextName = sessionStorage.getItem(NAME_KEY);

        try {
            if (state === 'STEP_1') {
                console.log("Running STEP_1 (Waiting for thread page to load)...");
                let reloaded = sessionStorage.getItem(RELOAD_KEY);
                let threadNameSpan;

                try {
                    // Give it 10s standard, or 30s if we already refreshed due to a hang
                    const timeout = reloaded === 'true' ? 30000 : 10000;
                    // The thread name appears when the new page fully renders
                    threadNameSpan = await waitForElement('span.truncate.font-medium', null, false, timeout);
                    sessionStorage.removeItem(RELOAD_KEY);
                } catch (e) {
                    if (reloaded !== 'true') {
                        console.log("Hanging detected! Executing a hard refresh...");
                        sessionStorage.setItem(RELOAD_KEY, 'true');
                        location.reload(true);
                        return; // Stop execution; page will reload and jump back here natively
                    } else {
                        throw new Error("Timeout waiting for thread page to load even after reload.");
                    }
                }

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

                if (!isNaN(currentFontSize) && currentFontSize < 18) {
                    console.log(`Adjusting font size to 18.`);
                    const plusIcon = await waitForElement('svg.lucide-plus');
                    const plusBtn = plusIcon.closest('button');
                    const clicksNeeded = 18 - currentFontSize;

                    for (let i = 0; i < clicksNeeded; i++) {
                        reactClick(plusBtn);
                        await sleep(100);
                    }
                    await sleep(300);
                }

                // Close the settings modal
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

                // 4. Click generated thread name to go to the Library
                // Grab it again just in case DOM shifted
                threadNameSpan = await waitForElement('span.truncate.font-medium');
                reactClick(threadNameSpan);

                sessionStorage.setItem(STATE_KEY, 'STEP_2');
                state = 'STEP_2';
                await sleep(2000);
            }

            if (state === 'STEP_2') {
                console.log("Running STEP_2 (Navigating to Context)...");
                // 5. Go to Context
                const contextLink = await waitForElement('a[href*="/context?thread="]');
                contextLink.click();

                sessionStorage.setItem(STATE_KEY, 'STEP_3');
                state = 'STEP_3';
                await sleep(2000);
            }

            if (state === 'STEP_3') {
                console.log("Running STEP_3 (Injecting Bulk Words)...");
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

                sessionStorage.setItem(STATE_KEY, 'STEP_4');
                state = 'STEP_4';
                await sleep(1500);
            }

            if (state === 'STEP_4') {
                console.log("Running STEP_4 (Renaming)...");
                // 9. Wait for routing back to the Library page
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

                // Job done, wipe memory clean
                clearWorkflowState();
            }

        } catch (error) {
            console.error("Workflow Error:", error);
            alert("Workflow stopped due to an error. Check console.");
            clearWorkflowState();
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
        // Only run on the homepage
        if (window.location.pathname !== '/' || window.location.search !== '') {
            const existingBtn = document.getElementById('ro-workflow-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        if (document.getElementById('ro-workflow-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'ro-workflow-btn';
        // Hide the text on very small screens to ensure it doesn't break header styling, but show on normal/desktop
        btn.innerHTML = '🚀<span class="hidden sm:inline ml-2">Workflow</span>';

        // Native OmniTranslate CSS classes to perfectly blend with the header icons
        btn.className = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 ring-ring/10 dark:ring-ring/20 outline-ring/50 focus-visible:ring-4 focus-visible:outline-1 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 h-9 px-3 shrink-0";
        btn.type = "button";
        btn.onclick = triggerFilePickerAndStart;

        // Find the top-right header icon container
        // 1. Try to find the bell icon
        let container = document.querySelector('.lucide-bell')?.closest('button')?.parentElement;

        // 2. Try the right-side flex container inside the mobile header
        if (!container) {
            container = document.querySelector('header .flex-shrink-0.flex-row.items-center');
        }

        // 3. Last resort fallback (e.g. desktop specific layouts if header isn't matched)
        if (!container) {
            container = document.querySelector('header')?.lastElementChild;
        }

        if (container && container.classList.contains('flex')) {
            // Insert it at the start of the icon group
            container.insertBefore(btn, container.firstChild);
        } else {
            // Ultimate fallback if the UI radically changes: Floating top-right button
            Object.assign(btn.style, {
                position: 'fixed',
                top: '12px',
                right: '100px', // Leaves room for native icons
                zIndex: '999999'
            });
            document.body.appendChild(btn);
        }
    }

    // Watch the DOM to continually re-inject the button as React navigates
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

    // Trigger workflow recovery on page load (handles the 5s hard refresh seamlessly)
    if (sessionStorage.getItem(STATE_KEY)) {
        setTimeout(doWorkflow, 1000); // 1-second delay lets DOM/React settle after a reload
    }

})();
