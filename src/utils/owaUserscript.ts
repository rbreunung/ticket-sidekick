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
// @version      1.1
// @description  Capture OWA email and send to Ticket Sidekick in VS Code
// @author       Ticket Sidekick
// @match        ${safeOwaUrl}/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const VSCODE_URI = '${safeVscodeUri}/from-email';

  function getReadingPane() {
    // New Outlook (outlook.cloud.microsoft / outlook.live.com) — persistent container
    return document.querySelector('.wide-content-host')
      || document.querySelector('[data-testid="reading-pane"]')
      || document.querySelector('[aria-label="Reading Pane"]')
      || document.querySelector('.ReadingPane');
  }

  function getSubject() {
    // New Outlook: id ends with "_SUBJECT", first span[title] holds the subject text
    return (
      document.querySelector('[id$="_SUBJECT"] span[title]')?.getAttribute('title')?.trim()
      || document.querySelector('[data-testid="subject"]')?.textContent?.trim()
      || document.querySelector('[data-testid="ConversationTopic"]')?.textContent?.trim()
      || document.querySelector('[aria-label^="Email subject"]')?.textContent?.trim()
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

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fetchAsBase64(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload(res) { resolve(arrayBufferToBase64(res.response)); },
        onerror(err) {
          reject(new Error('fetch failed: ' + (err.statusText || err.error || JSON.stringify(err))));
        },
      });
    });
  }

  async function captureEmail(stripFooter) {
    const timestamp = Date.now().toString();
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
    let imgIdx = 0;

    const fetches = [];

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
      const entry = { filename, contentType: 'image/' + mimeExt, dataBase64: '' };
      inlineImages.push(entry);
      fetches.push(fetchAsBase64(src).then(b64 => { entry.dataBase64 = b64; }).catch(() => {}));
    }

    // OWA attachment panel: id$="_ATTACHMENTS" contains a listbox of role="option" items.
    // There are no direct download URLs in the DOM — OWA serves files via an authenticated
    // session API. We detect the names and append them to the body so they appear in the
    // Jira description and the user knows what to attach manually.
    const attachmentListbox = document.querySelector('[id$="_ATTACHMENTS"] [role="listbox"]');
    if (attachmentListbox) {
      const names = [];
      for (const option of attachmentListbox.querySelectorAll('[role="option"]')) {
        const nameEl = option.querySelector('[title]');
        const name = nameEl?.getAttribute('title')?.trim();
        if (name) names.push(name);
      }
      if (names.length > 0) {
        bodyClone.innerHTML += '<p>&#128206; <strong>Attachments (attach to ticket manually):</strong> '
          + names.map(n => '<em>' + n + '</em>').join(', ') + '</p>';
      }
    }

    await Promise.all(fetches);

    const manifest = JSON.stringify({
      subject, senderName, receivedDateTime,
      stripFooter: !!stripFooter,
      bodyHtml: bodyClone.innerHTML,
      inlineImages: inlineImages.filter(e => e.dataBase64),
    }, null, 2);

    const blob = new Blob([manifest], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      GM_download({
        url,
        name: 'TicketSidekick-' + timestamp + '.json',
        onload() { URL.revokeObjectURL(url); resolve(); },
        onerror(err) {
          URL.revokeObjectURL(url);
          reject(new Error(err.error || err.statusText || 'GM_download failed'));
        },
      });
    });

    // 1.5 s soft head-start before VS Code polling begins
    // (window.location.href to a vscode:// URI hands off to the OS — does not navigate away)
    setTimeout(() => {
      window.location.href = VSCODE_URI + '?folder=' + timestamp;
    }, 1500);
  }

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

  function injectButtons(pane) {
    // New Outlook: fui-Toolbar is the main message toolbar (Reply, Forward, …)
    // Use querySelectorAll to inject into every email in a conversation thread.
    // Quick-actions bar at the bottom also has role="toolbar" — skip it (has aria-label)
    let toolbars = Array.from(pane.querySelectorAll('.fui-Toolbar[role="toolbar"]'));
    if (!toolbars.length) {
      const fb = pane.querySelector('[data-testid="reading-pane-toolbar"]')
        || pane.querySelector('[role="toolbar"]:not([aria-label])')
        || pane.firstElementChild;
      if (fb) toolbars = [fb];
    }
    for (const toolbar of toolbars) {
      if (toolbar.querySelector('[data-ts-btn]')) continue;
      toolbar.appendChild(makeBtn('📋 To Ticket', false));
      toolbar.appendChild(makeBtn('📋✨ To Ticket (Clean)', true));
    }
  }

  const observer = new MutationObserver(() => {
    const pane = getReadingPane();
    if (pane) injectButtons(pane);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
`;
}
