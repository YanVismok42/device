/**
 * Санитайзер HTML прескрипта.
 * Прескрипт пишет доверенный Главный, но он попадает в чужие браузеры,
 * поэтому оставляем только разметку форматирования из редактора.
 */

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'p', 'br', 'div', 'span',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3',
  'blockquote', 'code', 'pre', 'a'
]);

const VOID_TAGS = new Set(['br']);

// У этих тегов выбрасываем не только сам тег, но и всё содержимое:
// иначе тело скрипта вылезет к участнику как обычный текст.
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template']);

function sanitizeHref(value) {
  const trimmed = String(value).trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

export function sanitizeHtml(input) {
  if (typeof input !== 'string') return '';

  let out = '';
  const openStack = [];
  // Карта подмен: если открывали <a>, но записали span, при </a> закроем span.
  const substitutions = new Map();

  const tokenizer = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let cursor = 0;
  let match;
  // Пока не ноль — мы внутри <script>/<style> и текст не выводим.
  let dropDepth = 0;
  let dropTag = null;

  while ((match = tokenizer.exec(input)) !== null) {
    if (dropDepth === 0) {
      out += escapeText(input.slice(cursor, match.index));
    }
    cursor = tokenizer.lastIndex;

    const raw = match[0];
    const tag = match[1].toLowerCase();
    const attrs = match[2] || '';
    const isClosing = raw.startsWith('</');

    // Режим «глотаем содержимое».
    if (dropDepth > 0) {
      if (tag === dropTag) {
        if (isClosing) dropDepth -= 1;
        else dropDepth += 1;
        if (dropDepth === 0) dropTag = null;
      }
      continue;
    }

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (!isClosing) {
        dropDepth = 1;
        dropTag = tag;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) continue;

    if (isClosing) {
      // Ищем тег или его подмену.
      const realTag = substitutions.get(tag) || tag;
      const at = openStack.lastIndexOf(realTag);
      if (at === -1) continue;
      // Закрываем всё, что открыто внутри.
      while (openStack.length > at) {
        out += `</${openStack.pop()}>`;
      }
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      out += `<${tag}>`;
      continue;
    }

    if (tag === 'a') {
      const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      const href = hrefMatch ? sanitizeHref(hrefMatch[2] ?? hrefMatch[3] ?? '') : null;
      if (!href) {
        // Подменяем <a> → <span>, запоминаем.
        substitutions.set('a', 'span');
        openStack.push('span');
        out += '<span>';
        continue;
      }
      substitutions.delete('a');
      openStack.push('a');
      out += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">`;
      continue;
    }

    openStack.push(tag);
    out += `<${tag}>`;
  }

  if (dropDepth === 0) {
    out += escapeText(input.slice(cursor));
  }

  while (openStack.length) {
    out += `</${openStack.pop()}>`;
  }

  return out;
}

// Готовые сущности (&lt; &amp; &nbsp; &#39; &#x27;) не трогаем, иначе после
// второго прохода санитайзера участник увидит буквальное «&lt;» вместо «<».
const BARE_AMPERSAND = /&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;

function escapeText(text) {
  return text
    .replace(BARE_AMPERSAND, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

/** Короткое текстовое превью для таблицы Главного. */
export function htmlToPreview(html, limit = 120) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-3])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // &amp; раскрываем последним, иначе "&amp;lt;" превратится в "<".
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
