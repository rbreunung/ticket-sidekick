export function generateOwaUserscript(config: {
  owaUrl: string;
  vscodeUriBase: string;
}): string {
  const { owaUrl, vscodeUriBase } = config;
  const rawOwaUrl = owaUrl.replace(/[\r\n]/g, '');
  let safeOwaUrl: string;
  try {
    safeOwaUrl = new URL(rawOwaUrl).origin;
  } catch {
    safeOwaUrl = rawOwaUrl.replace(/\/+$/, '');
  }
  const safeVscodeUri = vscodeUriBase.replace(/[\r\n]/g, '').replace(/'/g, '%27').replace(/\\/g, '/');
  return `// ==UserScript==
// @name         Ticket Sidekick — OWA to Jira
// @namespace    https://ticket-sidekick
// @version      1.0
// @description  Capture OWA email and send to Ticket Sidekick in VS Code
// @author       Ticket Sidekick
// @match        ${safeOwaUrl}/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const VSCODE_URI = '${safeVscodeUri}/from-email';
  const FOLDER_PREFIX = 'TicketSidekick/';

  function getReadingPane() {
    // New Outlook (outlook.cloud.microsoft) — persistent container
    return document.querySelector('.wide-content-host')
      || document.querySelector('[data-testid="reading-pane"]')
      || document.querySelector('[aria-label="Reading Pane"]')
      || document.querySelector('.ReadingPane');
  }

  function getSubject() {
    // New Outlook: subject heading above the sender row
    return (
      document.querySelector('[data-testid="subject"]')?.textContent?.trim()
      || document.querySelector('[data-testid="ConversationTopic"]')?.textContent?.trim()
      || document.querySelector('[aria-label^="Email subject"]')?.textContent?.trim()
      || document.querySelector('[role="heading"][aria-level="2"]')?.textContent?.trim()
      || document.querySelector('h1')?.textContent?.trim()
      || '(no subject)'
    );
  }

  function getSenderName() {
    // New Outlook: aria-label="Von: Name" (DE) / "From: Name" (EN)
    const fromEl = document.querySelector('[aria-label^="Von: "], [aria-label^="From: "]');
    if (fromEl) {
      const label = fromEl.getAttribute('aria-label') || '';
      return label.replace(/^(Von|From):\\s*/i, '').replace(/<[^>]+>/, '').trim() || 'Unknown';
    }
    return (
      document.querySelector('[data-testid="sender-name"]')?.textContent?.trim()
      || 'Unknown'
    );
  }

  function getReceivedDateTime() {
    // New Outlook: data-testid="SentReceivedSavedTime"
    // ISO-like format: "Fr, 2026-05-22 15:22" (corporate)
    // EU format: "Di, 14.04.2020 08:51" (Hotmail/personal, DD.MM.YYYY)
    const dateEl = document.querySelector('[data-testid="SentReceivedSavedTime"]');
    if (dateEl) {
      const text = dateEl.textContent || '';
      const isoMatch = text.match(/(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{2}:\\d{2})/);
      if (isoMatch) {
        try { return new Date(isoMatch[1] + 'T' + isoMatch[2] + ':00').toISOString(); } catch (_) {}
      }
      const euMatch = text.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})\\s+(\\d{2}:\\d{2})/);
      if (euMatch) {
        try { return new Date(euMatch[3] + '-' + euMatch[2] + '-' + euMatch[1] + 'T' + euMatch[4] + ':00').toISOString(); } catch (_) {}
      }
    }
    return document.querySelector('time')?.getAttribute('datetime') || new Date().toISOString();
  }

  function getBodyElement() {
    // New Outlook: data-test-id uses a hyphen, not camelCase
    const newOutlook = document.querySelector('[data-test-id="mailMessageBodyContainer"] [role="document"]')
      || document.querySelector('[data-test-id="mailMessageBodyContainer"] .allowTextSelection');
    if (newOutlook) return newOutlook;
    const pane = getReadingPane();
    if (!pane) return null;
    for (const iframe of pane.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument?.body) return iframe.contentDocument.body;
      } catch (_) {}
    }
    return (
      pane.querySelector('[data-testid="message-body"]')
      || pane.querySelector('[aria-label="Message body"]')
      || pane.querySelector('.allowTextSelection')
    );
  }

  function blobDownload(content, name) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name,
        onload() { URL.revokeObjectURL(url); resolve(); },
        onerror(e) { URL.revokeObjectURL(url); reject(e); },
      });
    });
  }

  function fetchAndDownload(src, name) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: src,
        responseType: 'blob',
        onload(res) {
          const url = URL.createObjectURL(res.response);
          GM_download({
            url,
            name,
            onload() { URL.revokeObjectURL(url); resolve(); },
            onerror(e) { URL.revokeObjectURL(url); reject(e); },
          });
        },
        onerror: reject,
      });
    });
  }

  async function captureEmail(stripFooter) {
    const folder = Date.now().toString();
    const base = FOLDER_PREFIX + folder + '/';
    const subject = getSubject();
    const senderName = getSenderName();
    const receivedDateTime = getReceivedDateTime();

    const bodyEl = getBodyElement();
    if (!bodyEl) {
      alert('Ticket Sidekick: Could not find the email body. Make sure an email is open.');
      return;
    }

    const bodyClone = bodyEl.cloneNode(true);
    const inlineImages = [];
    const downloads = [];
    let imgIdx = 0;

    for (const img of bodyClone.querySelectorAll('img')) {
      const src = img.getAttribute('src') || img.src;
      if (!src || src.startsWith('data:')) { img.remove(); continue; }
      imgIdx++;
      const extMatch = src.match(/\\.([a-z]{2,4})(\\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const filename = 'email-image-' + imgIdx + '.' + ext;
      const mimeExt = ext === 'jpg' ? 'jpeg' : ext;
      img.setAttribute('data-ts-filename', filename);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      inlineImages.push({ filename, contentType: 'image/' + mimeExt });
      downloads.push(fetchAndDownload(src, base + filename));
    }

    const attachments = [];
    for (const link of document.querySelectorAll('[data-testid="attachment-item"] a')) {
      const href = link.href;
      const name = (link.textContent || link.title || '').trim();
      let parsedHref;
      try { parsedHref = new URL(href, location.href); } catch (_) { parsedHref = null; }
      if (parsedHref && ['http:', 'https:'].includes(parsedHref.protocol) && name) {
        const safeName = name.replace(/[/\\\\:*?"<>|]/g, '_');
        attachments.push({ filename: safeName, contentType: 'application/octet-stream' });
        downloads.push(fetchAndDownload(href, base + safeName));
      }
    }

    await Promise.all(downloads);
    await blobDownload(bodyClone.innerHTML, base + 'email-body.html');
    await blobDownload(
      JSON.stringify({
        subject, senderName, receivedDateTime,
        bodyFile: 'email-body.html',
        stripFooter: !!stripFooter,
        inlineImages, attachments,
      }, null, 2),
      base + 'email.json',
    );

    // 1.5 s soft head-start before VS Code polling begins; downloads continue uninterrupted
    // (window.location.href to a vscode:// URI hands off to the OS — does not navigate away)
    setTimeout(() => {
      window.location.href = VSCODE_URI + '?folder=' + folder;
    }, 1500);
  }

  function injectButtons(pane) {
    // New Outlook: fui-Toolbar is the main message toolbar (Reply, Forward, …)
    // Quick-actions bar at the bottom also has role="toolbar" — skip it (has aria-label)
    const toolbar = (
      pane.querySelector('.fui-Toolbar[role="toolbar"]')
      || pane.querySelector('[data-testid="reading-pane-toolbar"]')
      || pane.querySelector('[role="toolbar"]:not([aria-label])')
      || pane.firstElementChild
    );
    if (!toolbar) return;
    // Guard: avoid double-injection when MutationObserver fires on content swap
    if (toolbar.querySelector('[data-ts-btn]')) return;

    function makeBtn(label, stripFooter) {
      const btn = document.createElement('button');
      btn.dataset.tsBtn = '1';
      btn.textContent = label;
      btn.title = stripFooter ? 'Create Jira ticket (AI footer removal)' : 'Create Jira ticket';
      btn.style.cssText = 'margin:2px 4px;padding:3px 8px;cursor:pointer;font-size:12px;'
        + 'border:1px solid #888;border-radius:3px;background:#f5f5f5;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        captureEmail(stripFooter).catch((err) => alert('Ticket Sidekick: Capture failed — ' + String(err)));
      });
      return btn;
    }

    toolbar.appendChild(makeBtn('📋 To Ticket', false));
    toolbar.appendChild(makeBtn('📋✨ To Ticket (Clean)', true));
  }

  const observer = new MutationObserver(() => {
    const pane = getReadingPane();
    if (pane) injectButtons(pane);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
`;
}
