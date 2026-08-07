import { PrescriptEditor, buildFragmentFromText, normalizeUrl } from './editor.js';

// ---- Элементы ----
const tableBody = document.getElementById('tableBody');
const toast = document.getElementById('toast');

const editModal = document.getElementById('editModal');
const modalTitle = document.getElementById('modalTitle');
const modalUsername = document.getElementById('modalUsername');
const modalAccessUrl = document.getElementById('modalAccessUrl');
const modalLobbyName = document.getElementById('modalLobbyName');
const editorContent = document.getElementById('editorContent');
const templateList = document.getElementById('templateList');
const historyList = document.getElementById('historyList');

const linkModal = document.getElementById('linkModal');
const linkTextInput = document.getElementById('linkTextInput');
const linkUrlInput = document.getElementById('linkUrlInput');
const linkUrlHint = document.getElementById('linkUrlHint');

const newUserModal = document.getElementById('newUserModal');
const newUsername = document.getElementById('newUsername');
const newNickname = document.getElementById('newNickname');

const templatesModal = document.getElementById('templatesModal');
const templateName = document.getElementById('templateName');
const templateEditorEl = document.getElementById('templateEditor');
const savedTemplatesList = document.getElementById('savedTemplatesList');

// ---- Состояние ----
let rows = [];
let templates = [];
let currentLobbyId = null;

const STATUS_LABELS = {
  pending: { text: 'Ожидание', cls: 'status-pending' },
  active: { text: 'Активен', cls: 'status-active' },
  acknowledged: { text: 'Ознакомлен', cls: 'status-acknowledged' },
  completed: { text: 'Выполнено', cls: 'status-completed' }
};

// ---- Утилиты ----
let toastTimer = null;
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    window.location.href = '/';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let message = `Ошибка ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* тело не JSON */ }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/** «5 минут назад» — Главному важнее давность, чем точная дата. */
function relativeTime(ts) {
  if (!ts) return null;
  const diff = Date.now() - ts;
  if (diff < 0) return 'только что';

  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;

  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;

  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Что показать в строке «последнее действие»: отметка участника или публикация. */
function lastActionLabel(row) {
  const acted = row.statusAt && ['acknowledged', 'completed'].includes(row.status);
  if (acted) {
    const what = row.status === 'completed' ? 'Выполнил' : 'Ознакомился';
    return { ts: row.statusAt, text: `${what} ${relativeTime(row.statusAt)}` };
  }
  if (row.publishedAt) {
    return { ts: row.publishedAt, text: `Отправлено ${relativeTime(row.publishedAt)}` };
  }
  return null;
}

/** Простой текст → безопасный HTML-абзац, ссылки внутри кликабельны. */
function plainTextToHtml(text) {
  const holder = document.createElement('div');
  holder.appendChild(buildFragmentFromText(text));
  return `<p>${holder.innerHTML}</p>`;
}

// ---- Таблица ----
function renderTable() {
  tableBody.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = 'Участников пока нет. Нажмите «+ Новый участник».';
    tr.appendChild(td);
    tableBody.appendChild(tr);
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement('tr');

    // Статус
    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    const status = STATUS_LABELS[row.status] || STATUS_LABELS.pending;
    badge.className = `status-badge ${status.cls}`;
    badge.textContent = status.text;
    statusTd.appendChild(badge);

    const action = lastActionLabel(row);
    if (action) {
      const when = document.createElement('div');
      when.className = 'last-action';
      // data-ts — чтобы обновлять «5 минут назад» по таймеру, не трогая строку целиком.
      when.dataset.ts = String(action.ts);
      when.dataset.prefix = action.text.replace(relativeTime(action.ts), '').trim();
      when.textContent = action.text;
      when.title = formatTime(action.ts);
      statusTd.appendChild(when);
    }

    // Участник
    const userTd = document.createElement('td');
    userTd.textContent = row.nickname;
    const login = document.createElement('div');
    login.style.cssText = 'font-size:12px;opacity:0.5;margin-top:2px;';
    login.textContent = `@${row.username}`;
    userTd.appendChild(login);

    const presence = document.createElement('div');
    presence.className = `presence ${row.online ? 'online' : 'offline'}`;
    presence.dataset.lobby = row.lobbyId || '';
    presence.style.marginTop = '5px';
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    const presenceText = document.createElement('span');
    presenceText.textContent = row.online ? 'в лобби' : 'не в лобби';
    presence.append(dot, presenceText);
    userTd.appendChild(presence);

    // Лобби
    const lobbyTd = document.createElement('td');
    lobbyTd.textContent = row.lobbyName || '—';

    // Превью
    const previewTd = document.createElement('td');
    previewTd.className = 'prescript-preview';
    previewTd.textContent = row.prescript || '(пусто)';
    previewTd.title = row.prescript || '';

    // Действия
    const actionTd = document.createElement('td');
    const cell = document.createElement('div');
    cell.className = 'quick-cell';

    const quickInput = document.createElement('input');
    quickInput.type = 'text';
    quickInput.className = 'form-input glow-text quick-input';
    quickInput.placeholder = 'Быстрый прескрипт…';
    quickInput.onclick = (e) => e.stopPropagation();
    quickInput.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') quickPublish(row, quickInput);
    };

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn icon-btn glow-text';
    sendBtn.textContent = '→';
    sendBtn.title = 'Опубликовать мгновенно';
    sendBtn.onclick = (e) => {
      e.stopPropagation();
      quickPublish(row, quickInput);
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'btn icon-btn glow-text';
    editBtn.textContent = 'Редактировать';
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openEditModal(row.lobbyId);
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'btn icon-btn glow-text';
    delBtn.textContent = '✕';
    delBtn.title = 'Удалить участника';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteUser(row);
    };

    cell.append(quickInput, sendBtn, editBtn, delBtn);
    actionTd.appendChild(cell);

    tr.append(statusTd, userTd, lobbyTd, previewTd, actionTd);
    tr.onclick = () => openEditModal(row.lobbyId);
    tableBody.appendChild(tr);
  });
}

async function loadOverview() {
  try {
    rows = await api('/api/admin/overview');
    renderTable();
  } catch (err) {
    showToast(err.message, true);
  }
}

/** Зажигает/гасит индикатор присутствия, не перерисовывая таблицу. */
function applyPresence(lobbyId, online) {
  const row = rows.find(r => r.lobbyId === lobbyId);
  if (row) row.online = online;

  const el = document.querySelector(`.presence[data-lobby="${lobbyId}"]`);
  if (!el) return;
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  const label = el.querySelector('span:last-child');
  if (label) label.textContent = online ? 'в лобби' : 'не в лобби';
}

// «5 минут назад» устаревает молча — освежаем подписи раз в полминуты.
setInterval(() => {
  document.querySelectorAll('.last-action[data-ts]').forEach(el => {
    const ts = Number(el.dataset.ts);
    if (!ts) return;
    const prefix = el.dataset.prefix || '';
    el.textContent = prefix ? `${prefix} ${relativeTime(ts)}` : relativeTime(ts);
  });
}, 30000);

async function quickPublish(row, input) {
  const text = input.value.trim();
  if (!text) {
    showToast('Введите текст прескрипта', true);
    input.focus();
    return;
  }
  try {
    await api(`/api/admin/lobbies/${row.lobbyId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ content: plainTextToHtml(text) })
    });
    input.value = '';
    showToast(`Опубликовано: ${row.nickname}`);
    loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteUser(row) {
  if (!confirm(`Удалить участника «${row.nickname}» вместе с лобби?`)) return;
  try {
    await api(`/api/admin/users/${row.userId}`, { method: 'DELETE' });
    showToast('Участник удалён');
    loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Редактор прескрипта ----
const editor = new PrescriptEditor(editorContent, {
  onLinkRequest: (selected) => openLinkModal(selected)
});

document.querySelectorAll('.editor-toolbar [data-command]').forEach(btn => {
  // mousedown, а не click: иначе кнопка забирает фокус и выделение пропадает.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    editor.exec(btn.dataset.command);
    syncToolbar();
  });
});

document.getElementById('linkBtn').addEventListener('mousedown', (e) => {
  e.preventDefault();
  editor.lockSelection();
  openLinkModal(editor.getSelectedText());
});

document.getElementById('unlinkBtn').addEventListener('mousedown', (e) => {
  e.preventDefault();
  editor.removeLink();
});

function syncToolbar() {
  document.querySelectorAll('.editor-toolbar [data-command]').forEach(btn => {
    btn.classList.toggle('active', editor.queryState(btn.dataset.command));
  });
}

editorContent.addEventListener('keyup', syncToolbar);
editorContent.addEventListener('mouseup', syncToolbar);

// ---- Модалка ссылки ----
function openLinkModal(selectedText) {
  const anchor = editor.getAnchorAtSelection();
  linkTextInput.value = anchor ? anchor.textContent : (selectedText || '');
  linkUrlInput.value = anchor ? anchor.getAttribute('href') : '';
  setLinkHint('');
  linkModal.classList.add('active');
  // Если текст уже есть — курсор сразу в поле адреса.
  setTimeout(() => (linkTextInput.value ? linkUrlInput : linkTextInput).focus(), 50);
}

function closeLinkModal() {
  linkModal.classList.remove('active');
  editor.unlockSelection();
  editor.focus();
}

function setLinkHint(message, isError = false) {
  if (!message) {
    linkUrlHint.textContent = 'Можно без «https://» — допишем сами.';
    linkUrlHint.classList.remove('error');
    return;
  }
  linkUrlHint.textContent = message;
  linkUrlHint.classList.toggle('error', isError);
}

linkUrlInput.addEventListener('input', () => {
  const raw = linkUrlInput.value.trim();
  if (!raw) return setLinkHint('');
  const href = normalizeUrl(raw);
  if (href) {
    setLinkHint(`Получится: ${href}`);
  } else {
    setLinkHint('Это не похоже на адрес — нужен домен, например ok.ru', true);
  }
});

function applyLink() {
  const url = linkUrlInput.value.trim();
  if (!url) {
    setLinkHint('Введите адрес', true);
    linkUrlInput.focus();
    return;
  }
  const ok = editor.insertLink(linkTextInput.value, url);
  if (!ok) {
    setLinkHint('Не получилось разобрать адрес', true);
    linkUrlInput.focus();
    return;
  }
  closeLinkModal();
  showToast('Ссылка вставлена');
}

document.getElementById('applyLinkBtn').onclick = applyLink;
document.getElementById('cancelLinkBtn').onclick = closeLinkModal;
document.getElementById('closeLinkBtn').onclick = closeLinkModal;

[linkTextInput, linkUrlInput].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyLink();
    }
  });
});

// ---- Модалка редактирования ----
async function openEditModal(lobbyId) {
  const row = rows.find(r => r.lobbyId === lobbyId);
  if (!row) return;

  currentLobbyId = lobbyId;
  modalTitle.textContent = `Прескрипт — ${row.nickname}`;
  modalUsername.textContent = `${row.nickname} (@${row.username})`;
  modalAccessUrl.value = `${location.origin}/lobby/${row.accessToken}`;
  modalLobbyName.value = row.lobbyName || '';
  editor.setHtml(row.draft || '');

  editModal.classList.add('active');
  renderTemplateChips();
  loadHistory(lobbyId);
}

function closeEditModal() {
  editModal.classList.remove('active');
  currentLobbyId = null;
}

document.getElementById('closeModalBtn').onclick = closeEditModal;

document.getElementById('copyUrlBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(modalAccessUrl.value);
    showToast('Ссылка скопирована');
  } catch {
    modalAccessUrl.select();
    showToast('Нажмите Ctrl+C', true);
  }
};

document.getElementById('saveDraftBtn').onclick = async () => {
  if (!currentLobbyId) return;
  try {
    await api(`/api/admin/lobbies/${currentLobbyId}`, {
      method: 'PUT',
      body: JSON.stringify({ draft: editor.getHtml(), name: modalLobbyName.value.trim() })
    });
    showToast('Черновик сохранён — участник его пока не видит');
    loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
};

document.getElementById('publishBtn').onclick = async () => {
  if (!currentLobbyId) return;
  if (editor.isEmpty()) {
    showToast('Прескрипт пустой', true);
    return;
  }
  try {
    const name = modalLobbyName.value.trim();
    if (name) {
      await api(`/api/admin/lobbies/${currentLobbyId}`, {
        method: 'PUT',
        body: JSON.stringify({ name })
      });
    }
    await api(`/api/admin/lobbies/${currentLobbyId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ content: editor.getHtml() })
    });
    showToast('Опубликовано — участник видит прескрипт');
    loadHistory(currentLobbyId);
    loadOverview();
  } catch (err) {
    showToast(err.message, true);
  }
};

// ---- История ----
async function loadHistory(lobbyId) {
  historyList.replaceChildren();
  try {
    const history = await api(`/api/admin/lobbies/${lobbyId}/history`);
    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:0.5;font-size:13px;';
      empty.textContent = 'Пока нет предыдущих версий.';
      historyList.appendChild(empty);
      return;
    }

    history.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const time = document.createElement('div');
      time.className = 'history-time';
      time.textContent = `Опубликован ${formatTime(entry.publishedAt)} · заменён ${formatTime(entry.archivedAt)}`;

      const content = document.createElement('div');
      content.className = 'history-content';
      const tmp = document.createElement('div');
      tmp.innerHTML = entry.content;
      content.textContent = tmp.textContent || '(пусто)';

      const restore = document.createElement('button');
      restore.className = 'btn icon-btn glow-text';
      restore.style.marginTop = '8px';
      restore.textContent = 'Вернуть в редактор';
      restore.onclick = (e) => {
        e.stopPropagation();
        editor.setHtml(entry.content);
        showToast('Версия загружена в редактор');
        editModal.scrollTo({ top: 0, behavior: 'smooth' });
      };

      item.append(time, content, restore);
      historyList.appendChild(item);
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---- Шаблоны ----
async function loadTemplates() {
  try {
    templates = await api('/api/admin/templates');
    renderTemplateChips();
    renderSavedTemplates();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderTemplateChips() {
  templateList.replaceChildren();
  if (templates.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.5;font-size:13px;';
    empty.textContent = 'Шаблонов нет — создайте их в разделе «Шаблоны».';
    templateList.appendChild(empty);
    return;
  }
  templates.forEach(tpl => {
    const chip = document.createElement('div');
    chip.className = 'template-chip glow-text';
    chip.textContent = tpl.name;
    chip.onclick = () => {
      editor.setHtml(tpl.content);
      showToast(`Шаблон «${tpl.name}» вставлен`);
    };
    templateList.appendChild(chip);
  });
}

function renderSavedTemplates() {
  savedTemplatesList.replaceChildren();
  if (templates.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'opacity:0.5;font-size:13px;';
    empty.textContent = 'Пока пусто.';
    savedTemplatesList.appendChild(empty);
    return;
  }
  templates.forEach(tpl => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const name = document.createElement('div');
    name.style.cssText = 'font-size:14px;margin-bottom:6px;';
    name.textContent = tpl.name;

    const content = document.createElement('div');
    content.className = 'history-content';
    const tmp = document.createElement('div');
    tmp.innerHTML = tpl.content;
    content.textContent = tmp.textContent || '(пусто)';

    const del = document.createElement('button');
    del.className = 'btn icon-btn glow-text';
    del.style.marginTop = '8px';
    del.textContent = 'Удалить';
    del.onclick = async () => {
      try {
        await api(`/api/admin/templates/${tpl.id}`, { method: 'DELETE' });
        showToast('Шаблон удалён');
        loadTemplates();
      } catch (err) {
        showToast(err.message, true);
      }
    };

    item.append(name, content, del);
    savedTemplatesList.appendChild(item);
  });
}

const templateEditor = new PrescriptEditor(templateEditorEl);

document.getElementById('templatesBtn').onclick = () => {
  templatesModal.classList.add('active');
  loadTemplates();
};
document.getElementById('closeTemplatesBtn').onclick = () => templatesModal.classList.remove('active');

document.getElementById('saveTemplateBtn').onclick = async () => {
  const name = templateName.value.trim();
  if (!name) {
    showToast('Введите название шаблона', true);
    return;
  }
  if (templateEditor.isEmpty()) {
    showToast('Шаблон пустой', true);
    return;
  }
  try {
    await api('/api/admin/templates', {
      method: 'POST',
      body: JSON.stringify({ name, content: templateEditor.getHtml() })
    });
    templateName.value = '';
    templateEditor.setHtml('');
    showToast('Шаблон сохранён');
    loadTemplates();
  } catch (err) {
    showToast(err.message, true);
  }
};

// ---- Новый участник ----
document.getElementById('newUserBtn').onclick = () => {
  newUsername.value = '';
  newNickname.value = '';
  newUserModal.classList.add('active');
  setTimeout(() => newUsername.focus(), 50);
};

function closeNewUser() {
  newUserModal.classList.remove('active');
}
document.getElementById('closeNewUserBtn').onclick = closeNewUser;
document.getElementById('cancelNewUserBtn').onclick = closeNewUser;

document.getElementById('createUserBtn').onclick = async () => {
  const username = newUsername.value.trim();
  const nickname = newNickname.value.trim() || username;
  if (!username) {
    showToast('Введите логин', true);
    return;
  }
  try {
    const data = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, nickname })
    });
    closeNewUser();
    await loadOverview();
    showToast(`Создан «${nickname}» — ссылка в карточке участника`);
    openEditModal(data.lobby.id);
  } catch (err) {
    showToast(err.message, true);
  }
};

[newUsername, newNickname].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('createUserBtn').click();
  });
});

// ---- Закрытие модалок ----
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (linkModal.classList.contains('active')) return closeLinkModal();
  document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
});

// ---- WebSocket ----
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // Приход/уход участника обновляем точечно: полная перерисовка стёрла бы
    // текст, который Главный в этот момент набирает в поле быстрой публикации.
    if (msg.type === 'presence_changed') {
      applyPresence(msg.lobbyId, msg.online);
      return;
    }

    if (['status_changed', 'user_created', 'user_deleted'].includes(msg.type)) {
      loadOverview();
    }
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

// ---- Старт ----
loadOverview();
loadTemplates();
connectWS();
