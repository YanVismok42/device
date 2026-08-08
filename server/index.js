// Точка входа Worker + Durable Object «Hub».
//
// Вся логика живёт внутри Hub: там и SQLite-база, и открытые WebSocket-и.
// Экземпляр один на всё приложение (getByName('main')), поэтому презенс
// и данные всегда согласованы — никаких гонок между репликами.
//
// Worker снаружи занят одним: доводит запрос до Hub, а статику отдаёт мимо.

import { DurableObject } from 'cloudflare:workers';
import { Store, ADMIN_SESSION_MAX_AGE, USER_SESSION_MAX_AGE } from './store.js';
import { verifyPassword } from './crypto.js';
import { sanitizeHtml, htmlToPreview } from './sanitize.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

/**
 * Собирает Set-Cookie. На Workers соединение всегда HTTPS, поэтому Secure
 * ставим безусловно — кроме локального wrangler dev, который работает по http
 * и такую куку просто не сохранил бы.
 */
function sessionCookie(name, token, maxAge, url) {
  const parts = [
    `${name}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge / 1000}`
  ];
  if (url.protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    // Пароль задаётся секретом ADMIN_PASSWORD. Запись админа появляется при
    // первом обращении, если её ещё нет.
    ctx.blockConcurrencyWhile(async () => {
      await this.store.ensureAdmin(env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.#handleUpgrade(request);

    const cookies = parseCookies(request.headers.get('Cookie'));
    const admin = this.store.getSession(cookies.admin_session);
    const user = this.store.getSession(cookies.user_session);

    try {
      return await this.#route(request, url, admin, user);
    } catch (err) {
      console.error('Ошибка обработки запроса:', err);
      return json({ error: 'Internal error' }, 500);
    }
  }

  // ---- Маршруты API ----
  async #route(request, url, admin, user) {
    const { pathname } = url;
    const method = request.method;

    // Вход Главного
    if (pathname === '/api/admin/login' && method === 'POST') {
      const { username, password } = await request.json();
      const record = this.store.getAdmin();
      // Записи нет — значит ADMIN_PASSWORD не задан, входить не во что.
      if (!record) return json({ error: 'Admin is not configured' }, 503);
      if (username !== record.username || !(await verifyPassword(password, record.passwordHash))) {
        return json({ error: 'Invalid credentials' }, 401);
      }
      const token = this.store.createSession('admin', 'admin');
      return json({ success: true }, 200, {
        'Set-Cookie': sessionCookie('admin_session', token, ADMIN_SESSION_MAX_AGE, url)
      });
    }

    // Всё под /api/admin/ требует сессии Главного
    if (pathname.startsWith('/api/admin/') && !admin) {
      return json({ error: 'Unauthorized' }, 401);
    }

    if (pathname === '/api/admin/overview' && method === 'GET') {
      const lobbies = this.store.getLobbies();
      const overview = this.store.getUsers().map(u => {
        const lobby = lobbies.find(l => l.userId === u.id);
        return {
          userId: u.id,
          accessToken: u.accessToken,
          username: u.username,
          nickname: u.nickname,
          lobbyId: lobby?.id,
          lobbyName: lobby?.name,
          status: lobby?.status || 'pending',
          online: lobby ? this.#isOnline(lobby.id) : false,
          statusAt: lobby?.statusAt || null,
          publishedAt: lobby?.prescript?.publishedAt || null,
          prescript: htmlToPreview(lobby?.prescript?.content || ''),
          draft: lobby?.prescript?.draft || ''
        };
      });
      return json(overview);
    }

    if (pathname === '/api/admin/users' && method === 'POST') {
      const { username, nickname } = await request.json();
      if (this.store.usernameTaken(username)) {
        return json({ error: 'Username already taken' }, 409);
      }
      const { user: created, lobby } = this.store.createUser(username, nickname);
      this.#toAdmins({ type: 'user_created', user: created, lobby });
      return json({ user: created, lobby, accessUrl: `/lobby/${created.accessToken}` }, 201);
    }

    let m = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const success = this.store.deleteUser(m[1]);
      if (success) this.#toAdmins({ type: 'user_deleted', userId: m[1] });
      return json({ success }, success ? 200 : 404);
    }

    m = pathname.match(/^\/api\/admin\/lobbies\/([^/]+)$/);
    if (m && method === 'PUT') {
      const updates = await request.json();
      // Черновик тоже чистим: он возвращается в редактор Главного и уходит в публикацию.
      if (updates.draft !== undefined) this.store.saveDraft(m[1], sanitizeHtml(updates.draft));
      if (updates.name !== undefined) this.store.renameLobby(m[1], updates.name);
      return json(this.store.getLobby(m[1]));
    }

    m = pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/publish$/);
    if (m && method === 'POST') {
      const { content } = await request.json();
      const sanitized = sanitizeHtml(content);
      const lobby = this.store.publish(m[1], sanitized);
      if (!lobby) return json({ error: 'Lobby not found' }, 404);
      this.#toLobby(m[1], { type: 'prescript_updated', content: sanitized });
      return json(lobby);
    }

    m = pathname.match(/^\/api\/admin\/lobbies\/([^/]+)\/history$/);
    if (m && method === 'GET') return json(this.store.getHistory(m[1]));

    if (pathname === '/api/admin/templates' && method === 'GET') {
      return json(this.store.getTemplates());
    }

    if (pathname === '/api/admin/templates' && method === 'POST') {
      const { name, content } = await request.json();
      return json(this.store.createTemplate(name, sanitizeHtml(content)), 201);
    }

    m = pathname.match(/^\/api\/admin\/templates\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const success = this.store.deleteTemplate(m[1]);
      return json({ success }, success ? 200 : 404);
    }

    // ---- Лобби участника ----
    if (pathname === '/api/lobby/access' && method === 'POST') {
      const { token } = await request.json();
      const found = this.store.getUserByToken(token);
      if (!found) return json({ error: 'Invalid token' }, 404);

      const lobby = this.store.getLobbyByUserId(found.id);
      const sessionToken = this.store.createSession('user', found.id);
      return json({
        user: { id: found.id, nickname: found.nickname },
        lobby: {
          id: lobby.id,
          name: lobby.name,
          prescript: lobby.prescript.content,
          status: lobby.status
        }
      }, 200, {
        'Set-Cookie': sessionCookie('user_session', sessionToken, USER_SESSION_MAX_AGE, url)
      });
    }

    if (pathname === '/api/lobby/status' && method === 'POST') {
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const { status } = await request.json();
      const lobby = this.store.getLobbyByUserId(user.id);
      if (!lobby) return json({ error: 'Lobby not found' }, 404);
      this.store.setStatus(lobby.id, status);
      this.#toAdmins({ type: 'status_changed', lobbyId: lobby.id, status });
      return json({ success: true });
    }

    return json({ error: 'Not found' }, 404);
  }

  // ---- WebSocket ----
  /**
   * Принимает соединение через Hibernation API: пока сообщений нет, объект
   * выгружается из памяти, а соединения остаются живыми. Поэтому роль клиента
   * нельзя держать в поле класса — она уходит в attachment, который выгрузку
   * переживает.
   */
  #handleUpgrade(request) {
    const url = new URL(request.url);
    const cookies = parseCookies(request.headers.get('Cookie'));

    // Роль приходит от клиента, а не выводится из набора кук: у Главного,
    // открывшего лобби для проверки, куки обе сразу, и по ним не понять,
    // из какой вкладки пришло соединение.
    const wants = url.searchParams.get('role');
    let role = null;
    if (wants === 'admin' && this.store.getSession(cookies.admin_session)) {
      role = { kind: 'admin' };
    } else if (wants === 'lobby') {
      const user = this.store.getSession(cookies.user_session);
      const lobby = user && this.store.getLobbyByUserId(user.id);
      if (lobby) role = { kind: 'lobby', lobbyId: lobby.id };
    }
    if (!role) return new Response('Unauthorized', { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(role);

    if (role.kind === 'lobby' && this.#countLobby(role.lobbyId) === 1) {
      // Первая вкладка участника — лобби загорелось.
      this.#toAdmins({ type: 'presence_changed', lobbyId: role.lobbyId, online: true });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(ws) {
    const role = ws.deserializeAttachment();
    if (role?.kind !== 'lobby') return;
    // Закрываемое соединение ещё числится в getWebSockets(), поэтому «последним»
    // считается единица, а не ноль.
    if (this.#countLobby(role.lobbyId) <= 1) {
      this.#toAdmins({ type: 'presence_changed', lobbyId: role.lobbyId, online: false });
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  #sockets(match) {
    return this.ctx.getWebSockets().filter(ws => {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
      return match(ws.deserializeAttachment());
    });
  }

  #countLobby(lobbyId) {
    return this.#sockets(r => r?.kind === 'lobby' && r.lobbyId === lobbyId).length;
  }

  #isOnline(lobbyId) {
    return this.#countLobby(lobbyId) > 0;
  }

  #send(sockets, message) {
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // Соединение отвалилось между проверкой и отправкой — не мешаем остальным.
      }
    }
  }

  #toAdmins(message) {
    this.#send(this.#sockets(r => r?.kind === 'admin'), message);
  }

  #toLobby(lobbyId, message) {
    this.#send(this.#sockets(r => r?.kind === 'lobby' && r.lobbyId === lobbyId), message);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Страницы: файлов с такими путями нет, отдаём нужный HTML из статики.
    if (url.pathname === '/') return env.ASSETS.fetch(new URL('/login.html', url));
    if (url.pathname === '/admin') return env.ASSETS.fetch(new URL('/admin.html', url));
    if (url.pathname.startsWith('/lobby/')) return env.ASSETS.fetch(new URL('/lobby.html', url));

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }
      return env.HUB.getByName('main').fetch(request);
    }

    if (url.pathname.startsWith('/api/')) {
      return env.HUB.getByName('main').fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
