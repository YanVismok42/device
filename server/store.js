import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');

const MAX_HISTORY = 50;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function initialData() {
  // На хостинге пароль задаётся переменной ADMIN_PASSWORD. Локально, если её
  // нет, остаётся admin123 — публиковать такую сборку в интернет нельзя.
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  return {
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin',
      passwordHash: hashPassword(password)
    },
    users: [],
    lobbies: [],
    templates: []
  };
}

class Store {
  constructor() {
    this.data = null;
    // Последовательная очередь записи: без неё параллельные save() теряются.
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      this.data = JSON.parse(await readFile(DB_FILE, 'utf-8'));
    } catch {
      this.data = initialData();
      await this.save();
    }
  }

  save() {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${DB_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      await rename(tmp, DB_FILE);
    }).catch(err => {
      console.error('Ошибка записи БД:', err);
    });
    return this.writeChain;
  }

  // ---- Админ ----
  getAdmin() {
    return this.data.admin;
  }

  setAdminPassword(password) {
    this.data.admin.passwordHash = hashPassword(password);
    return this.save();
  }

  // ---- Участники ----
  getUsers() {
    return this.data.users;
  }

  getUser(id) {
    return this.data.users.find(u => u.id === id);
  }

  getUserByToken(token) {
    if (!token) return null;
    return this.data.users.find(u => u.accessToken === token) || null;
  }

  usernameTaken(username) {
    const key = String(username).toLowerCase();
    return this.data.users.some(u => u.username.toLowerCase() === key);
  }

  /** Создаёт участника вместе с его персональным лобби. */
  async createUser(username, nickname, password) {
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      username,
      nickname,
      accessToken: crypto.randomBytes(24).toString('hex'),
      passwordHash: password ? hashPassword(password) : null,
      createdAt: Date.now()
    };
    this.data.users.push(user);

    const lobby = {
      id: crypto.randomBytes(8).toString('hex'),
      userId: user.id,
      name: `Lobby #${String(this.data.lobbies.length + 1).padStart(2, '0')} - ${nickname}`,
      prescript: { content: '', draft: '', published: false, publishedAt: null },
      status: 'pending',
      history: [],
      createdAt: Date.now()
    };
    this.data.lobbies.push(lobby);

    await this.save();
    return { user, lobby };
  }

  async deleteUser(id) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) return false;
    this.data.users.splice(idx, 1);
    this.data.lobbies = this.data.lobbies.filter(l => l.userId !== id);
    await this.save();
    return true;
  }

  async rotateAccessToken(userId) {
    const user = this.getUser(userId);
    if (!user) return null;
    user.accessToken = crypto.randomBytes(24).toString('hex');
    await this.save();
    return user.accessToken;
  }

  // ---- Лобби ----
  getLobbies() {
    return this.data.lobbies;
  }

  getLobby(id) {
    return this.data.lobbies.find(l => l.id === id);
  }

  getLobbyByUserId(userId) {
    return this.data.lobbies.find(l => l.userId === userId);
  }

  async renameLobby(id, name) {
    const lobby = this.getLobby(id);
    if (!lobby) return null;
    lobby.name = name;
    await this.save();
    return lobby;
  }

  async saveDraft(lobbyId, draft) {
    const lobby = this.getLobby(lobbyId);
    if (!lobby) return null;
    lobby.prescript.draft = draft;
    lobby.prescript.published = draft === lobby.prescript.content;
    await this.save();
    return lobby;
  }

  /** Публикует черновик: прошлая версия уходит в историю, статус сбрасывается. */
  async publish(lobbyId, content) {
    const lobby = this.getLobby(lobbyId);
    if (!lobby) return null;

    if (lobby.prescript.content) {
      lobby.history.unshift({
        content: lobby.prescript.content,
        publishedAt: lobby.prescript.publishedAt,
        archivedAt: Date.now()
      });
      lobby.history = lobby.history.slice(0, MAX_HISTORY);
    }

    lobby.prescript.content = content;
    lobby.prescript.draft = content;
    lobby.prescript.published = true;
    lobby.prescript.publishedAt = Date.now();
    lobby.status = 'active';

    await this.save();
    return lobby;
  }

  async setStatus(lobbyId, status) {
    const lobby = this.getLobby(lobbyId);
    if (!lobby) return null;
    lobby.status = status;
    lobby.statusAt = Date.now();
    await this.save();
    return lobby;
  }

  // ---- Шаблоны ----
  getTemplates() {
    return this.data.templates;
  }

  async createTemplate(name, content) {
    const template = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      content,
      createdAt: Date.now()
    };
    this.data.templates.push(template);
    await this.save();
    return template;
  }

  async deleteTemplate(id) {
    const idx = this.data.templates.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.data.templates.splice(idx, 1);
    await this.save();
    return true;
  }
}

export const store = new Store();
