const DEFAULT_UNTITLED_TITLE = String.fromCharCode(0x65e0, 0x6807, 0x9898);
const SETTING_KEY = 'auto_title_enabled';
const MIN_CHARS = 40;
const CONTEXT_MAX = 2400;

function isUntitledTitle(value) {
  const title = String(value || '').trim();
  return !title || title === DEFAULT_UNTITLED_TITLE;
}

function isEligible(doc) {
  return !!doc && doc.title_origin === 'untitled' && isUntitledTitle(doc.title) && !doc.auto_title_attempted_at;
}

function plainText(html, stripHtml) {
  return String(stripHtml(String(html || '')) || '').replace(/\s+/g, ' ').trim();
}

function headingText(html, stripHtml) {
  const headings = [];
  String(html || '').replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi, (match, inner) => {
    const text = plainText(inner, stripHtml);
    if (text) headings.push(text);
    return match;
  });
  return headings.join(' ').slice(0, 400);
}

function buildContext(startHtml, endHtml, stripHtml) {
  const headings = headingText(startHtml, stripHtml);
  const start = plainText(startHtml, stripHtml);
  const end = plainText(endHtml, stripHtml);
  const parts = [];
  if (headings) parts.push('Headings: ' + headings.slice(0, 400));
  if (start) parts.push('Beginning: ' + start.slice(0, 1400));
  // A short ending prevents long essays from being titled only from their opening.
  if (end && end !== start) parts.push('Ending: ' + end.slice(-500));
  const context = parts.join('\n\n').slice(0, CONTEXT_MAX);
  return { context, visibleChars: start.replace(/\s/g, '').length };
}

function sliceSelectSql(isPostgres) {
  if (isPostgres) {
    return 'SUBSTRING(content FROM 1 FOR $3) AS content_start, RIGHT(content, $4) AS content_end';
  }
  return 'SUBSTR(content, 1, $3) AS content_start, SUBSTR(content, -$4) AS content_end';
}

module.exports = { SETTING_KEY, MIN_CHARS, isUntitledTitle, isEligible, buildContext, sliceSelectSql };
