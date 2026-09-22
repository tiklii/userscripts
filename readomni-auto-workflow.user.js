// ==UserScript==
// @name         ReadOmni Auto-Workflow
// @namespace    https://github.com/tiklii/userscripts
// @version      1.18
// @description  Automates the ReadOmni thread creation, glossary, and renaming workflow.
// @author       tiklii
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
    const MODE_KEY = 'ro_wf_mode';

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
        // Strip out OS added duplicate numbers like " (1)", " (2)" at the end
        namePart = namePart.replace(/\s*\(\d+\)$/, '');
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
        sessionStorage.removeItem(MODE_KEY);
    }

    // --- MAIN WORKFLOW ---

    async function startWorkflow(files) {
        try {
            console.log("[ReadOmni-Workflow] Starting workflow...");

            const nextName = getNextThreadName(files[0].name);
            const combinedCsv = await processCsvFiles(files);

            console.log(`[ReadOmni-Workflow] Target thread name: "${nextName}"`);

            sessionStorage.setItem(CSV_KEY, combinedCsv);
            sessionStorage.setItem(NAME_KEY, nextName);

            // 1. Paste text and submit
            console.log("[ReadOmni-Workflow] Submitting sample text...");
            const mainTextarea = await waitForElement('textarea');
            setReactInputValue(mainTextarea, SAMPLE_TEXT);

            const submitBtn = await waitForElement('button[type="submit"]');
            reactClick(submitBtn);

            // Set state and trigger workflow state machine
            sessionStorage.setItem(STATE_KEY, 'STEP_1');
            doWorkflow();

        } catch (error) {
            console.error("[ReadOmni-Workflow] Error during startup:", error);
            alert("Workflow stopped due to an error. Check console.");
            clearWorkflowState();
        }
    }

    async function doWorkflow() {
        let state = sessionStorage.getItem(STATE_KEY);
        if (!state) return;

        const combinedCsv = sessionStorage.getItem(CSV_KEY);
        const nextName = sessionStorage.getItem(NAME_KEY);

        try {
            if (state === 'STEP_1') {
                console.log("[ReadOmni-Workflow] [STEP 1] Waiting for translation view to load...");
                let reloaded = sessionStorage.getItem(RELOAD_KEY);
                let threadNameSpan;

                try {
                    const timeout = reloaded === 'true' ? 30000 : 10000;
                    threadNameSpan = await waitForElement('span.truncate.font-medium', null, false, timeout);
                    sessionStorage.removeItem(RELOAD_KEY);
                } catch (e) {
                    if (reloaded !== 'true') {
                        console.log("[ReadOmni-Workflow] Page stuck loading. Performing hard refresh...");
                        sessionStorage.setItem(RELOAD_KEY, 'true');
                        location.reload(true);
                        return;
                    } else {
                        throw new Error("Timeout waiting for thread page to load even after reload.");
                    }
                }

                // 2. Settings Gear
                console.log("[ReadOmni-Workflow] [STEP 1] Opening settings modal...");
                const settingsBtn = await waitForElement('svg.lucide-sliders-horizontal');
                reactClick(settingsBtn.closest('button') || settingsBtn.parentElement);
                await sleep(300);

                // 3. Appearance -> Font Logic
                console.log("[ReadOmni-Workflow] [STEP 1] Checking font size in Appearance...");
                const appearanceBtn = await waitForElement('button', 'Appearance');
                reactClick(appearanceBtn);
                await sleep(300);

                const fontInput = await waitForElement('input[inputmode="numeric"]');
                const currentFontSize = parseInt(fontInput.value, 10);

                if (!isNaN(currentFontSize) && currentFontSize < 18) {
                    console.log(`[ReadOmni-Workflow] [STEP 1] Current font size is ${currentFontSize}. Adjusting to 18...`);
                    const plusIcon = await waitForElement('svg.lucide-plus');
                    const plusBtn = plusIcon.closest('button');
                    const clicksNeeded = 18 - currentFontSize;

                    for (let i = 0; i < clicksNeeded; i++) {
                        reactClick(plusBtn);
                        await sleep(100);
                    }
                    await sleep(300);
                } else {
                    console.log(`[ReadOmni-Workflow] [STEP 1] Font size is already ${currentFontSize}. No changes needed.`);
                }

                // Close settings modal
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(300);

                // 4. Click thread name to navigate to the Thread page
                console.log("[ReadOmni-Workflow] [STEP 1] Navigating to thread page...");
                threadNameSpan = await waitForElement('span.truncate.font-medium');
                reactClick(threadNameSpan);

                sessionStorage.setItem(STATE_KEY, 'STEP_2');
                state = 'STEP_2';
                await sleep(1500);
            }

            if (state === 'STEP_2') {
                console.log("[ReadOmni-Workflow] [STEP 2] Waiting for Thread page to load...");
                // Wait for the Thread page H1 to appear
                await waitForElement('h1');

                let isTabMode = false;
                let glossaryTab = null;

                try {
                    // Check for the new Glossary tab on the thread page
                    glossaryTab = await waitForElement('button[role="tab"], button', 'Glossary', true, 4000);
                    isTabMode = true;
                } catch (e) {
                    console.log("[ReadOmni-Workflow] [STEP 2] Glossary tab not found, falling back to context link check...");
                }

                if (isTabMode && glossaryTab) {
                    console.log("[ReadOmni-Workflow] [STEP 2] Clicking new 'Glossary' tab...");
                    reactClick(glossaryTab);
                    sessionStorage.setItem(MODE_KEY, 'tab');
                } else {
                    console.log("[ReadOmni-Workflow] [STEP 2] Clicking legacy context link...");
                    const contextLink = await waitForElement('a[href*="/context?thread="]');
                    reactClick(contextLink);
                    sessionStorage.setItem(MODE_KEY, 'link');
                }

                sessionStorage.setItem(STATE_KEY, 'STEP_3');
                state = 'STEP_3';
                await sleep(1500);
            }

            if (state === 'STEP_3') {
                console.log("[ReadOmni-Workflow] [STEP 3] Opening Bulk Terms input...");
                const wfMode = sessionStorage.getItem(MODE_KEY) || 'tab';

                // 6. Click Add -> Bulk
                const addBtn = await waitForElement('button', 'Add', true);
                reactClick(addBtn);
                await sleep(500);

                const bulkTab = await waitForElement('button, [role="tab"]', 'Bulk');
                reactClick(bulkTab);
                await sleep(500);

                // 7. Paste CSV and submit
                console.log("[ReadOmni-Workflow] [STEP 3] Pasting combined glossary terms...");
                const bulkTextarea = await waitForElement('textarea[name="input"]');
                setReactInputValue(bulkTextarea, combinedCsv);

                const addTermsBtn = await waitForElement('button[type="submit"]', 'Add Terms');
                reactClick(addTermsBtn);

                console.log("[ReadOmni-Workflow] [STEP 3] Terms submitted, waiting for save...");
                await sleep(2000);

                // If on legacy link mode (/context), go back. In tab mode, we are ALREADY on the thread page!
                if (wfMode === 'link' || window.location.pathname.includes('/context')) {
                    console.log("[ReadOmni-Workflow] [STEP 3] Navigating back from /context page...");
                    window.history.back();
                    await sleep(1500);
                } else {
                    console.log("[ReadOmni-Workflow] [STEP 3] Tab mode: already on thread page, continuing directly.");
                }

                sessionStorage.setItem(STATE_KEY, 'STEP_4');
                state = 'STEP_4';
            }

            if (state === 'STEP_4') {
                console.log(`[ReadOmni-Workflow] [STEP 4] Renaming Thread to: "${nextName}"...`);

                // 10. Locate Thread Menu adjacent to H1
                let ellipsisIcon = null;
                for (let i = 0; i < 30; i++) {
                    const h1 = document.querySelector('h1');
                    if (h1 && h1.parentElement) {
                        ellipsisIcon = h1.parentElement.querySelector('.lucide-ellipsis-vertical');
                        if (ellipsisIcon) break;
                    }
                    await sleep(300);
                }

                if (!ellipsisIcon) {
                    console.warn("[ReadOmni-Workflow] [STEP 4] Could not find H1-scoped ellipsis, trying global search...");
                    ellipsisIcon = await waitForElement('.lucide-ellipsis-vertical');
                }

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
                console.log("[ReadOmni-Workflow] [STEP 4] New title saved.");

                await sleep(1000);

                // 11. Navigate to Add Translation / New chapter
                console.log("[ReadOmni-Workflow] [STEP 4] Navigating to Add Translation / New chapter...");
                const currentThreadId = window.location.pathname.match(/\/thread\/([a-zA-Z0-9-]+)/)?.[1];

                let newBtn = document.querySelector('button[aria-label="Add chapters"]') ||
                             Array.from(document.querySelectorAll('button')).find(b => {
                                 const txt = b.textContent.trim();
                                 return (txt === 'New' || txt.includes('Add Translation')) && b.querySelector('svg.lucide-plus');
                             }) ||
                             document.querySelector('a[href*="/?thread="]');

                if (newBtn) {
                    reactClick(newBtn);
                    await sleep(1000);
                }

                // If still on the thread page after clicking, navigate via URL directly
                if (currentThreadId && window.location.pathname.includes('/thread/')) {
                    console.log("[ReadOmni-Workflow] [STEP 4] Navigating directly via URL to /?thread=" + currentThreadId);
                    window.location.href = `/?thread=${currentThreadId}`;
                }

                console.log("[ReadOmni-Workflow] Workflow Complete! Thread Renamed to: " + nextName);
                clearWorkflowState();
            }

        } catch (error) {
            console.error("[ReadOmni-Workflow] Error during execution:", error);
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
        // Only run on homepage
        if (window.location.pathname !== '/' || window.location.search !== '') {
            const existingBtn = document.getElementById('ro-workflow-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        if (document.getElementById('ro-workflow-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'ro-workflow-btn';
        btn.innerHTML = '🚀<span class="hidden sm:inline ml-2">Workflow</span>';
        btn.className = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 ring-ring/10 dark:ring-ring/20 outline-ring/50 focus-visible:ring-4 focus-visible:outline-1 bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 h-9 px-3 shrink-0";
        btn.type = "button";
        btn.onclick = triggerFilePickerAndStart;

        // Find top-right header icon container
        let container = document.querySelector('.lucide-bell')?.closest('button')?.parentElement;
        if (!container) {
            container = document.querySelector('header .flex-shrink-0.flex-row.items-center');
        }
        if (!container) {
            container = document.querySelector('header')?.lastElementChild;
        }

        if (container && container.classList.contains('flex')) {
            container.insertBefore(btn, container.firstChild);
        } else {
            Object.assign(btn.style, {
                position: 'fixed',
                top: '12px',
                right: '100px',
                zIndex: '999999'
            });
            document.body.appendChild(btn);
        }
    }

    // Watch DOM for URL / view changes to keep the trigger button available
    let lastUrl = location.href;
    new MutationObserver(() => {
        injectTriggerButton();
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            injectTriggerButton();
        }
    }).observe(document, {subtree: true, childList: true});

    injectTriggerButton();

    // Trigger workflow recovery on page load
    if (sessionStorage.getItem(STATE_KEY)) {
        setTimeout(doWorkflow, 1000);
    }

})();
