// ==UserScript==
// @name         Google Translate Mobile: Sticky Native Clear Button
// @namespace    http://violentmonkey.net/
// @version      2.0
// @description  Hijacks the native "x" button and forces it to follow you as you scroll.
// @match        *://translate.google.com/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    // We use pure CSS to hijack Google's native button.
    // This is bulletproof: when you have no text, Google deletes the button, so it hides naturally.
    // When you paste text, Google creates it, and our CSS instantly makes it follow your scroll.

    const css = `
    /* Target the exact aria-label from the native Google button */
    button[aria-label="Clear source text"],
    button[aria-label="Clear text"] {
        /* Rip it out of the normal layout and pin it to the screen */
        position: fixed !important;
        top: 80px !important; /* Keeps it right near the top as you scroll down */
        right: 16px !important;
        z-index: 2147483647 !important; /* Absolute maximum z-index */

        /* Give it a semi-transparent background so you can read text behind it */
        background-color: rgba(255, 255, 255, 0.75) !important;
        backdrop-filter: blur(4px) !important;
        -webkit-backdrop-filter: blur(4px) !important; /* For iOS Safari */

        /* Make it a perfect circle with a subtle drop shadow */
        border-radius: 50% !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2) !important;

        /* Set default transparency so it isn't distracting */
        opacity: 0.6 !important;
        transition: opacity 0.2s ease, background-color 0.2s ease !important;
    }

    /* Make it fully opaque when you tap it */
    button[aria-label="Clear source text"]:active,
    button[aria-label="Clear text"]:active {
        opacity: 1 !important;
        background-color: rgba(255, 255, 255, 1) !important;
    }
    `;

    // Inject the CSS styles
    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
    } else {
        const style = document.createElement('style');
        style.textContent = css;

        // Ensure it gets added to the page
        const injectStyles = () => {
            if (!document.head.contains(style)) {
                document.head.appendChild(style);
            }
        };

        // Standard injection
        if (document.head) {
            injectStyles();
        } else {
            window.addEventListener('DOMContentLoaded', injectStyles);
        }

        // Just in case Google Translate does a massive hard-refresh of the <head>
        const observer = new MutationObserver(injectStyles);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
