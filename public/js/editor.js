/**
 * Редактор прескрипта: contenteditable + панель кнопок.
 * Главное требование — вставить ссылку можно без единой строчки HTML.
 */

/** Приводит что угодно, что человек вбил в поле, к рабочему URL. */
export function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;

  // Люди копируют адрес вместе с кавычками или скобками.
  value = value.replace(/^["'<(]+/, '').replace(/["'>)]+$/, '').trim();
  if (!value) return null;

  if (/^mailto:/i.test(value)) return value;
  // Просто почта — сами делаем mailto.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return `mailto:${value}`;
  if (/^https?:\/\/\S+$/i.test(value)) return value;

  // Схемы нет или она с опечаткой ("http//ok.ru", "https:/ok.ru").
  // Без похожести на адрес не выдумываем ссылку: "просто текст" ссылкой не станет.
  if (!looksLikeUrl(value)) return null;

  const stripped = value.replace(/^h?t?t?p?s?:?\/*/i, '').trim();
  if (!stripped) return null;

  return `https://${stripped}`;
}

/** Короткая проверка «это вообще ссылка?» для подсказки под полем. */
export function looksLikeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return false;
  if (/^mailto:/i.test(value)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return true;

  const stripped = value.replace(/^h?t?t?p?s?:?\/*/i, '');
  // Домен с точкой, IP или localhost — и никаких пробелов в хосте.
  return /^([a-z0-9-]+\.)+[a-z]{2,}(\/|$|\?|#|:)/i.test(stripped)
    || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(stripped)
    || /^localhost(:\d+)?(\/|$)/i.test(stripped);
}

const URL_IN_TEXT = /((?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:ru|com|net|org|io|me|tv|dev|app|xyz|online|site|club|top|info|biz)(?:\/[^\s<>"']*)?)/gi;

function createAnchor(href, label) {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  anchor.textContent = label;
  return anchor;
}

/** Текст → узлы, при этом URL внутри текста становятся кликабельными. */
export function buildFragmentFromText(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text).split(/\r\n|\r|\n/);

  lines.forEach((line, i) => {
    if (i > 0) fragment.appendChild(document.createElement('br'));

    let cursor = 0;
    let match;
    URL_IN_TEXT.lastIndex = 0;

    while ((match = URL_IN_TEXT.exec(line)) !== null) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(line.slice(cursor, match.index)));
      }
      const raw = match[0];
      // Точка/запятая в конце — почти всегда часть предложения, а не адреса.
      const trailing = raw.match(/[.,;:!?)]+$/);
      const clean = trailing ? raw.slice(0, -trailing[0].length) : raw;
      const href = normalizeUrl(clean);

      fragment.appendChild(href ? createAnchor(href, clean) : document.createTextNode(clean));
      if (trailing) fragment.appendChild(document.createTextNode(trailing[0]));
      cursor = match.index + raw.length;
    }

    if (cursor < line.length) {
      fragment.appendChild(document.createTextNode(line.slice(cursor)));
    }
  });

  return fragment;
}

export class PrescriptEditor {
  /**
   * @param {HTMLElement} root contenteditable-контейнер
   * @param {{ onLinkRequest?: (selectedText: string) => void }} options
   */
  constructor(root, options = {}) {
    this.root = root;
    this.onLinkRequest = options.onLinkRequest || null;
    this.savedRange = null;
    // Пока открыт диалог ссылки, выделение в редакторе не перезаписываем:
    // фокус ушёл в поле ввода, и браузер сообщает уже схлопнутый диапазон.
    this.selectionLocked = false;

    this.root.addEventListener('paste', (e) => this.handlePaste(e));
    this.root.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.root.addEventListener('keyup', (e) => this.handleKeyup(e));
    this.root.addEventListener('mouseup', () => this.rememberSelection());
    this.root.addEventListener('blur', () => this.rememberSelection());

    // Bold/italic должны давать <b>/<i>, а не <span style>, иначе санитайзер их срежет.
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {
      /* старые браузеры — не критично */
    }
  }

  // ---- Содержимое ----
  getHtml() {
    const html = this.root.innerHTML.trim();
    // Пустой contenteditable иногда хранит «<br>» или «<p><br></p>».
    if (/^(<br\s*\/?>|<p>\s*(<br\s*\/?>)?\s*<\/p>|&nbsp;|\s)*$/i.test(html)) return '';
    return html;
  }

  setHtml(html) {
    this.root.innerHTML = html || '';
  }

  isEmpty() {
    return this.getHtml() === '';
  }

  focus() {
    this.root.focus();
  }

  // ---- Выделение ----
  rememberSelection() {
    if (this.selectionLocked) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (this.root.contains(range.commonAncestorContainer)) {
      this.savedRange = range.cloneRange();
    }
  }

  restoreSelection() {
    if (!this.savedRange) {
      this.root.focus();
      // Курсор в конец последнего абзаца, а не за него — иначе ссылка
      // приклеится к контейнеру отдельным блоком.
      const target = this.lastBlock() || this.root;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      this.savedRange = range.cloneRange();
      return this.savedRange;
    }
    this.root.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(this.savedRange);
    return this.savedRange;
  }

  /** Последний блочный элемент редактора — куда логично поставить курсор. */
  lastBlock() {
    const blocks = this.root.querySelectorAll(':scope > p, :scope > div, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote');
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  lockSelection() {
    this.rememberSelection();
    this.selectionLocked = true;
  }

  unlockSelection() {
    this.selectionLocked = false;
  }

  getSelectedText() {
    if (!this.savedRange) return '';
    return this.savedRange.toString();
  }

  /** Ссылка, внутри которой сейчас стоит курсор (для режима «редактировать ссылку»). */
  getAnchorAtSelection() {
    if (!this.savedRange) return null;
    let node = this.savedRange.commonAncestorContainer;
    while (node && node !== this.root) {
      if (node.nodeType === 1 && node.tagName === 'A') return node;
      node = node.parentNode;
    }
    return null;
  }

  // ---- Команды панели ----
  exec(command) {
    this.root.focus();
    if (this.savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
    document.execCommand(command, false, null);
    this.rememberSelection();
  }

  queryState(command) {
    try {
      return document.queryCommandState(command);
    } catch {
      return false;
    }
  }

  /** Вставляет или обновляет ссылку. Возвращает false, если URL мусорный. */
  insertLink(text, url) {
    const href = normalizeUrl(url);
    if (!href) return false;

    const label = String(text || '').trim() || href;
    const existing = this.getAnchorAtSelection();

    if (existing) {
      existing.setAttribute('href', href);
      existing.setAttribute('target', '_blank');
      existing.setAttribute('rel', 'noopener noreferrer');
      existing.textContent = label;
      this.placeCaretAfter(existing);
      return true;
    }

    const range = this.restoreSelection();
    range.deleteContents();

    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
    anchor.textContent = label;

    range.insertNode(anchor);

    // Пробел после ссылки нужен, чтобы дальше не печаталось внутрь неё,
    // но только если пробела там ещё нет — иначе получится двойной.
    const next = anchor.nextSibling;
    const hasSpace = next && next.nodeType === 3 && /^[\s ]/.test(next.textContent);
    let caretTarget = anchor;
    if (!hasSpace) {
      caretTarget = document.createTextNode(' ');
      anchor.parentNode.insertBefore(caretTarget, next);
    }

    this.placeCaretAfter(caretTarget);
    return true;
  }

  removeLink() {
    this.root.focus();
    const anchor = this.getAnchorAtSelection();
    if (anchor) {
      const range = document.createRange();
      range.selectNode(anchor);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (this.savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this.savedRange);
    }
    document.execCommand('unlink', false, null);
    this.rememberSelection();
  }

  placeCaretAfter(node) {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this.savedRange = range.cloneRange();
  }

  // ---- Вставка из буфера ----
  handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;

    const fragment = this.buildFragmentFromText(text);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();

    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) this.placeCaretAfter(last);
  }

  buildFragmentFromText(text) {
    return buildFragmentFromText(text);
  }

  // ---- Клавиатура ----
  handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.rememberSelection();
      if (this.onLinkRequest) this.onLinkRequest(this.getSelectedText());
    }
  }

  handleKeyup(e) {
    if (e.key === ' ' || e.key === 'Enter') {
      this.autoLinkifyBeforeCaret();
    }
    this.rememberSelection();
  }

  /** Напечатал «ok.ru» и нажал пробел — превращаем в ссылку. */
  autoLinkifyBeforeCaret() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== 3) return;
      if (node.parentNode && node.parentNode.closest && node.parentNode.closest('a')) return;

      const before = node.textContent.slice(0, range.startOffset);
      // Последнее «слово» перед курсором (с учётом только что нажатого пробела).
      const wordMatch = before.match(/(\S+)\s$/);
      if (!wordMatch) return;

      const word = wordMatch[1];
      if (!looksLikeUrl(word)) return;
      const href = normalizeUrl(word);
      if (!href) return;

      const start = before.length - wordMatch[0].length;
      const wordRange = document.createRange();
      wordRange.setStart(node, start);
      wordRange.setEnd(node, start + word.length);
      wordRange.deleteContents();

      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      anchor.textContent = word;
      wordRange.insertNode(anchor);

      // Курсор — обратно за пробел после ссылки.
      const after = anchor.nextSibling;
      const caret = document.createRange();
      if (after && after.nodeType === 3) {
        caret.setStart(after, Math.min(1, after.textContent.length));
      } else {
        caret.setStartAfter(anchor);
      }
      caret.collapse(true);
      sel.removeAllRanges();
      sel.addRange(caret);
    } catch {
      /* автоссылка — приятный бонус, ломать ввод из-за неё нельзя */
    }
  }
}
