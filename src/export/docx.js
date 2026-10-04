// DOCX = a zip of XML. Each page image goes in at original bytes (no re-encode);
// with "text" on, the page's OCR paragraphs follow its image as editable text.

import { utf8 } from './bytes.js';
import { zip } from './zip.js';
import { pageSizeFor } from './pdf.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU = 12700; // per point

function drawing(rid, n, cx, cy) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Page ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="page${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/**
 * pages: [{ bytes, type, w, h, text? }]
 */
export function writeDOCX({ pages, title = 'Scan', includeText = false }) {
  const media = [];
  const rels = [];
  const body = [];
  // One section, page size from the first page; images fit inside 0.5in margins.
  const first = pages[0] || { w: 850, h: 1100 };
  const { pw, ph } = pageSizeFor(first.w, first.h);
  const margin = 36;
  const boxW = pw - margin * 2, boxH = ph - margin * 2;
  pages.forEach((pg, i) => {
    const n = i + 1;
    const ext = pg.type === 'image/png' ? 'png' : 'jpeg';
    const rid = `rIdImg${n}`;
    media.push({ name: `word/media/page${n}.${ext}`, data: pg.bytes });
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${n}.${ext}"/>`);
    const s = Math.min(boxW / pg.w, boxH / pg.h);
    const cx = Math.round(pg.w * s * EMU), cy = Math.round(pg.h * s * EMU);
    const brk = i > 0 ? '<w:pPr><w:pageBreakBefore/><w:jc w:val="center"/></w:pPr>' : '<w:pPr><w:jc w:val="center"/></w:pPr>';
    body.push(`<w:p>${brk}${drawing(rid, n, cx, cy)}</w:p>`);
    if (includeText && pg.text) {
      body.push('<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>');
      for (const para of pg.text.split(/\n{2,}/)) {
        const runs = para.split('\n').map((line, k) => `${k ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r>`).join('');
        body.push(`<w:p>${runs}</w:p>`);
      }
    }
  });
  const twip = (pt) => Math.round(pt * 20);
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="${twip(pw)}" w:h="${twip(ph)}"${pw > ph ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${twip(margin)}" w:right="${twip(margin)}" w:bottom="${twip(margin)}" w:left="${twip(margin)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    { name: '[Content_Types].xml', data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`) },
    { name: '_rels/.rels', data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`) },
    { name: 'docProps/core.xml', data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>dark</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`) },
    { name: 'word/styles.xml', data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`) },
    { name: 'word/_rels/document.xml.rels', data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join('')}</Relationships>`) },
    { name: 'word/document.xml', data: utf8(doc) },
    ...media,
  ];
  return zip(files);
}
