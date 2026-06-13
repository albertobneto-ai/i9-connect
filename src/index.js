import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'i9connect_secret_2026';
const EVERI9_URL = process.env.EVERI9_URL || 'https://mcp-sf-provisioning-462dd29c2455.herokuapp.com';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const GROK_KEY = process.env.GROK_KEY || '';
const BOT_MODEL = process.env.BOT_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
const SSO_SECRET = process.env.SSO_SECRET || 'i9connect_sso_2026';
const GROQ_KEY = process.env.GROQ_KEY || '';

// Multi-provider AI call
async function callAI(model, messages, maxTokens = 1500) {
  const fetch = (await import('node-fetch')).default;
  // Anthropic (Claude)
  if (model.startsWith('anthropic/') && ANTHROPIC_KEY) {
    const anthropicModel = model.replace('anthropic/', '');
    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role !== 'system');
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: anthropicModel, max_tokens: maxTokens, system: sysMsg, messages: userMsgs })
    });
    const data = await resp.json();
    return data.content?.[0]?.text || data.error?.message || 'Sem resposta.';
  }
  // Grok (xAI)
  if ((model.startsWith('xai/') || model.includes('grok')) && GROK_KEY) {
    const grokModel = model.replace('xai/', '');
    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROK_KEY}` },
      body: JSON.stringify({ model: grokModel, max_tokens: maxTokens, messages })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || 'Sem resposta.';
  }
  // OpenRouter (free + paid)
  if (!OPENROUTER_KEY) return 'Bot não configurado. Defina OPENROUTER_KEY.';
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || 'Sem resposta do modelo.';
}

// ═══ POSTGRES ═══
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS connect_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(60) UNIQUE NOT NULL,
        display_name VARCHAR(120) NOT NULL,
        password_hash VARCHAR(200) NOT NULL,
        role VARCHAR(30) DEFAULT 'member',
        status VARCHAR(20) DEFAULT 'offline',
        avatar_color VARCHAR(7) DEFAULT '#555555',
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connect_channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(20) DEFAULT 'channel',
        is_private BOOLEAN DEFAULT FALSE,
        created_by INTEGER REFERENCES connect_users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connect_channel_members (
        channel_id INTEGER REFERENCES connect_channels(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES connect_users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS connect_messages (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER REFERENCES connect_channels(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES connect_users(id),
        content TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'text',
        reply_to INTEGER REFERENCES connect_messages(id),
        edited BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connect_dm_channels (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES connect_users(id),
        user2_id INTEGER REFERENCES connect_users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user1_id, user2_id)
      );
      CREATE TABLE IF NOT EXISTS connect_dm_messages (
        id SERIAL PRIMARY KEY,
        dm_channel_id INTEGER REFERENCES connect_dm_channels(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES connect_users(id),
        content TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'text',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connect_notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES connect_users(id),
        type VARCHAR(40) NOT NULL,
        title VARCHAR(200),
        content TEXT,
        source VARCHAR(40) DEFAULT 'system',
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connect_calls (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER,
        started_by INTEGER REFERENCES connect_users(id),
        call_type VARCHAR(20) DEFAULT 'audio',
        status VARCHAR(20) DEFAULT 'active',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS connect_call_participants (
        call_id INTEGER REFERENCES connect_calls(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES connect_users(id),
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        left_at TIMESTAMPTZ,
        PRIMARY KEY (call_id, user_id)
      );
    `);
    // Seed default channels
    const { rows } = await client.query("SELECT COUNT(*) FROM connect_channels");
    if (parseInt(rows[0].count) === 0) {
      await client.query(`INSERT INTO connect_channels (name, description, type) VALUES
        ('geral', 'Canal geral do projeto', 'channel'),
        ('arquitetura', 'Discussões de arquitetura Salesforce', 'channel'),
        ('deploys', 'Notificações de deploys e releases', 'channel'),
        ('bot-ia', 'Canal com assistente IA integrado', 'channel')
      `);
    }
    console.log('[DB] Schema initialized');
  } finally { client.release(); }
}

// ═══ MIDDLEWARE ═══
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ═══ AUTH ROUTES ═══
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, display_name, password } = req.body;
    if (!username || !password || !display_name) return res.status(400).json({ error: 'Missing fields' });
    const hash = await bcrypt.hash(password, 10);
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#555555'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const { rows } = await pool.query(
      'INSERT INTO connect_users (username, display_name, password_hash, avatar_color) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role, avatar_color',
      [username.toLowerCase().trim(), display_name, hash, color]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    // Auto-join all public channels
    const channels = await pool.query("SELECT id FROM connect_channels WHERE is_private = FALSE");
    for (const ch of channels.rows) {
      await pool.query('INSERT INTO connect_channel_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ch.id, user.id]);
    }
    res.json({ token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM connect_users WHERE username = $1', [username.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, avatar_color: user.avatar_color } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ SSO (from Ever i9) ═══
app.post('/api/auth/sso', async (req, res) => {
  try {
    const { username, display_name, sso_token } = req.body;
    // Verify SSO token (HMAC)
    const crypto = await import('crypto');
    const expected = crypto.createHmac('sha256', SSO_SECRET).update(username + ':' + display_name).digest('hex');
    if (sso_token !== expected) return res.status(401).json({ error: 'Invalid SSO token' });
    // Find or create user
    let { rows } = await pool.query('SELECT * FROM connect_users WHERE username = $1', [username]);
    if (!rows.length) {
      const hash = await bcrypt.hash('sso_' + Date.now(), 10);
      const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const insert = await pool.query(
        'INSERT INTO connect_users (username, display_name, password_hash, role, avatar_color) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [username, display_name, hash, 'member', color]
      );
      rows = insert.rows;
      // Auto-join public channels
      const channels = await pool.query("SELECT id FROM connect_channels WHERE is_private = FALSE");
      for (const ch of channels.rows) {
        await pool.query('INSERT INTO connect_channel_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ch.id, rows[0].id]);
      }
    }
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, avatar_color: user.avatar_color } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: create connect user (called from Ever i9)
app.post('/api/admin/users', async (req, res) => {
  try {
    const { username, display_name, password, admin_key } = req.body;
    if (admin_key !== SSO_SECRET) return res.status(401).json({ error: 'Invalid admin key' });
    const hash = await bcrypt.hash(password, 10);
    const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const { rows } = await pool.query(
      'INSERT INTO connect_users (username, display_name, password_hash, avatar_color) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role, avatar_color',
      [username.toLowerCase().trim(), display_name, hash, color]
    );
    // Auto-join public channels
    const channels = await pool.query("SELECT id FROM connect_channels WHERE is_private = FALSE");
    for (const ch of channels.rows) {
      await pool.query('INSERT INTO connect_channel_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ch.id, rows[0].id]);
    }
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ═══ CHANNELS ═══
app.get('/api/channels', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM connect_channel_members WHERE channel_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM connect_messages WHERE channel_id = c.id) AS message_count
      FROM connect_channels c ORDER BY c.id
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/channels', authMiddleware, async (req, res) => {
  try {
    const { name, description, is_private } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO connect_channels (name, description, is_private, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, description || '', is_private || false, req.user.id]
    );
    await pool.query('INSERT INTO connect_channel_members (channel_id, user_id) VALUES ($1,$2)', [rows[0].id, req.user.id]);
    io.emit('channel:created', rows[0]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ MESSAGES ═══
app.get('/api/channels/:id/messages', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null;
    let query = `SELECT m.*, u.display_name, u.avatar_color FROM connect_messages m
      JOIN connect_users u ON m.user_id = u.id WHERE m.channel_id = $1`;
    const params = [req.params.id];
    if (before) { query += ' AND m.id < $2'; params.push(before); }
    query += ' ORDER BY m.created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const { rows } = await pool.query(query, params);
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ CLEAR CHAT → MOVE TO HISTORY ═══
app.post('/api/channels/:id/clear', authMiddleware, async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    // Get source channel name
    const srcCh = await pool.query('SELECT name FROM connect_channels WHERE id = $1', [channelId]);
    if (!srcCh.rows.length) return res.status(404).json({ error: 'Channel not found' });
    const srcName = srcCh.rows[0].name;
    // Get or create chat-history channel
    let history = await pool.query("SELECT id FROM connect_channels WHERE name = 'chat-history' LIMIT 1");
    if (!history.rows.length) {
      history = await pool.query(
        "INSERT INTO connect_channels (name, description, type) VALUES ('chat-history', 'Histórico de mensagens arquivadas', 'channel') RETURNING id"
      );
    }
    const historyId = history.rows[0].id;
    // Get all messages from source channel
    const msgs = await pool.query(
      `SELECT m.*, u.display_name FROM connect_messages m
       JOIN connect_users u ON m.user_id = u.id
       WHERE m.channel_id = $1 ORDER BY m.created_at ASC`, [channelId]
    );
    if (msgs.rows.length === 0) return res.json({ ok: true, moved: 0 });
    // Copy messages to history with channel context
    const timestamp = new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    // Insert header
    let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
    const botId = sysUser.rows.length ? sysUser.rows[0].id : req.user.id;
    await pool.query(
      'INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4)',
      [historyId, botId, `━━━ Histórico #${srcName} — arquivado em ${timestamp} ━━━`, 'system']
    );
    // Copy each message
    for (const m of msgs.rows) {
      const dt = new Date(m.created_at).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      await pool.query(
        'INSERT INTO connect_messages (channel_id, user_id, content, type, created_at) VALUES ($1,$2,$3,$4,$5)',
        [historyId, m.user_id, m.content, m.type, m.created_at]
      );
    }
    // Delete from source
    await pool.query('DELETE FROM connect_messages WHERE channel_id = $1', [channelId]);
    // Notify channel
    io.to(`channel:${channelId}`).emit('chat:cleared', { channelId });
    res.json({ ok: true, moved: msgs.rows.length, historyChannelId: historyId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ DMs ═══
app.get('/api/dms', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*, 
        CASE WHEN d.user1_id = $1 THEN u2.display_name ELSE u1.display_name END AS other_name,
        CASE WHEN d.user1_id = $1 THEN u2.avatar_color ELSE u1.avatar_color END AS other_color,
        CASE WHEN d.user1_id = $1 THEN u2.id ELSE u1.id END AS other_id,
        CASE WHEN d.user1_id = $1 THEN u2.status ELSE u1.status END AS other_status
      FROM connect_dm_channels d
      JOIN connect_users u1 ON d.user1_id = u1.id
      JOIN connect_users u2 ON d.user2_id = u2.id
      WHERE d.user1_id = $1 OR d.user2_id = $1
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dms', authMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;
    const ids = [Math.min(req.user.id, user_id), Math.max(req.user.id, user_id)];
    const existing = await pool.query('SELECT * FROM connect_dm_channels WHERE user1_id = $1 AND user2_id = $2', ids);
    if (existing.rows.length) return res.json(existing.rows[0]);
    const { rows } = await pool.query('INSERT INTO connect_dm_channels (user1_id, user2_id) VALUES ($1,$2) RETURNING *', ids);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.display_name, u.avatar_color FROM connect_dm_messages m
       JOIN connect_users u ON m.user_id = u.id WHERE m.dm_channel_id = $1
       ORDER BY m.created_at DESC LIMIT 50`, [req.params.id]
    );
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ USERS ═══
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, display_name, role, status, avatar_color, last_seen FROM connect_users ORDER BY display_name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ NOTIFICATIONS ═══
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM connect_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE connect_notifications SET read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ EVER I9 WEBHOOK ═══
app.post('/api/webhook/everi9', async (req, res) => {
  try {
    const { event, data } = req.body;
    // Find deploys channel
    const ch = await pool.query("SELECT id FROM connect_channels WHERE name = 'deploys' LIMIT 1");
    const channelId = ch.rows[0]?.id;
    let content = '';
    switch (event) {
      case 'deploy_complete': content = `🚀 Deploy concluído: ${data?.spec || 'N/A'} — ${data?.status || 'success'}`; break;
      case 'task_moved': content = `📋 Task movida: "${data?.title}" → ${data?.column || '?'}`; break;
      case 'refinement_created': content = `📝 Novo refinamento criado: ${data?.title || 'Sem título'}`; break;
      case 'inventory_complete': content = `🔍 Inventory scan finalizado: ${data?.objectCount || '?'} objetos`; break;
      default: content = `📢 Evento Ever i9: ${event} — ${JSON.stringify(data || {}).substring(0, 200)}`;
    }
    if (channelId) {
      // Insert as system message (user_id null workaround: use first user or create system user)
      let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
      if (!sysUser.rows.length) {
        const hash = await bcrypt.hash('system_internal_2026', 10);
        sysUser = await pool.query("INSERT INTO connect_users (username, display_name, password_hash, role, avatar_color, status) VALUES ('everi9-bot','Ever i9 Bot',$1,'bot','#2d2d2d','online') RETURNING id", [hash]);
      }
      const botId = sysUser.rows[0].id;
      const msg = await pool.query(
        'INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
        [channelId, botId, content, 'system']
      );
      io.to(`channel:${channelId}`).emit('message:new', { ...msg.rows[0], display_name: 'Ever i9 Bot', avatar_color: '#2d2d2d' });
    }
    // Notify all users
    const users = await pool.query('SELECT id FROM connect_users WHERE role != $1', ['bot']);
    for (const u of users.rows) {
      await pool.query('INSERT INTO connect_notifications (user_id, type, title, content, source) VALUES ($1,$2,$3,$4,$5)',
        [u.id, event, `Ever i9: ${event}`, content, 'everi9']);
    }
    io.emit('notification:new', { type: event, content });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ BOT IA ═══
app.get('/api/models', authMiddleware, (req, res) => {
  const models = [
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron Super 120B', provider: 'NVIDIA', tier: 'free', status: 'active' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron Ultra 550B', provider: 'NVIDIA', tier: 'free', status: 'active' },
    { id: 'nex-agi/nex-n2-pro:free', name: 'NEX N2 Pro', provider: 'NEX AGI', tier: 'free', status: 'active' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', provider: 'Google', tier: 'free', status: 'unstable' },
  ];
  // Add paid models if keys available
  if (ANTHROPIC_KEY) {
    models.push({ id: 'anthropic/claude-sonnet-4-6-20250514', name: 'Claude Sonnet 4.6', provider: 'Anthropic', tier: 'paid', status: 'active' });
    models.push({ id: 'anthropic/claude-opus-4-0-20250514', name: 'Claude Opus 4', provider: 'Anthropic', tier: 'paid', status: 'active' });
  }
  if (GROK_KEY) {
    models.push({ id: 'xai/grok-3-latest', name: 'Grok 3', provider: 'xAI', tier: 'paid', status: 'active' });
    models.push({ id: 'xai/grok-3-mini-latest', name: 'Grok 3 Mini', provider: 'xAI', tier: 'paid', status: 'active' });
  }
  res.json(models);
});

app.post('/api/bot/ask', authMiddleware, async (req, res) => {
  try {
    const { question, channel_id, model } = req.body;
    const useModel = model || BOT_MODEL;
    const sysPrompt = `Você é o i9 Bot, assistente especialista Salesforce integrado ao i9 Connect.
Responda de forma detalhada e técnica em português do Brasil.
Conhecimento: Sales Cloud, Service Cloud, Data Cloud, Revenue Cloud, Agentforce, MuleSoft, Experience Cloud.
Use ** para destaques, listas numeradas para procedimentos. Seja completo e útil.`;
    const answer = await callAI(useModel, [{ role: 'system', content: sysPrompt }, { role: 'user', content: question }], 1500);
    // Save bot response as message in channel
    if (channel_id) {
      let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
      if (sysUser.rows.length) {
        const botId = sysUser.rows[0].id;
        const msg = await pool.query('INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
          [channel_id, botId, answer, 'bot']);
        io.to(`channel:${channel_id}`).emit('message:new', { ...msg.rows[0], display_name: 'i9 Bot', avatar_color: '#2d2d2d' });
      }
    }
    res.json({ answer });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ CALLS ═══

// ═══ WHISPER TRANSCRIPTION (via Groq) ═══
app.post('/api/transcribe', authMiddleware, async (req, res) => {
  try {
    if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY not configured' });
    const channelId = req.query.channel_id;
    const { audio } = req.body;
    if (!audio) return res.json({ text: '' });
    const audioBuffer = Buffer.from(audio, 'base64');
    if (audioBuffer.length < 1000) return res.json({ text: '' });

    const boundary = 'whisper' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`),
      Buffer.from(`--${boundary}--\r\n`)
    ]);

    const fetch = (await import('node-fetch')).default;
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    const data = await resp.json();
    const text = data.text?.trim() || '';
    if (!text) return res.json({ text: '' });

    // Post transcription to channel
    if (channelId) {
      let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
      if (sysUser.rows.length) {
        const botId = sysUser.rows[0].id;
        const msg = await pool.query('INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
          [channelId, botId, '🎤 ' + text, 'text']);
        io.to(`channel:${channelId}`).emit('message:new', { ...msg.rows[0], display_name: 'i9 Bot', avatar_color: '#2d2d2d' });
      }
      if (text.length > 8) autoSuggest(parseInt(channelId), text).catch(() => {});
    }
    res.json({ text });
  } catch (err) {
    console.error('[Whisper]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══ ORG SF PROXY ═══
app.get('/api/orgs-available', authMiddleware, async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    // Fetch default org info
    const connResp = await fetch(`${EVERI9_URL}/test-connection`).then(r => r.json()).catch(() => null);
    const orgs = [
      { id: 'default', name: 'Dev Org (Algar)', username: connResp?.username || '?', status: connResp?.status === 'connected' ? 'online' : 'offline' },
      { id: '1', name: 'DevEvery (Read-only)', username: 'Spec/Gap Analysis', status: 'online' }
    ];
    res.json(orgs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orgsf', authMiddleware, async (req, res) => {
  try {
    const { command, org_id, channel_id } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });
    const fetch = (await import('node-fetch')).default;
    let result = '';
    const cmd = command.trim().toLowerCase();
    const args = command.trim().substring(command.trim().indexOf(' ') + 1).trim();

    // Route commands to Ever i9 endpoints
    if (cmd.startsWith('descreva ') || cmd.startsWith('describe ')) {
      const objName = args.replace(/^(descreva|describe)\s*/i, '').trim();
      const endpoint = org_id === '1'
        ? `${EVERI9_URL}/api/orgs/1/describe?object=${objName}`
        : `${EVERI9_URL}/api/describe/${objName}`;
      const data = await fetch(endpoint).then(r => r.json()).catch(e => ({ error: e.message }));
      if (data.error) { result = `Erro: ${data.error}`; }
      else {
        const fields = data.fields || [];
        const customs = fields.filter(f => f.custom);
        const standards = fields.filter(f => !f.custom);
        result = `**${data.name || objName}** (${data.label || ''})\n\n`;
        result += `Total de campos: ${fields.length} (${standards.length} padrão + ${customs.length} custom)\n`;
        result += `Record Types: ${(data.recordTypeInfos || []).filter(r => r.name !== 'Master').map(r => r.name).join(', ') || 'Nenhum'}\n\n`;
        if (customs.length > 0) {
          result += `**Campos Custom (${customs.length}):**\n`;
          customs.forEach(f => { result += `• ${f.label} (${f.name}) — ${f.type}\n`; });
        }
        result += `\n**Campos Padrão principais:**\n`;
        standards.slice(0, 15).forEach(f => { result += `• ${f.label} (${f.name}) — ${f.type}\n`; });
        if (standards.length > 15) result += `... e mais ${standards.length - 15} campos padrão`;
      }
    } else if (cmd.startsWith('soql ') || cmd.startsWith('query ')) {
      const query = args.replace(/^(soql|query)\s*/i, '').trim();
      const b64 = Buffer.from(query).toString('base64');
      const endpoint = org_id === '1'
        ? `${EVERI9_URL}/api/orgs/1/soql?q=${encodeURIComponent(query)}`
        : `${EVERI9_URL}/api/soql-b64/${b64}`;
      const data = await fetch(endpoint).then(r => r.json()).catch(e => ({ error: e.message }));
      if (data.error) { result = `Erro SOQL: ${data.error}`; }
      else {
        const records = data.records || data || [];
        result = `**Resultado SOQL** (${records.length} registros)\n\n`;
        records.slice(0, 10).forEach((r, i) => {
          const fields = Object.entries(r).filter(([k]) => k !== 'attributes').map(([k, v]) => `${k}: ${v}`).join(' | ');
          result += `${i + 1}. ${fields}\n`;
        });
        if (records.length > 10) result += `\n... e mais ${records.length - 10} registros`;
      }
    } else if (cmd.startsWith('status') || cmd.startsWith('conexão') || cmd.startsWith('conexao')) {
      const data = await fetch(`${EVERI9_URL}/test-connection`).then(r => r.json()).catch(e => ({ error: e.message }));
      result = `**Status da Org**\n• Status: ${data.status}\n• Org ID: ${data.orgId}\n• Username: ${data.username}\n• Instance: ${data.instanceUrl}`;
    } else {
      result = `Comando não reconhecido: "${cmd}"\n\nComandos disponíveis:\n• @orgsf descreva Lead\n• @orgsf soql SELECT Id, Name FROM Account LIMIT 5\n• @orgsf status`;
    }

    // Post result to channel
    if (channel_id && result) {
      let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
      if (!sysUser.rows.length) {
        const hash = await bcrypt.hash('system_internal_2026', 10);
        sysUser = await pool.query("INSERT INTO connect_users (username, display_name, password_hash, role, avatar_color, status) VALUES ('everi9-bot','i9 Bot',$1,'bot','#2d2d2d','online') RETURNING id", [hash]);
      }
      const botId = sysUser.rows[0].id;
      const msg = await pool.query('INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
        [channel_id, botId, result, 'bot']);
      io.to(`channel:${channel_id}`).emit('message:new', { ...msg.rows[0], display_name: 'i9 Bot', avatar_color: '#2d2d2d' });
    }
    res.json({ result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ CALLS ═══
app.get('/api/calls/active', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, array_agg(json_build_object('user_id', cp.user_id, 'display_name', u.display_name)) AS participants
      FROM connect_calls c
      LEFT JOIN connect_call_participants cp ON c.id = cp.call_id AND cp.left_at IS NULL
      LEFT JOIN connect_users u ON cp.user_id = u.id
      WHERE c.status = 'active'
      GROUP BY c.id
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ HEALTH ═══
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'i9-connect', version: '1.0.0', everi9: EVERI9_URL });
});

// SPA fallback
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'), err => {
    if (err) res.status(404).json({ error: 'Frontend not found' });
  });
});

// ═══ AUTO-SUGGEST (Salesforce context detection with conversation context) ═══
const SF_KEYWORDS = /\b(salesforce|apex|flow|trigger|soql|sosl|lightning|lwc|aura|lead|leads|account|accounts|opportunity|opportunities|contact|contacts|campaign|dashboard|report|permission|profile|record.?type|validation.?rule|workflow|process.?builder|data.?cloud|mulesoft|mule|agentforce|revenue.?cloud|service.?cloud|sales.?cloud|cpq|quote|order|contract|picklist|lookup|master.?detail|sharing|deployment|metadata|sandbox|scratch.?org|devhub|connected.?app|oauth|rest.?api|soap|bulk.?api|platform.?event|experience.?cloud|community|visualforce|screen.?flow|autolaunched|batch|future|queueable|invocable|object|custom.?field|page.?layout|related.?list|roll.?up|formula|field|org|admin|setup|permission.?set|managed.?package|unmanaged|changeset|deploy|cls|sfdx|sf\s+cli|einstein|copilot|omnistudio|vlocity|integration|webservice|callout|http.?request|named.?credential|external.?object|converter|conversão|passo.a.passo|como.criar|como.fazer|como.configur|conta|contas|contato|contatos|oportunidade|oportunidades|cotação|cotações|pedido|pedidos|campanha|relatório|painel|regra.de.validação|fluxo|gatilho|integração|integrações|sincronização|portal|automação|migração|customização|configuração|objeto|campos|perfil|conjunto.de.permissões|implantação|ambiente|produção|desenvolvimento)\b/i;

async function autoSuggest(channelId, content) {
  if (!OPENROUTER_KEY) return;

  // Fetch recent messages for context
  const recent = await pool.query(
    `SELECT m.content, m.type, u.display_name FROM connect_messages m
     JOIN connect_users u ON m.user_id = u.id
     WHERE m.channel_id = $1 ORDER BY m.created_at DESC LIMIT 8`,
    [channelId]
  );
  const recentMsgs = recent.rows.reverse();

  // Check if there was a recent suggestion (bot is already in context)
  const hasRecentSuggestion = recentMsgs.some(m => m.type === 'suggestion' || m.type === 'bot');

  // Trigger if: SF keywords found OR there's recent bot context (follow-up)
  if (!SF_KEYWORDS.test(content) && !hasRecentSuggestion) return;

  // If follow-up without keywords, check if content is too short/generic to be a real question
  if (!SF_KEYWORDS.test(content) && hasRecentSuggestion && content.length < 5) return;

  try {
    const fetch = (await import('node-fetch')).default;

    // Build conversation history for context
    const contextMessages = recentMsgs
      .filter(m => m.type !== 'system')
      .map(m => {
        if (m.type === 'suggestion' || m.type === 'bot') {
          return { role: 'assistant', content: m.content };
        }
        return { role: 'user', content: `[${m.display_name}]: ${m.content}` };
      });

    const messages = [
      { role: 'system', content: `Você é o i9 Bot, um assistente especialista Salesforce integrado a um chat de equipe.

REGRAS:
- Responda em português do Brasil, de forma técnica e DETALHADA
- Quando a pergunta pedir um passo a passo, forneça etapas numeradas com detalhes de cada clique/configuração
- Quando for uma dúvida conceitual, explique com clareza usando exemplos práticos
- Considere o CONTEXTO da conversa (mensagens anteriores) para entender continuações e referências
- Se a mensagem atual é uma continuação de um assunto anterior, responda considerando todo o contexto
- Se NÃO for relacionado a Salesforce ou tecnologia (saudação, conversa casual), responda exatamente: SKIP
- Use formatação com ** para destaques e listas numeradas para procedimentos
- Seja completo: 4-8 parágrafos para explicações, passos detalhados para procedimentos` },
      ...contextMessages
    ];

    const answer = await callAI(BOT_MODEL, messages, 1500);
    if (!answer || answer === 'SKIP' || answer.startsWith('SKIP') || answer === 'Sem resposta do modelo.') return;

    // Get or create bot user
    let sysUser = await pool.query("SELECT id FROM connect_users WHERE username = 'everi9-bot' LIMIT 1");
    if (!sysUser.rows.length) {
      const hash = await bcrypt.hash('system_internal_2026', 10);
      sysUser = await pool.query("INSERT INTO connect_users (username, display_name, password_hash, role, avatar_color, status) VALUES ('everi9-bot','i9 Bot',$1,'bot','#2d2d2d','online') RETURNING id", [hash]);
    }
    const botId = sysUser.rows[0].id;
    const msg = await pool.query(
      'INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
      [channelId, botId, answer, 'suggestion']
    );
    io.to(`channel:${channelId}`).emit('message:new', { ...msg.rows[0], display_name: 'i9 Bot', avatar_color: '#2d2d2d' });
    console.log('[AutoSuggest] Context-aware suggestion posted to channel', channelId);
  } catch (err) {
    console.error('[AutoSuggest] Error:', err.message);
  }
}

// ═══ SOCKET.IO ═══
const onlineUsers = new Map(); // socketId -> { userId, username, display_name }
const activeCalls = new Map(); // callId -> { channelId, participants: Set<socketId> }

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Auth required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error('Invalid token')); }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  onlineUsers.set(socket.id, { userId: user.id, username: user.username, display_name: user.display_name });

  // Update status
  await pool.query("UPDATE connect_users SET status = 'online', last_seen = NOW() WHERE id = $1", [user.id]);
  io.emit('presence:update', { userId: user.id, status: 'online', display_name: user.display_name });

  console.log(`[WS] ${user.display_name} connected (${socket.id})`);

  // ── Join channel rooms ──
  socket.on('channel:join', (channelId) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('channel:leave', (channelId) => {
    socket.leave(`channel:${channelId}`);
  });

  // ── Messaging ──
  socket.on('message:send', async (data) => {
    try {
      const { channel_id, content, type = 'text' } = data;
      const { rows } = await pool.query(
        'INSERT INTO connect_messages (channel_id, user_id, content, type) VALUES ($1,$2,$3,$4) RETURNING *',
        [channel_id, user.id, content, type]
      );
      const msg = { ...rows[0], display_name: user.display_name, avatar_color: '' };
      const u = await pool.query('SELECT avatar_color FROM connect_users WHERE id=$1', [user.id]);
      msg.avatar_color = u.rows[0]?.avatar_color || '#555';
      io.to(`channel:${channel_id}`).emit('message:new', msg);
      // Auto-detect Salesforce context and suggest (fire-and-forget)
      if (type === 'text' && content.length > 8) {
        autoSuggest(channel_id, content).catch(e => console.error('[AutoSuggest]', e.message));
      }
    } catch (err) { socket.emit('error', { message: err.message }); }
  });

  // ── DM messaging ──
  socket.on('dm:send', async (data) => {
    try {
      const { dm_channel_id, content } = data;
      const { rows } = await pool.query(
        'INSERT INTO connect_dm_messages (dm_channel_id, user_id, content) VALUES ($1,$2,$3) RETURNING *',
        [dm_channel_id, user.id, content]
      );
      const u = await pool.query('SELECT avatar_color FROM connect_users WHERE id=$1', [user.id]);
      const msg = { ...rows[0], display_name: user.display_name, avatar_color: u.rows[0]?.avatar_color || '#555' };
      // Notify both users in DM
      const dm = await pool.query('SELECT * FROM connect_dm_channels WHERE id = $1', [dm_channel_id]);
      if (dm.rows.length) {
        const otherUserId = dm.rows[0].user1_id === user.id ? dm.rows[0].user2_id : dm.rows[0].user1_id;
        // Find other user's socket
        for (const [sid, u] of onlineUsers.entries()) {
          if (u.userId === otherUserId || u.userId === user.id) {
            io.to(sid).emit('dm:new', msg);
          }
        }
      }
    } catch (err) { socket.emit('error', { message: err.message }); }
  });

  // ── Typing indicators ──
  socket.on('typing:start', (data) => {
    socket.to(`channel:${data.channel_id}`).emit('typing:update', { userId: user.id, display_name: user.display_name, typing: true });
  });
  socket.on('typing:stop', (data) => {
    socket.to(`channel:${data.channel_id}`).emit('typing:update', { userId: user.id, display_name: user.display_name, typing: false });
  });

  // ── WebRTC Signaling ──
  socket.on('call:start', async (data) => {
    try {
      const { channel_id } = data;
      const { rows } = await pool.query(
        'INSERT INTO connect_calls (channel_id, started_by) VALUES ($1,$2) RETURNING *',
        [channel_id, user.id]
      );
      const callId = rows[0].id;
      await pool.query('INSERT INTO connect_call_participants (call_id, user_id) VALUES ($1,$2)', [callId, user.id]);
      activeCalls.set(callId, { channelId: channel_id, participants: new Set([socket.id]) });
      socket.callId = callId;
      io.to(`channel:${channel_id}`).emit('call:started', { callId, channelId: channel_id, startedBy: user.display_name });
      socket.emit('call:joined', { callId });
    } catch (err) { socket.emit('error', { message: err.message }); }
  });

  socket.on('call:join', async (data) => {
    try {
      const { call_id } = data;
      const call = activeCalls.get(call_id);
      if (!call) return socket.emit('error', { message: 'Call not found' });
      await pool.query('INSERT INTO connect_call_participants (call_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [call_id, user.id]);
      // Notify existing participants to create peer connections
      for (const sid of call.participants) {
        io.to(sid).emit('call:peer-joined', { socketId: socket.id, userId: user.id, display_name: user.display_name });
      }
      call.participants.add(socket.id);
      socket.callId = call_id;
      socket.emit('call:joined', { callId: call_id, peers: [...call.participants].filter(s => s !== socket.id) });
    } catch (err) { socket.emit('error', { message: err.message }); }
  });

  socket.on('call:signal', (data) => {
    // Forward WebRTC signaling (offer, answer, ice-candidate)
    const { to, signal } = data;
    io.to(to).emit('call:signal', { from: socket.id, signal, userId: user.id, display_name: user.display_name });
  });

  socket.on('call:leave', async () => {
    if (socket.callId) {
      const call = activeCalls.get(socket.callId);
      if (call) {
        call.participants.delete(socket.id);
        for (const sid of call.participants) {
          io.to(sid).emit('call:peer-left', { socketId: socket.id, userId: user.id, display_name: user.display_name });
        }
        if (call.participants.size === 0) {
          activeCalls.delete(socket.callId);
          await pool.query("UPDATE connect_calls SET status = 'ended', ended_at = NOW() WHERE id = $1", [socket.callId]);
          io.to(`channel:${call.channelId}`).emit('call:ended', { callId: socket.callId });
        }
      }
      await pool.query("UPDATE connect_call_participants SET left_at = NOW() WHERE call_id = $1 AND user_id = $2", [socket.callId, user.id]);
      socket.callId = null;
    }
  });

  // ── Status ──
  socket.on('status:set', async (data) => {
    const { status } = data;
    await pool.query('UPDATE connect_users SET status = $1 WHERE id = $2', [status, user.id]);
    io.emit('presence:update', { userId: user.id, status, display_name: user.display_name });
  });

  // ── Disconnect ──
  socket.on('disconnect', async () => {
    onlineUsers.delete(socket.id);
    await pool.query("UPDATE connect_users SET status = 'offline', last_seen = NOW() WHERE id = $1", [user.id]);
    io.emit('presence:update', { userId: user.id, status: 'offline' });
    // Leave any active call
    if (socket.callId) {
      const call = activeCalls.get(socket.callId);
      if (call) {
        call.participants.delete(socket.id);
        for (const sid of call.participants) {
          io.to(sid).emit('call:peer-left', { socketId: socket.id, userId: user.id });
        }
        if (call.participants.size === 0) {
          activeCalls.delete(socket.callId);
          await pool.query("UPDATE connect_calls SET status = 'ended', ended_at = NOW() WHERE id = $1", [socket.callId]);
        }
      }
    }
    console.log(`[WS] ${user.display_name} disconnected`);
  });
});

// ═══ START ═══
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[i9-connect] Running on port ${PORT}`);
    console.log(`[i9-connect] Ever i9 integration: ${EVERI9_URL}`);
  });
}).catch(err => {
  console.error('[DB] Init failed:', err);
  process.exit(1);
});
