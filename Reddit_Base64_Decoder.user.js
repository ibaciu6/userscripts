// ==UserScript==
// @name         Reddit Base64 Decoder
// @namespace    https://greasyfork.org/users/1631012-ionut-baciu
// @version      1.0.0
// @description  Automatically base64 decode links in reddit posts and comments (old and new reddit). No dependencies.
// @author       ionut-baciu
// @homepageURL  https://github.com/ibaciu6/userscripts
// @supportURL   https://github.com/ibaciu6/userscripts/issues
// @match        https://*.reddit.com/*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

/*
 * Improved rewrite of "Reddit Base64 Decoder" by EliteDaMyth
 * https://openuserjs.org/users/EliteDaMyth (MIT License).
 * Changes: supports the new (shreddit) reddit layout, base64url tokens,
 * comments and lazily loaded content; format-preserving text-node replacement.
 */

'use strict';

// candidate base64 token: long-ish run of base64/base64url chars, optional padding
const TOKEN_RE = /^[A-Za-z0-9+/_-]{12,}={0,2}$/;

/**
 * Try to decode a token as base64 (or base64url) into a URL.
 * @param {string} token
 * @returns {string|null} the decoded URL, or null if not a valid decodable link
 */
function tryDecodeToken(token) {
  if (!TOKEN_RE.test(token)) return null;

  // accept base64url alphabet
  let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);

  let decoded;
  try {
    decoded = atob(b64);
  } catch (_) {
    return null;
  }

  // must be a printable-ASCII http(s) URL
  if (!/^https?:\/\/[!-~]+$/.test(decoded)) return null;

  return decoded;
}

/**
 * Build an anchor element for a decoded URL.
 * @param {string} url
 * @returns {HTMLAnchorElement}
 */
function makeLink(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = url;
  a.style.textDecoration = 'underline';
  a.style.borderBottom = `1px dotted ${url.startsWith('https://') ? '#036' : '#f00'}`;
  return a;
}

/**
 * Scan text nodes under `root` and replace base64 tokens that decode to URLs.
 * Operates on text nodes so surrounding formatting and links are preserved.
 * @param {Element|Document} root
 */
function decodeWithin(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'SCRIPT' || tag === 'STYLE') {
        return NodeFilter.FILTER_REJECT;
      }
      // quick reject: no run of >=12 base64 chars in this text
      if (!/[A-Za-z0-9+/_-]{12,}/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  for (const textNode of targets) {
    const parts = textNode.nodeValue.split(/(\s+)/);
    let changed = false;
    const frag = document.createDocumentFragment();

    for (const part of parts) {
      const url = tryDecodeToken(part);
      if (url) {
        frag.appendChild(makeLink(url));
        changed = true;
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }

    if (changed) textNode.parentNode.replaceChild(frag, textNode);
  }
}

// Containers holding user text, on both layouts
const CONTAINER_SELECTORS = [
  'shreddit-post-text-body',           // new reddit: post body on the comments page
  '[id$="-post-rtjson-content"]',      // new reddit: the .md div inside the post body
  '#post-text',                         // new reddit: post body on other views
  'shreddit-comment',                   // new reddit: comments
  '.usertext-body',                     // old reddit: comments / selftext
  '.expando',                           // old reddit: post expando
  '#bodyBlock',                         // old reddit profile
].join(', ');

function scanAll() {
  for (const el of document.querySelectorAll(CONTAINER_SELECTORS)) {
    decodeWithin(el);
  }
}

// Debounced rescan for reddit's lazy-rendered content
let timer = null;
function scheduleScan() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    scanAll();
  }, 250);
}

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true });

scanAll();
window.addEventListener('load', scanAll);
