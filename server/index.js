import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { store, verifyPassword } from './store.js';
import { sanitizeHtml, htmlToPreview } from './sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Simple session store (in-memory)
const sessions = new Map();
const ADMIN_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const USER_SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession(type, id) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { type, id, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  const maxAge = session.type === 'admin' ? ADMIN_SESSION_MAX_AGE : USER_SESSION_MAX_AGE;
  if (Date.now() - session.createdAt > maxAge) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    cookies[name?.trim()] = rest.join('=').trim();
  });
  return cookies;
}

/**
 * Собирает Set-Cookie. На хостинге запрос приходит на прокси по HTTPS, а до
 * приложения доходит по HTTP — реальную схему знает только x-forwarded-proto.
 * Без Secure браузер отдал бы сессию и по открытому каналу.
 */
function sessionCookie(name, token, maxAge, req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const https = proto.split(',')[0].trim() === 'https';
  const parts = [
    `${name}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge / 1000}`
  ];
  if (https) parts.push('Secure');
  return parts.join('; ');
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse cookies
  const cookies = parseCookies(req.headers.cookie);
  const adminSession = getSession(cookies.admin_session);
  const userSession = getSession(cookies.user_session);

  // API Routes
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    // Admin login
    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const { username, password } = JSON.parse(body);
        const admin = store.getAdmin();

        if (username === admin.username && verifyPassword(password, admin.passwordHash)) {
          const token = createSession('admin', 'admin');
          res.setHeader('Set-Cookie', sessionCookie('admin_session', token, ADMIN_SESSION_MAX_AGE, req));
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      });
      return;
    }

    // Admin routes (require auth)
    if (url.pathname.startsWith('/api/admin/') && !adminSession) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Get all users and lobbies
    if (url.pathname === '/api/admin/overview' && req.method === 'GET' && adminSession) {
      const users = store.getUsers();
      const lobbies = store.getLobbies();
      const overview = users.map(user => {
        const lobby = lobbies.find(l => l.userId === user.id);
        return {
          userId: user.id,
          accessToken: user.accessToken,
          username: user.username,
          nickname: user.nickname,
          lobbyId: lobby?.id,
          lobbyName: lobby?.name,
          status: lobby?.status || 'pending',
          online: lobby ? isLobbyOnline(lobby.id) : false,
          statusAt: lobby?.statusAt || null,
          publishedAt: lobby?.prescript?.publishedAt || null,
          prescript: htmlToPreview(lobby?.prescript?.content || ''),
          draft: lobby?.prescript?.draft || ''
        };
      });
      res.writeHead(200);
      res.end(JSON.stringify(overview));
      return;
    }

    // Create user
    if (url.pathname === '/api/admin/users' && req.method === 'POST' && adminSession) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { username, nickname } = JSON.parse(body);

        if (store.usernameTaken(username)) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'Username already taken' }));
          return;
        }

        const { user, lobby } = await store.createUser(username, nickname);

        res.writeHead(201);
        res.end(JSON.stringify({ user, lobby, accessUrl: `/lobby/${user.accessToken}` }));

        broadcastToAdmin({ type: 'user_created', user, lobby });
      });
      return;
    }

    // Delete user
    if (url.pathname.match(/^\/api\/admin\/users\/[^/]+$/) && req.method === 'DELETE' && adminSession) {
      const userId = url.pathname.split('/').pop();
      const success = await store.deleteUser(userId);
      res.writeHead(success ? 200 : 404);
      res.end(JSON.stringify({ success }));

      if (success) broadcastToAdmin({ type: 'user_deleted', userId });
      return;
    }

    // Update lobby draft
    if (url.pathname.match(/^\/api\/admin\/lobbies\/[^/]+$/) && req.method === 'PUT' && adminSession) {
      const lobbyId = url.pathname.split('/').pop();
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const updates = JSON.parse(body);
        if (updates.draft !== undefined) {
          // Черновик тоже чистим: он возвращается в редактор Главного и уходит в публикацию.
          await store.saveDraft(lobbyId, sanitizeHtml(updates.draft));
        }
        if (updates.name !== undefined) {
          await store.renameLobby(lobbyId, updates.name);
        }
        const lobby = store.getLobby(lobbyId);
        res.writeHead(200);
        res.end(JSON.stringify(lobby));
      });
      return;
    }

    // Publish prescript
    if (url.pathname.match(/^\/api\/admin\/lobbies\/[^/]+\/publish$/) && req.method === 'POST' && adminSession) {
      const lobbyId = url.pathname.split('/')[4];
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { content } = JSON.parse(body);
        const sanitized = sanitizeHtml(content);
        await store.publish(lobbyId, sanitized);
        const lobby = store.getLobby(lobbyId);
        res.writeHead(200);
        res.end(JSON.stringify(lobby));

        broadcastToLobby(lobbyId, { type: 'prescript_updated', content: sanitized });
      });
      return;
    }

    // Get lobby history
    if (url.pathname.match(/^\/api\/admin\/lobbies\/[^/]+\/history$/) && req.method === 'GET' && adminSession) {
      const lobbyId = url.pathname.split('/')[4];
      const lobby = store.getLobby(lobbyId);
      res.writeHead(200);
      res.end(JSON.stringify(lobby?.history || []));
      return;
    }

    // Templates
    if (url.pathname === '/api/admin/templates' && req.method === 'GET' && adminSession) {
      res.writeHead(200);
      res.end(JSON.stringify(store.getTemplates()));
      return;
    }

    if (url.pathname === '/api/admin/templates' && req.method === 'POST' && adminSession) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { name, content } = JSON.parse(body);
        const template = await store.createTemplate(name, sanitizeHtml(content));
        res.writeHead(201);
        res.end(JSON.stringify(template));
      });
      return;
    }

    if (url.pathname.match(/^\/api\/admin\/templates\/[^/]+$/) && req.method === 'DELETE' && adminSession) {
      const templateId = url.pathname.split('/').pop();
      const success = await store.deleteTemplate(templateId);
      res.writeHead(success ? 200 : 404);
      res.end(JSON.stringify({ success }));
      return;
    }

    // User lobby access
    if (url.pathname === '/api/lobby/access' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const { token } = JSON.parse(body);
        const user = store.getUserByToken(token);
        if (!user) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Invalid token' }));
          return;
        }

        const sessionToken = createSession('user', user.id);
        const lobby = store.getLobbyByUserId(user.id);

        res.setHeader('Set-Cookie', sessionCookie('user_session', sessionToken, USER_SESSION_MAX_AGE, req));
        res.writeHead(200);
        res.end(JSON.stringify({
          user: { id: user.id, nickname: user.nickname },
          lobby: {
            id: lobby.id,
            name: lobby.name,
            prescript: lobby.prescript.content,
            status: lobby.status
          }
        }));
      });
      return;
    }

    // User status update
    if (url.pathname === '/api/lobby/status' && req.method === 'POST' && userSession) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const { status } = JSON.parse(body);
        const lobby = store.getLobbyByUserId(userSession.id);
        if (lobby) {
          await store.setStatus(lobby.id, status);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));

          broadcastToAdmin({ type: 'status_changed', lobbyId: lobby.id, status });
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Lobby not found' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Static files
  let filePath;
  if (url.pathname === '/') {
    filePath = '/public/login.html';
  } else if (url.pathname === '/admin') {
    filePath = '/public/admin.html';
  } else if (url.pathname.startsWith('/lobby/')) {
    filePath = '/public/lobby.html';
  } else {
    filePath = `/public${url.pathname}`;
  }

  try {
    const fullPath = join(__dirname, '..', filePath);
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'text/plain');
    res.writeHead(200);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket
const wss = new WebSocketServer({ server });
const adminClients = new Set();
const lobbyClients = new Map(); // lobbyId -> Set<ws>

wss.on('connection', (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const adminSession = getSession(cookies.admin_session);
  const userSession = getSession(cookies.user_session);

  // Живо ли соединение. Без пинга «оборванный» участник (закрыл ноутбук,
  // пропал вайфай) остался бы в таблице Главного онлайн навсегда.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (adminSession) {
    adminClients.add(ws);
    ws.on('close', () => adminClients.delete(ws));
  }
  if (userSession) {
    const lobby = store.getLobbyByUserId(userSession.id);
    if (lobby) {
      if (!lobbyClients.has(lobby.id)) lobbyClients.set(lobby.id, new Set());
      lobbyClients.get(lobby.id).add(ws);
      // Первая вкладка участника — лобби загорелось.
      if (lobbyClients.get(lobby.id).size === 1) {
        broadcastToAdmin({ type: 'presence_changed', lobbyId: lobby.id, online: true });
      }
      ws.on('close', () => {
        const set = lobbyClients.get(lobby.id);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) {
          lobbyClients.delete(lobby.id);
          broadcastToAdmin({ type: 'presence_changed', lobbyId: lobby.id, online: false });
        }
      });
    }
  }

  ws.on('error', () => ws.terminate());
});

// Раз в 30 секунд отсеиваем мёртвые соединения: terminate() поднимет 'close',
// а он уже разберётся с presence.
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

function isLobbyOnline(lobbyId) {
  const set = lobbyClients.get(lobbyId);
  if (!set) return false;
  return [...set].some(ws => ws.readyState === 1);
}

function broadcastToAdmin(message) {
  const data = JSON.stringify(message);
  adminClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(data);
  });
}

function broadcastToLobby(lobbyId, message) {
  const data = JSON.stringify(message);
  lobbyClients.get(lobbyId)?.forEach(ws => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// Start
await store.init();
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
