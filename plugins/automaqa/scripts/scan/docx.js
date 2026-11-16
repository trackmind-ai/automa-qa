// Minimal Word (.docx) writer — no dependencies. Headings, paragraphs (with **bold**), bullet lines, tables, page breaks.
//   const buf = buildDocx(blocks)      // blocks: { type:'h1'|'h2'|'h3'|'p'|'ul'|'table'|'note'|'pagebreak'|'title', ... }
//   docxText(buf) -> plain text of document.xml (used to check that the Word file carries the same IDs as the other outputs)
const zlib = require('zlib');

// ---- zip (deflate) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = Buffer.from(data, 'utf8'); const def = zlib.deflateRawSync(raw); const nm = Buffer.from(name); const crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nm, def);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm); off += 30 + nm.length + def.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function unzipEntry(buf, wanted) {
  let p = 0;
  while (p + 30 < buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const csize = buf.readUInt32LE(p + 18); const nlen = buf.readUInt16LE(p + 26); const xlen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nlen).toString(); const data = buf.slice(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    if (name === wanted) return zlib.inflateRawSync(data).toString('utf8');
    p += 30 + nlen + xlen + csize;
  }
  return null;
}

// ---- WordprocessingML ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function runs(text, base = '') {
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(part => {
    const b = /^\*\*[^*]+\*\*$/.test(part); const t = b ? part.slice(2, -2) : part;
    return `<w:r><w:rPr>${b ? '<w:b/>' : ''}${base}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  }).join('');
}
const para = (text, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${runs(text)}</w:p>`;
function table(columns, rows) {
  const w = Math.floor(9000 / Math.max(1, columns.length));
  const cell = (t, head) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF3EC"/>' : ''}</w:tcPr>${String(t ?? '').split('\n').map(line => `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${runs(line, head ? '<w:b/>' : '')}</w:p>`).join('')}</w:tc>`;
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBC4B8"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map(c => cell(c, true)).join('')}</w:tr>` +
    rows.map(r => `<w:tr>${columns.map((_, i) => cell(Array.isArray(r) ? r[i] : r[i], false)).join('')}</w:tr>`).join('') + `</w:tbl><w:p/>`;
}
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="52"/><w:color w:val="1B1F24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="3A6B35"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="FFF8E6"/></w:pPr><w:rPr><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;

function buildDocx(blocks) {
  let body = '';
  for (const b of blocks) {
    if (b.type === 'title') body += para(b.text, 'Title');
    else if (b.type === 'h1') body += para(b.text, 'Heading1', b.pageBreak ? '<w:pageBreakBefore/>' : '');
    else if (b.type === 'h2') body += para(b.text, 'Heading2');
    else if (b.type === 'h3') body += para(b.text, 'Heading3');
    else if (b.type === 'p') body += para(b.text);
    else if (b.type === 'note') body += para(b.text, 'Note');
    else if (b.type === 'ul') for (const it of b.items) body += para('• ' + it, '', '<w:ind w:left="360" w:hanging="220"/>');
    else if (b.type === 'table') body += table(b.columns, b.rows.map(r => b.columns.map((_, i) => (Array.isArray(r) ? r[i] : Object.values(r)[i]))));
    else if (b.type === 'pagebreak') body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1021" w:bottom="1134" w:left="1021" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': STYLES, 'word/document.xml': doc,
  });
}
function docxText(buf) { const x = unzipEntry(buf, 'word/document.xml'); return x === null ? null : x.replace(/<w:p[ >]/g, '\n<w:p ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); }

module.exports = { buildDocx, docxText, zip, unzipEntry };
