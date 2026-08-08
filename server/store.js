// Хранилище поверх SQLite внутри Durable Object. Набор методов повторяет
// прошлую, файловую версию — маршруты в index.js менять из-за схемы не пришлось.
//
// Отличие: сессии тоже лежат в базе, а не в Map. Раньше перезапуск сервера
// разлогинивал всех, теперь вход переживает и деплой, и спячку объекта.

import { hashPassword, randomHex } from './crypto.js';

const MAX_HISTORY = 50;
const ADMIN_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const USER_SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export { ADMIN_SESSION_MAX_AGE, USER_SESSION_MAX_AGE };

export class Store {
  constructor(sql) {
    this.sql = sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        passwordHash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        nickname TEXT NOT NULL,
        accessToken TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lobbies (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        draft TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0,
        publishedAt INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        statusAt INTEGER,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lobbyId TEXT NOT NULL,
        content TEXT NOT NULL,
        publishedAt INTEGER,
        archivedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        refId TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lobbies_user ON lobbies(userId);
      CREATE INDEX IF NOT EXISTS idx_history_lobby ON history(lobbyId);
    `);
  }

  /**
   * Заводит запись админа, если её ещё нет. Пароль берётся из секрета
   * ADMIN_PASSWORD; без него запись не создаётся и вход невозможен — фолбэка
   * намеренно нет, иначе сборка в интернете пускала бы кого угодно.
   */
  async ensureAdmin(username, password) {
    const existing = this.sql.exec('SELECT id FROM admin WHERE id = 1;').toArray();
    if (existing.length || !password) return;
    this.sql.exec(
      'INSERT INTO admin (id, username, passwordHash) VALUES (1, ?, ?);',
      username || 'admin',
      await hashPassword(password)
    );
  }

  getAdmin() {
    return this.sql.exec('SELECT username, passwordHash FROM admin WHERE id = 1;').toArray()[0] || null;
  }

  // ---- Сессии ----
  createSession(type, refId) {
    const token = randomHex(32);
    this.sql.exec(
      'INSERT INTO sessions (token, type, refId, createdAt) VALUES (?, ?, ?, ?);',
      token, type, refId, Date.now()
    );
    return token;
  }

  /** Возвращает сессию, попутно удаляя её, если срок вышел. */
  getSession(token) {
    if (!token) return null;
    const row = this.sql.exec('SELECT * FROM sessions WHERE token = ?;', token).toArray()[0];
    if (!row) return null;
    const maxAge = row.type === 'admin' ? ADMIN_SESSION_MAX_AGE : USER_SESSION_MAX_AGE;
    if (Date.now() - row.createdAt > maxAge) {
      this.sql.exec('DELETE FROM sessions WHERE token = ?;', token);
      return null;
    }
    return { type: row.type, id: row.refId };
  }

  // ---- Участники ----
  getUsers() {
    return this.sql.exec('SELECT * FROM users ORDER BY createdAt;').toArray();
  }

  getUserByToken(token) {
    if (!token) return null;
    return this.sql.exec('SELECT * FROM users WHERE accessToken = ?;', token).toArray()[0] || null;
  }

  usernameTaken(username) {
    return this.sql.exec(
      'SELECT id FROM users WHERE lower(username) = lower(?);', String(username)
    ).toArray().length > 0;
  }

  /** Создаёт участника вместе с его персональным лобби. */
  createUser(username, nickname) {
    const now = Date.now();
    const user = {
      id: randomHex(8),
      username,
      nickname,
      accessToken: randomHex(24),
      createdAt: now
    };
    this.sql.exec(
      'INSERT INTO users (id, username, nickname, accessToken, createdAt) VALUES (?, ?, ?, ?, ?);',
      user.id, user.username, user.nickname, user.accessToken, user.createdAt
    );

    const count = this.sql.exec('SELECT COUNT(*) AS n FROM lobbies;').toArray()[0].n;
    const lobbyId = randomHex(8);
    this.sql.exec(
      'INSERT INTO lobbies (id, userId, name, createdAt) VALUES (?, ?, ?, ?);',
      lobbyId, user.id, `Lobby #${String(count + 1).padStart(2, '0')} - ${nickname}`, now
    );

    return { user, lobby: this.getLobby(lobbyId) };
  }

  deleteUser(id) {
    const lobbies = this.sql.exec('SELECT id FROM lobbies WHERE userId = ?;', id).toArray();
    for (const l of lobbies) {
      this.sql.exec('DELETE FROM history WHERE lobbyId = ?;', l.id);
    }
    this.sql.exec('DELETE FROM lobbies WHERE userId = ?;', id);
    this.sql.exec("DELETE FROM sessions WHERE type = 'user' AND refId = ?;", id);
    const existed = this.sql.exec('SELECT COUNT(*) AS n FROM users WHERE id = ?;', id).toArray()[0].n;
    this.sql.exec('DELETE FROM users WHERE id = ?;', id);
    return existed > 0;
  }

  // ---- Лобби ----
  /** Собирает лобби в той же форме, что отдавала файловая версия. */
  #shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      prescript: {
        content: row.content,
        draft: row.draft,
        published: row.published === 1,
        publishedAt: row.publishedAt
      },
      status: row.status,
      statusAt: row.statusAt,
      createdAt: row.createdAt
    };
  }

  getLobbies() {
    return this.sql.exec('SELECT * FROM lobbies;').toArray().map(r => this.#shape(r));
  }

  getLobby(id) {
    return this.#shape(this.sql.exec('SELECT * FROM lobbies WHERE id = ?;', id).toArray()[0]);
  }

  getLobbyByUserId(userId) {
    return this.#shape(this.sql.exec('SELECT * FROM lobbies WHERE userId = ?;', userId).toArray()[0]);
  }

  renameLobby(id, name) {
    this.sql.exec('UPDATE lobbies SET name = ? WHERE id = ?;', name, id);
    return this.getLobby(id);
  }

  saveDraft(lobbyId, draft) {
    const lobby = this.getLobby(lobbyId);
    if (!lobby) return null;
    // published здесь значит «опубликованное совпадает с черновиком»,
    // то есть несохранённых правок нет.
    const published = draft === lobby.prescript.content ? 1 : 0;
    this.sql.exec('UPDATE lobbies SET draft = ?, published = ? WHERE id = ?;', draft, published, lobbyId);
    return this.getLobby(lobbyId);
  }

  /** Публикует прескрипт: прошлая версия уходит в историю, статус сбрасывается. */
  publish(lobbyId, content) {
    const lobby = this.getLobby(lobbyId);
    if (!lobby) return null;

    if (lobby.prescript.content) {
      this.sql.exec(
        'INSERT INTO history (lobbyId, content, publishedAt, archivedAt) VALUES (?, ?, ?, ?);',
        lobbyId, lobby.prescript.content, lobby.prescript.publishedAt, Date.now()
      );
      // Держим только последние MAX_HISTORY записей на лобби.
      this.sql.exec(
        `DELETE FROM history WHERE lobbyId = ?1 AND id NOT IN (
           SELECT id FROM history WHERE lobbyId = ?1 ORDER BY archivedAt DESC LIMIT ${MAX_HISTORY}
         );`,
        lobbyId
      );
    }

    this.sql.exec(
      `UPDATE lobbies SET content = ?, draft = ?, published = 1, publishedAt = ?, status = 'active'
       WHERE id = ?;`,
      content, content, Date.now(), lobbyId
    );
    return this.getLobby(lobbyId);
  }

  setStatus(lobbyId, status) {
    this.sql.exec('UPDATE lobbies SET status = ?, statusAt = ? WHERE id = ?;', status, Date.now(), lobbyId);
    return this.getLobby(lobbyId);
  }

  getHistory(lobbyId) {
    return this.sql.exec(
      'SELECT content, publishedAt, archivedAt FROM history WHERE lobbyId = ? ORDER BY archivedAt DESC;',
      lobbyId
    ).toArray();
  }

  // ---- Шаблоны ----
  getTemplates() {
    return this.sql.exec('SELECT * FROM templates ORDER BY createdAt;').toArray();
  }

  createTemplate(name, content) {
    const template = { id: randomHex(8), name, content, createdAt: Date.now() };
    this.sql.exec(
      'INSERT INTO templates (id, name, content, createdAt) VALUES (?, ?, ?, ?);',
      template.id, template.name, template.content, template.createdAt
    );
    return template;
  }

  deleteTemplate(id) {
    const existed = this.sql.exec('SELECT COUNT(*) AS n FROM templates WHERE id = ?;', id).toArray()[0].n;
    this.sql.exec('DELETE FROM templates WHERE id = ?;', id);
    return existed > 0;
  }
}
