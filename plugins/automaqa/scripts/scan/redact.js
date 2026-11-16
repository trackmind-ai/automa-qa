// Best-effort screenshot redaction for automaqa:scan.
//   await injectRedaction(page, { selectors: ['.patient-name'] });  // blur patterns + flagged elements
//   await page.screenshot(...);
//   await removeRedaction(page);                                    // restore the DOM exactly
// Pattern-based: emails, phone numbers, DOB values, street addresses, long digit strings.
// NAMES ARE NOT DETECTED. Say so in the document; in production take no screenshots without approval.

const PATTERNS = [
  ['email', '[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}'],
  ['phone', '(?:\\+?\\d{1,3}[\\s.\\-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{4}\\b'],
  ['dob', '(?:DOB|Date of Birth|Birth ?date)\\s*[:\\-]?\\s*[0-9/\\-.]{6,10}'],
  ['address', '\\b\\d{1,5}\\s+[A-Za-z0-9.\\s]{2,30}\\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\\b\\.?'],
  ['digits', '\\b\\d{9,}\\b'],
];

async function injectRedaction(page, { selectors = [] } = {}) {
  return page.evaluate(({ PATTERNS, selectors }) => {
    const rx = new RegExp(PATTERNS.map(p => `(${p[1]})`).join('|'), 'g');
    if (!document.getElementById('aq-redact-style')) {
      const st = document.createElement('style'); st.id = 'aq-redact-style';
      st.textContent = '.aq-blur{filter:blur(7px)!important;user-select:none!important}';
      document.head.appendChild(st);
    }
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (!n.parentElement || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(n.parentElement.tagName) || n.parentElement.classList.contains('aq-blur')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const text = n.nodeValue; rx.lastIndex = 0;
      if (!rx.test(text)) continue;
      rx.lastIndex = 0;
      const frag = document.createDocumentFragment(); let last = 0, m;
      while ((m = rx.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const s = document.createElement('span'); s.className = 'aq-blur'; s.setAttribute('data-aq-redact', '1'); s.textContent = m[0];
        frag.appendChild(s); count++; last = m.index + m[0].length;
        if (m[0].length === 0) rx.lastIndex++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
    document.querySelectorAll('input[type=email],input[type=tel],input[type=password]').forEach(e => { e.classList.add('aq-blur'); e.setAttribute('data-aq-flag', '1'); count++; });
    for (const s of selectors) document.querySelectorAll(s).forEach(e => { e.classList.add('aq-blur'); e.setAttribute('data-aq-flag', '1'); count++; });
    return count;
  }, { PATTERNS, selectors });
}

async function removeRedaction(page) {
  return page.evaluate(() => {
    document.querySelectorAll('span[data-aq-redact]').forEach(s => s.replaceWith(document.createTextNode(s.textContent)));
    document.querySelectorAll('[data-aq-flag]').forEach(e => { e.classList.remove('aq-blur'); e.removeAttribute('data-aq-flag'); });
    document.body.normalize();
    const st = document.getElementById('aq-redact-style'); if (st) st.remove();
  });
}

module.exports = { injectRedaction, removeRedaction, PATTERNS };
