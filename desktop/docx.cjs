// 知著 PenMark — 零依赖最小 .docx 生成器
// 目的：让导出的 Word 文件能被 AI 文档解析器（ChatGPT/Claude 等）正确读取。
// 旧版导出的是包着 Word XML 命名空间的伪 .doc（实为 HTML），AI 解析为乱码。
// 这里生成标准 OOXML（.docx = 一组 XML 部件打包成的 zip），AI 可直接读取 word/document.xml。
//
// 设计取舍：
// - 仅用 STORE 法打包（不压缩），省去 zlib 依赖；docx 体积略大但 AI 不在乎。
// - 不嵌入图片媒体（img → [图片] 文本占位）：AI 文本模型不需要像素，且省去 media part + rels。
// - 不带 numbering.xml，列表用 "• " / "N. " 文本前缀，AI 友好且实现简单。
// - 内联段落格式（标题加粗+字号），不依赖 styles.xml，最少 3 个部件即可被 Word/AI 打开。

'use strict';

/* ---------- XML 工具 ---------- */
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ---------- CRC32（标准 PKZIP 多项式 0xEDB88320） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- DOS 日期时间 ---------- */
function dosDateTime(d) {
  d = d || new Date();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/* ---------- STORE-only zip 打包 ---------- */
// entries: [{ name: string, data: Buffer }]
function buildZip(entries) {
  const localParts = [];
  const central = [];
  let offset = 0;
  const dt = dosDateTime();
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    // Local file header (30 bytes + name + data)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 6);            // flags
    lfh.writeUInt16LE(0, 8);            // method = STORE
    lfh.writeUInt16LE(dt.time, 10);
    lfh.writeUInt16LE(dt.date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra field length
    localParts.push(lfh, nameBuf, data);

    // Central directory header (46 bytes + name)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0, 8);            // flags
    cdh.writeUInt16LE(0, 10);           // method
    cdh.writeUInt16LE(dt.time, 12);
    cdh.writeUInt16LE(dt.date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra length
    cdh.writeUInt16LE(0, 32);           // comment length
    cdh.writeUInt16LE(0, 34);           // disk number start
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // local header offset
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const cdOffset = offset;
  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // disk with CD
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16);     // CD offset
  eocd.writeUInt16LE(0, 20);            // comment length
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/* ---------- 最小 HTML 解析器（PenMark 产出的是干净语义 HTML） ---------- */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
function parseHtml(html) {
  // 去掉 DOCTYPE、script、style、注释
  html = String(html || '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[4] !== undefined && m[4] !== '') {
      const text = m[4];
      stack[stack.length - 1].children.push({ tag: '#text', text });
    } else {
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      const attrStr = m[3] || '';
      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === tag) { stack.length = i; break; }
        }
      } else {
        const attrs = {};
        attrStr.replace(/([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*"([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
        attrStr.replace(/([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*'([^']*)'/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
        const node = { tag, attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!VOID_TAGS.has(tag)) stack.push(node);
      }
    }
  }
  return root;
}

function hasClass(node, cls) {
  const c = node.attrs && node.attrs.class;
  return !!c && (' ' + c + ' ').indexOf(' ' + cls + ' ') >= 0;
}

/* ---------- 内联内容 → runs（保留加粗/斜体/下划线/删除线/代码） ---------- */
function collectRuns(node, fmt, runs) {
  fmt = fmt || {};
  for (const child of node.children) {
    if (child.tag === '#text') {
      const text = child.text;
      if (!text) continue;
      let rPr = '';
      if (fmt.bold) rPr += '<w:b/>';
      if (fmt.italic) rPr += '<w:i/>';
      if (fmt.underline) rPr += '<w:u w:val="single"/>';
      if (fmt.strike) rPr += '<w:strike/>';
      if (fmt.code) rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>';
      if (fmt.size) rPr += '<w:sz w:val="' + fmt.size + '"/><w:szCs w:val="' + fmt.size + '"/>';
      runs.push('<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + escapeXml(text) + '</w:t></w:r>');
    } else if (child.tag === 'br') {
      runs.push('<w:r><w:br/></w:r>');
    } else if (child.tag === 'img' || (child.tag === 'div' && hasClass(child, 'img-container'))) {
      runs.push('<w:r><w:t xml:space="preserve">[图片]</w:t></w:r>');
    } else {
      const nf = Object.assign({}, fmt);
      if (child.tag === 'strong' || child.tag === 'b') nf.bold = true;
      else if (child.tag === 'em' || child.tag === 'i') nf.italic = true;
      else if (child.tag === 'u') nf.underline = true;
      else if (child.tag === 's' || child.tag === 'del' || child.tag === 'strike') nf.strike = true;
      else if (child.tag === 'code') nf.code = true;
      collectRuns(child, nf, runs);
    }
  }
  return runs;
}

function paraFromBlock(block, fmt, pPrExtra) {
  const runs = collectRuns(block, fmt || {}, []);
  let pPr = '';
  if (pPrExtra) pPr = '<w:pPr>' + pPrExtra + '</w:pPr>';
  return '<w:p>' + pPr + runs.join('') + '</w:p>';
}

function tableXml(table) {
  const rows = table.children.filter(c => c.tag === 'tr');
  if (!rows.length) return '';
  const border = '<w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/>';
  let xml = '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' + border + '</w:tblBorders></w:tblPr>';
  for (const tr of rows) {
    xml += '<w:tr>';
    const cells = tr.children.filter(c => c.tag === 'td' || c.tag === 'th');
    for (const cell of cells) {
      const runs = collectRuns(cell, {}, []);
      const cellPr = '<w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>';
      xml += '<w:tc>' + cellPr + '<w:p>' + runs.join('') + '</w:p></w:tc>';
    }
    xml += '</w:tr>';
  }
  xml += '</w:tbl>';
  // 表格后必须跟一个段落，否则 Word 报错
  xml += '<w:p/>';
  return xml;
}

/* ---------- 树 → document.xml body ---------- */
function toBody(root) {
  const paras = [];
  function walk(node) {
    for (const child of node.children) {
      if (child.tag === '#text') continue;
      switch (child.tag) {
        case 'h1': paras.push(paraFromBlock(child, { bold: true, size: 32 }, '<w:spacing w:before="240" w:after="120"/>')); break;
        case 'h2': paras.push(paraFromBlock(child, { bold: true, size: 28 }, '<w:spacing w:before="240" w:after="120"/>')); break;
        case 'h3': paras.push(paraFromBlock(child, { bold: true, size: 24 }, '<w:spacing w:before="200" w:after="100"/>')); break;
        case 'h4': paras.push(paraFromBlock(child, { bold: true, size: 22 }, '<w:spacing w:before="200" w:after="100"/>')); break;
        case 'p': paras.push(paraFromBlock(child, null, '<w:spacing w:after="120"/>')); break;
        case 'blockquote': paras.push(paraFromBlock(child, { italic: true }, '<w:spacing w:before="120" w:after="120"/><w:ind w:left="480"/>')); break;
        case 'pre': paras.push(paraFromBlock(child, { code: true }, '<w:spacing w:before="120" w:after="120"/>')); break;
        case 'hr': paras.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="auto" w:space="1"/></w:pBdr></w:pPr></w:p>'); break;
        case 'ul':
          for (const li of child.children.filter(c => c.tag === 'li')) {
            const runs = collectRuns(li, {}, []);
            runs.unshift('<w:r><w:t xml:space="preserve">• </w:t></w:r>');
            paras.push('<w:p><w:pPr><w:ind w:left="480" w:hanging="240"/></w:pPr>' + runs.join('') + '</w:p>');
          }
          break;
        case 'ol': {
          let i = 1;
          for (const li of child.children.filter(c => c.tag === 'li')) {
            const runs = collectRuns(li, {}, []);
            runs.unshift('<w:r><w:t xml:space="preserve">' + (i++) + '. </w:t></w:r>');
            paras.push('<w:p><w:pPr><w:ind w:left="480" w:hanging="240"/></w:pPr>' + runs.join('') + '</w:p>');
          }
          break;
        }
        case 'table': paras.push(tableXml(child)); break;
        case 'div':
          if (hasClass(child, 'img-container')) paras.push('<w:p><w:r><w:t xml:space="preserve">[图片]</w:t></w:r></w:p>');
          else if (hasClass(child, 'img-grid')) {
            // 图片网格：每个 img-container 输出 [图片]
            const items = child.children.filter(c => c.tag === 'div' && hasClass(c, 'img-container'));
            if (items.length) paras.push('<w:p><w:r><w:t xml:space="preserve">' + items.map(() => '[图片]').join('  ') + '</w:t></w:r></w:p>');
          } else walk(child);
          break;
        case 'img': paras.push('<w:p><w:r><w:t xml:space="preserve">[图片]</w:t></w:r></w:p>'); break;
        case 'br': paras.push('<w:p/>'); break;
        default: walk(child);
      }
    }
  }
  walk(root);
  return paras.join('');
}

/* ---------- 对外入口 ---------- */
function generateDocx(html, title) {
  const root = parseHtml(html);
  const body = toBody(root);
  // 文档属性：标题（dc:title），便于 AI/文件管理器识别
  const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + escapeXml(title || '知著 PenMark 文档') + '</dc:title>' +
    '<dc:creator>知著 PenMark</dc:creator>' +
    '</cp:coreProperties>';

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml, 'utf8') }
  ];
  return buildZip(entries);
}

module.exports = { generateDocx, parseHtml, toBody, buildZip, crc32 };
