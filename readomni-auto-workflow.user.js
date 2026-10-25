// ==UserScript==
// @name         ReadOmni Auto-Workflow
// @namespace    https://github.com/tiklii/userscripts
// @version      2.3
// @description  Automates ReadOmni empty thread creation, chunked multi-file glossary importing, and renaming with seamless in-page UI integration, mobile drawer support, and guardrails.
// @author       tiklii
// @match        https://app.readomni.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // State Keys for SessionStorage
    const STATE_KEY = 'ro_wf_state';
    const CSV_LIST_KEY = 'ro_wf_csv_list';
    const NAME_KEY = 'ro_wf_name';
    const TARGET_THREAD_ID_KEY = 'ro_wf_target_thread_id';
    const TIMESTAMP_KEY = 'ro_wf_timestamp';
    const MAX_WORKFLOW_AGE_MS = 5 * 60 * 1000; // 5 minute expiration
    const GLOSSARY_CHUNK_SIZE = 4000; // ReadOmni limit is 5000; chunk at 4000 for safety

    let isRunning = false;
    let isAborted = false;

    // --- HELPER FUNCTIONS ---

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function checkAbort() {
        if (isAborted || !sessionStorage.getItem(STATE_KEY)) {
            throw new Error("WORKFLOW_CANCELLED");
        }
    }

    async function sleepWithAbort(ms) {
        const step = 100;
        let elapsed = 0;
        while (elapsed < ms) {
            checkAbort();
            await sleep(Math.min(step, ms - elapsed));
            elapsed += step;
        }
        checkAbort();
    }

    // Waits for an element to appear in the DOM
    async function waitForElement(selector, textFilter = null, exactText = false, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const endTime = Date.now() + timeout;
            const check = () => {
                if (isAborted || !sessionStorage.getItem(STATE_KEY)) {
                    return reject(new Error("WORKFLOW_CANCELLED"));
                }
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
                    setTimeout(check, 200);
                }
            };
            check();
        });
    }

    // Waits for an element to be unmounted / closed
    async function waitForElementToDisappear(selector, timeout = 25000) {
        const endTime = Date.now() + timeout;
        while (document.querySelector(selector)) {
            checkAbort();
            if (Date.now() > endTime) {
                console.warn(`Timeout waiting for ${selector} to disappear.`);
                break;
            }
            await sleep(250);
        }
    }

    // Searches for an action item across Desktop Dropdowns ([role="menuitem"]) and Mobile Drawers ([data-slot="drawer-content"] button)
    async function findActionItem(textFilter, timeout = 8000) {
        const endTime = Date.now() + timeout;
        while (Date.now() < endTime) {
            checkAbort();
            const candidates = Array.from(document.querySelectorAll(
                '[role="menuitem"], [data-slot="drawer-content"] button, [data-slot="drawer-body"] button, [role="dialog"] button'
            ));
            const target = candidates.find(el => {
                const txt = el.textContent.trim();
                return txt.includes(textFilter) && !el.getAttribute('aria-label')?.includes('Close');
            });
            if (target) return target;
            await sleep(200);
        }
        throw new Error(`Action item containing "${textFilter}" not found`);
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

    // Single-event activation supporting Base UI, Radix, Drawers, and React synthetic events
    function reactClick(element) {
        if (!element) return;
        element.focus();

        const mouseOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
        try {
            element.dispatchEvent(new PointerEvent('pointerdown', { ...mouseOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
            element.dispatchEvent(new PointerEvent('pointerup', { ...mouseOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        } catch (e) {
            element.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
            element.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        }

        if (typeof element.click === 'function') {
            element.click();
        } else {
            element.dispatchEvent(new MouseEvent('click', mouseOpts));
        }

        if (element.getAttribute('role') === 'menuitem') {
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
    }

    // Parses files and automatically splits large sets into chunks of GLOSSARY_CHUNK_SIZE (4000)
    async function parseCsvFiles(files) {
        const csvChunks = [];
        const isHeader = (line) => /^raw,translation|^term,translation/i.test(line);

        for (let i = 0; i < files.length; i++) {
            let text = await files[i].text();
            text = text.replace(/^\uFEFF/, ''); // Strip UTF-8 BOM if present
            let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (lines.length > 0 && isHeader(lines[0])) {
                lines.shift();
            }

            for (let j = 0; j < lines.length; j += GLOSSARY_CHUNK_SIZE) {
                const chunk = lines.slice(j, j + GLOSSARY_CHUNK_SIZE);
                if (chunk.length > 0) {
                    csvChunks.push(chunk.join('\n'));
                }
            }
        }
        return csvChunks;
    }

    function getNextThreadName(filename) {
        let namePart = filename.replace(/\.csv$/i, '');
        namePart = namePart.replace(/\s*\(\d+\)$/, '');
        namePart = namePart.replace(/^glossary-(?:\d+of\d+-)?/i, '');

        const match = namePart.match(/(.*?)(\d+)$/);
        if (match) {
            let textPart = match[1];
            let numberPart = parseInt(match[2], 10);
            return textPart + (numberPart + 1);
        } else {
            return namePart + "1";
        }
    }

    function clearWorkflowState() {
        sessionStorage.removeItem(STATE_KEY);
        sessionStorage.removeItem(CSV_LIST_KEY);
        sessionStorage.removeItem(NAME_KEY);
        sessionStorage.removeItem(TARGET_THREAD_ID_KEY);
        sessionStorage.removeItem(TIMESTAMP_KEY);
        removeStatusBanner();
    }

    function isStateExpired() {
        const timestamp = parseInt(sessionStorage.getItem(TIMESTAMP_KEY) || '0', 10);
        return !timestamp || (Date.now() - timestamp > MAX_WORKFLOW_AGE_MS);
    }

    // --- UI STATUS INDICATOR & LIVE CONTROLS ---

    function updateStatusBanner(text) {
        let banner = document.getElementById('ro-workflow-status-banner');
        if (!text) {
            if (banner) banner.remove();
            return;
        }

        const isMobile = window.innerWidth < 768;

        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'ro-workflow-status-banner';
            Object.assign(banner.style, {
                position: 'fixed',
                top: isMobile ? '64px' : '16px',
                left: '50%',
                transform: 'translateX(-50%)',
                          zIndex: '9999999',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '6px 14px',
                          backgroundColor: 'rgba(24, 24, 27, 0.95)',
                          color: '#fafafa',
                          borderRadius: '9999px',
                          boxShadow: '0 10px 25px -5px rgba(0,0,0,0.4), 0 8px 10px -6px rgba(0,0,0,0.3)',
                          fontSize: '12.5px',
                          fontWeight: '500',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          backdropFilter: 'blur(8px)',
                          userSelect: 'none',
                          maxWidth: 'calc(100vw - 32px)',
                          whiteSpace: 'nowrap'
            });

            const spinner = document.createElement('span');
            spinner.id = 'ro-status-spinner';
            Object.assign(spinner.style, {
                width: '13px',
                height: '13px',
                border: '2px solid rgba(255, 255, 255, 0.25)',
                          borderTopColor: '#ffffff',
                          borderRadius: '50%',
                          display: 'inline-block',
                          flexShrink: '0',
                          animation: 'ro-spin 0.8s linear infinite'
            });

            if (!document.getElementById('ro-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'ro-spinner-style';
                style.textContent = '@keyframes ro-spin { to { transform: rotate(360deg); } }';
                document.head.appendChild(style);
            }

            banner.appendChild(spinner);

            const msgSpan = document.createElement('span');
            msgSpan.id = 'ro-status-msg';
            msgSpan.style.overflow = 'hidden';
            msgSpan.style.textOverflow = 'ellipsis';
            banner.appendChild(msgSpan);

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.innerText = 'Cancel';
            Object.assign(cancelBtn.style, {
                backgroundColor: '#dc2626',
                color: '#ffffff',
                border: 'none',
                borderRadius: '9999px',
                padding: '3px 10px',
                fontSize: '11px',
                fontWeight: '600',
                cursor: 'pointer',
                flexShrink: '0',
                marginLeft: '4px'
            });

            cancelBtn.onclick = () => {
                console.warn("[ReadOmni-Workflow] Terminated by user.");
                isAborted = true;
                clearWorkflowState();
                removeStatusBanner();
            };

            banner.appendChild(cancelBtn);
            document.body.appendChild(banner);
        }

        const msgSpan = banner.querySelector('#ro-status-msg');
        if (msgSpan) msgSpan.textContent = text;
    }

    function removeStatusBanner() {
        const banner = document.getElementById('ro-workflow-status-banner');
        if (banner) banner.remove();
    }

    // --- MAIN WORKFLOW ---

    async function startWorkflow(files) {
        try {
            console.log("[ReadOmni-Workflow] Starting workflow with", files.length, "file(s)...");

            const nextName = getNextThreadName(files[0].name);
            const csvChunks = await parseCsvFiles(files);

            console.log(`[ReadOmni-Workflow] Target thread name: "${nextName}" | Total batch chunks: ${csvChunks.length}`);

            isAborted = false;
            sessionStorage.setItem(CSV_LIST_KEY, JSON.stringify(csvChunks));
            sessionStorage.setItem(NAME_KEY, nextName);
            sessionStorage.setItem(TIMESTAMP_KEY, Date.now().toString());
            sessionStorage.setItem(STATE_KEY, 'STEP_CREATE_THREAD');

            updateStatusBanner(`Creating empty thread for "${nextName}"...`);

            if (window.location.pathname !== '/library') {
                window.location.href = '/library';
            } else {
                doWorkflow();
            }

        } catch (error) {
            console.error("[ReadOmni-Workflow] Error during startup:", error);
            alert("Workflow stopped due to an error. Check console.");
            clearWorkflowState();
        }
    }

    async function doWorkflow() {
        if (isRunning) return;

        let state = sessionStorage.getItem(STATE_KEY);
        if (!state) return;

        if (isStateExpired()) {
            console.warn("[ReadOmni-Workflow] Stale workflow state detected. Purging state.");
            clearWorkflowState();
            return;
        }

        isRunning = true;

        try {
            const csvListRaw = sessionStorage.getItem(CSV_LIST_KEY);
            const csvList = csvListRaw ? JSON.parse(csvListRaw) : [];
            const nextName = sessionStorage.getItem(NAME_KEY);
            const lockedThreadId = sessionStorage.getItem(TARGET_THREAD_ID_KEY);

            // Guardrail: Strict Thread ID check
            const currentThreadId = window.location.pathname.match(/\/thread\/([a-zA-Z0-9-]+)/)?.[1];
            if (lockedThreadId && currentThreadId && currentThreadId !== lockedThreadId) {
                console.warn(`[ReadOmni-Workflow] SAFETY ABORT: Opened thread (${currentThreadId}) !== target thread (${lockedThreadId}). Aborting.`);
                clearWorkflowState();
                return;
            }

            // STEP 1: Create an Empty Thread from Library
            if (state === 'STEP_CREATE_THREAD') {
                updateStatusBanner("Opening Library thread creator...");

                if (window.location.pathname !== '/library') {
                    window.location.href = '/library';
                    return;
                }

                const newThreadBtn = await waitForElement('button', 'New thread', false, 10000);
                reactClick(newThreadBtn);
                await sleepWithAbort(500);

                const emptyThreadBtn = await waitForElement('button', 'Empty thread', false, 8000);
                sessionStorage.setItem(STATE_KEY, 'STEP_GLOSSARY_TAB');
                reactClick(emptyThreadBtn);

                emptyThreadBtn.disabled = true;
                emptyThreadBtn.style.pointerEvents = 'none';

                updateStatusBanner("Waiting for new thread page...");
                const navStart = Date.now();
                while (!window.location.pathname.startsWith('/thread/') && Date.now() - navStart < 15000) {
                    await sleepWithAbort(250);
                }

                if (!window.location.pathname.startsWith('/thread/')) {
                    throw new Error("Navigation to created thread timed out.");
                }

                const createdId = window.location.pathname.match(/\/thread\/([a-zA-Z0-9-]+)/)?.[1];
                if (createdId) {
                    sessionStorage.setItem(TARGET_THREAD_ID_KEY, createdId);
                    console.log(`[ReadOmni-Workflow] Locked to target thread ID: ${createdId}`);
                }

                state = 'STEP_GLOSSARY_TAB';
                await sleepWithAbort(400);
            }

            // STEP 2: Navigate to Glossary View on Thread Page
            if (state === 'STEP_GLOSSARY_TAB') {
                updateStatusBanner(`Opening Glossary for "${nextName}"...`);
                await waitForElement('h1', null, false, 15000);

                const isAlreadyGlossary = window.location.search.includes('tab=glossary') ||
                document.querySelector('button[role="tab"][data-active]')?.textContent.includes('Glossary');

                if (!isAlreadyGlossary) {
                    const glossaryTarget = document.querySelector('a[href*="tab=glossary"]') ||
                    Array.from(document.querySelectorAll('button[role="tab"], button, a'))
                    .find(el => el.textContent.trim().includes('Glossary'));

                    if (glossaryTarget) {
                        reactClick(glossaryTarget);
                    } else {
                        const target = await waitForElement('a[href*="tab=glossary"], button[role="tab"], button, a', 'Glossary', false, 8000);
                        reactClick(target);
                    }

                    await waitForElement('button[aria-label="Glossary tools"], button[aria-label="More actions"], [data-slot="empty-content"] button', null, false, 10000);
                }

                sessionStorage.setItem(STATE_KEY, 'STEP_IMPORT_GLOSSARY');
                state = 'STEP_IMPORT_GLOSSARY';
            }

            // STEP 3: Import Glossary CSVs Sequentially in Chunks of <= 4000
            if (state === 'STEP_IMPORT_GLOSSARY') {
                await waitForElement('button[aria-label="Glossary tools"], button[aria-label="More actions"], [data-slot="empty-content"] button', null, false, 10000);

                for (let i = 0; i < csvList.length; i++) {
                    checkAbort();
                    updateStatusBanner(`Importing batch ${i + 1} of ${csvList.length}...`);

                    let bulkTextarea = document.querySelector('textarea[name="input"]');

                    if (!bulkTextarea) {
                        const emptyImportBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Import a CSV');

                        if (emptyImportBtn) {
                            console.log("[ReadOmni-Workflow] [STEP 3] Clicking empty-state 'Import a CSV' button...");
                            reactClick(emptyImportBtn);
                            await sleepWithAbort(500);
                        } else {
                            let moreActionsBtn = document.querySelector('button[aria-label="Glossary tools"]') ||
                            document.querySelector('button[aria-label="More actions"]');

                            if (!moreActionsBtn) {
                                const tabPanel = document.querySelector('[role="tabpanel"]') || document;
                                moreActionsBtn = Array.from(tabPanel.querySelectorAll('button')).find(b => {
                                    return b.querySelector('svg.lucide-ellipsis, svg.lucide-more-horizontal') &&
                                    !b.getAttribute('aria-label')?.includes('Thread');
                                });
                            }

                            if (!moreActionsBtn) {
                                moreActionsBtn = await waitForElement(
                                    'button[aria-label="Glossary tools"], button[aria-label="More actions"], button:has(svg.lucide-more-horizontal)',
                                                                      null, false, 8000
                                );
                            }

                            console.log("[ReadOmni-Workflow] [STEP 3] Opening glossary tools menu...");
                            reactClick(moreActionsBtn);
                            await sleepWithAbort(500);

                            console.log("[ReadOmni-Workflow] [STEP 3] Selecting 'Import CSV'...");
                            const importItem = await findActionItem('Import CSV', 6000);
                            reactClick(importItem);
                            await sleepWithAbort(600);
                        }

                        bulkTextarea = await waitForElement('textarea[name="input"]', null, false, 8000);
                    }

                    // Paste CSV terms for this chunk
                    setReactInputValue(bulkTextarea, csvList[i]);
                    await sleepWithAbort(250);

                    const submitTermsBtn = await waitForElement('button[form="import-csv"], button[type="submit"]', 'Import', false, 5000);
                    reactClick(submitTermsBtn);

                    // Wait for modal to process and close
                    updateStatusBanner(`Saving batch ${i + 1} of ${csvList.length}...`);
                    await waitForElementToDisappear('textarea[name="input"]', 25000);
                    await sleepWithAbort(600);
                }

                console.log("[ReadOmni-Workflow] [STEP 3] All glossary files successfully imported!");

                sessionStorage.setItem(STATE_KEY, 'STEP_RENAME_THREAD');
                state = 'STEP_RENAME_THREAD';

                // Return from Glossary subpage on mobile only
                const isMobile = window.innerWidth < 768;
                if (isMobile && window.location.search.includes('tab=glossary')) {
                    updateStatusBanner("Returning to thread view...");
                    console.log("[ReadOmni-Workflow] Mobile: navigating back from Glossary subpage...");
                    const mobileBackBtn = document.querySelector('header button[aria-label="Back"]');
                    if (mobileBackBtn) {
                        reactClick(mobileBackBtn);
                        await sleepWithAbort(600);
                    }
                }

                await waitForElement('button[aria-label="Thread actions"]', null, false, 10000);
            }

            // STEP 4: Rename Thread, Save, Click "+", and Select "Translate a URL or text"
            if (state === 'STEP_RENAME_THREAD') {
                updateStatusBanner(`Renaming thread to "${nextName}"...`);
                console.log(`[ReadOmni-Workflow] [STEP 4] Renaming Thread to: "${nextName}"...`);

                const threadMenuBtn = await waitForElement('button[aria-label="Thread actions"]', null, false, 10000);
                reactClick(threadMenuBtn);
                await sleepWithAbort(500);

                console.log("[ReadOmni-Workflow] [STEP 4] Clicking 'Rename, tags and note'...");
                const renameItem = await findActionItem('Rename', 6000);
                reactClick(renameItem);
                await sleepWithAbort(600);

                const titleInput = await waitForElement('input[name="title"]', null, false, 6000);
                setReactInputValue(titleInput, nextName);
                await sleepWithAbort(250);

                const saveBtn = await waitForElement('button[type="submit"]', 'Save', false, 5000);
                reactClick(saveBtn);
                console.log("[ReadOmni-Workflow] [STEP 4] New title saved.");

                await waitForElementToDisappear('input[name="title"]', 6000);
                await sleepWithAbort(500);

                // Switch to Translation tab on desktop if not active
                const isDesktop = window.innerWidth >= 768;
                if (isDesktop) {
                    const translationTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                    .find(b => b.textContent.trim().includes('Translation'));
                    if (translationTab && !translationTab.hasAttribute('data-active')) {
                        reactClick(translationTab);
                        await sleepWithAbort(500);
                    }
                }

                // Click "+" (Add translations) button on the thread page
                updateStatusBanner("Opening translation options (+)...");
                console.log("[ReadOmni-Workflow] [STEP 4] Clicking '+' (Add translations) button...");
                const addTranslationsBtn = await waitForElement('button[aria-label="Add translations"], button:has(svg.lucide-plus)', null, false, 8000);
                reactClick(addTranslationsBtn);
                await sleepWithAbort(600);

                // Click "Translate a URL or text"
                updateStatusBanner("Opening translate...");
                console.log("[ReadOmni-Workflow] [STEP 4] Clicking 'Translate a URL or text'...");
                const translateUrlOption = await findActionItem('Translate a URL or text', 6000);
                reactClick(translateUrlOption);

                const finalThreadId = sessionStorage.getItem(TARGET_THREAD_ID_KEY) || window.location.pathname.match(/\/thread\/([a-zA-Z0-9-]+)/)?.[1];
                updateStatusBanner(`✅ Finished!`);

                clearWorkflowState();

                await sleep(1500);
                if (finalThreadId && !window.location.search.includes('thread=')) {
                    window.location.href = `/?thread=${finalThreadId}`;
                }
            }

        } catch (error) {
            if (error.message === 'WORKFLOW_CANCELLED') {
                console.log("[ReadOmni-Workflow] Workflow successfully cancelled by user.");
            } else {
                console.error("[ReadOmni-Workflow] Error during execution:", error);
                alert("Workflow stopped due to an error. Check console.");
            }
            clearWorkflowState();
        } finally {
            isRunning = false;
        }
    }

    // --- SEAMLESS IN-PAGE UI INJECTION ---

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
        const isCleanHome = window.location.pathname === '/' && window.location.search === '';
        const isLibrary = window.location.pathname === '/library';

        if (!isCleanHome && !isLibrary) {
            const existingBtn = document.getElementById('ro-workflow-btn');
            if (existingBtn) existingBtn.remove();
            return;
        }

        // Avoid duplicate injections if already placed inside a valid container
        const existingBtn = document.getElementById('ro-workflow-btn');
        if (existingBtn && existingBtn.parentElement && existingBtn.parentElement !== document.body) {
            return;
        }
        if (existingBtn) {
            existingBtn.remove();
        }

        const isMobile = window.innerWidth < 768;

        const btn = document.createElement('button');
        btn.id = 'ro-workflow-btn';
        btn.type = 'button';
        btn.onclick = triggerFilePickerAndStart;
        btn.innerHTML = '🚀<span class="ml-1.5 font-medium">Workflow</span>';
        btn.className = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs sm:text-sm font-medium transition-[color,box-shadow] border border-border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground h-8 sm:h-9 px-2.5 sm:px-3 gap-1 cursor-pointer";

        // 1. On / (Translate Home): Embed cleanly in the H1 heading row above the textarea
        if (isCleanHome) {
            const homeHeading = document.querySelector('h1:has(button[aria-label*="Thread"])') ||
            Array.from(document.querySelectorAll('h1')).find(h => h.textContent.includes('Translate into'));

            if (homeHeading) {
                btn.style.marginLeft = 'auto';
                btn.style.alignSelf = 'center';
                homeHeading.appendChild(btn);
                return;
            }

            // Fallback: Embed inside the form's bottom action bar
            const formToolbar = document.querySelector('form .flex.items-center.justify-between') ||
            document.querySelector('form .flex.items-center.gap-0\\.5');
            if (formToolbar) {
                btn.classList.add('h-7', 'text-xs', 'px-2');
                formToolbar.appendChild(btn);
                return;
            }
        }

        // 2. On /library
        if (isLibrary) {
            // Desktop: Place beside "New thread" button
            const newThreadBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('New thread'));
            if (newThreadBtn && newThreadBtn.parentElement) {
                newThreadBtn.parentElement.insertBefore(btn, newThreadBtn);
                return;
            }

            // Mobile: Place in the toolbar next to search/filters
            const searchToolbar = document.querySelector('.sticky .flex.flex-wrap.items-center') ||
            document.querySelector('.container .flex.flex-wrap.items-center');
            if (searchToolbar) {
                btn.classList.add('h-9', 'text-xs', 'px-2.5');
                searchToolbar.appendChild(btn);
                return;
            }
        }
    }

    // Debounced Observer for URL changes
    let lastUrl = location.href;
    let observerTimeout = null;

    new MutationObserver(() => {
        if (observerTimeout) return;
        observerTimeout = setTimeout(() => {
            observerTimeout = null;
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                injectTriggerButton();
                if (!isRunning && sessionStorage.getItem(STATE_KEY)) {
                    doWorkflow();
                }
            } else {
                injectTriggerButton();
            }
        }, 150);
    }).observe(document, { subtree: true, childList: true });

    injectTriggerButton();

    // Trigger workflow recovery on page load if active and not expired
    if (sessionStorage.getItem(STATE_KEY) && !isStateExpired()) {
        setTimeout(doWorkflow, 800);
    } else if (isStateExpired()) {
        clearWorkflowState();
    }

})();
