const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory ESPN cache ───────────────────────────────────────────────────────
// Prevents 1000 clients from each hitting ESPN directly every 30s
const espnCache = new Map(); // key -> { data, expiresAt }
const SCORES_TTL   = 20 * 1000;  // 20 seconds — fast enough for live games
const PBP_TTL      = 15 * 1000;  // 15 seconds for play-by-play

function getCached(key) {
  const entry = espnCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return null;
}
function setCache(key, data, ttl) {
  espnCache.set(key, { data, expiresAt: Date.now() + ttl });
  // Prevent unbounded growth — evict old entries
  if (espnCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of espnCache) {
      if (now > v.expiresAt) espnCache.delete(k);
    }
  }
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────────
const rateLimitMap = new Map(); // ip -> { count, resetAt }
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}
// Purge old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) {
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 5 * 60 * 1000);

// ── Allowed origins ───────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://bocktalks.app',
  'https://www.bocktalks.app',
  /\.vercel\.app$/,   // Vercel preview deployments
  /localhost/,          // local dev
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-to-server / curl
    const ok = ALLOWED_ORIGINS.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    cb(ok ? null : new Error('CORS blocked'), ok);
  },
  credentials: true,
}));
app.use(compression()); // gzip all responses
app.use(express.json({ limit: '100kb' })); // cap payload size

// Global rate limit: 300 requests per minute per IP
app.use(rateLimit(300, 60 * 1000));

// ── Database setup ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,                  // max simultaneous DB connections
  idleTimeoutMillis: 30000, // close idle connections after 30s
  connectionTimeoutMillis: 3000, // fail fast if pool is exhausted
});

// Log pool errors so they don't crash the process silently
pool.on('error', (err) => console.error('PG pool error:', err.message));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL DEFAULT 'squares',
        code        TEXT UNIQUE NOT NULL,
        host_token  TEXT NOT NULL,
        data        JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS games_code_idx ON games(code);

      CREATE TABLE IF NOT EXISTS challenges (
        id           SERIAL PRIMARY KEY,
        game_code    TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        game_type    TEXT NOT NULL DEFAULT 'squares',
        player_name  TEXT NOT NULL,
        period_label TEXT NOT NULL,
        message      TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS challenges_game_idx ON challenges(game_code);

      CREATE TABLE IF NOT EXISTS picks (
        id           SERIAL PRIMARY KEY,
        game_code    TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        player_name  TEXT NOT NULL,
        player_token TEXT NOT NULL,
        row_idx      INTEGER,
        col_idx      INTEGER,
        claimed_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS picks_game_player_idx ON picks(game_code, player_name);

      CREATE TABLE IF NOT EXISTS groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        host_user_id TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS group_members (
        id          SERIAL PRIMARY KEY,
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id     TEXT,
        guest_name  TEXT,
        display_name TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member',
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS group_members_group_idx ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id);

      CREATE TABLE IF NOT EXISTS group_invites (
        id          SERIAL PRIMARY KEY,
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        code        TEXT UNIQUE NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS group_invites_code_idx ON group_invites(code);

      CREATE TABLE IF NOT EXISTS game_members (
        id          SERIAL PRIMARY KEY,
        game_code   TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
        group_id    TEXT REFERENCES groups(id),
        user_id     TEXT,
        guest_name  TEXT,
        display_name TEXT NOT NULL,
        assignment  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS game_members_game_idx ON game_members(game_code);
    `);
    console.log('Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function makeToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Squares backend running', version: '2.3-hardened' }));

// ── ESPN Scores ───────────────────────────────────────────────────────────────
app.get('/scores', rateLimit(60, 60 * 1000), async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  const dates = req.query.dates || '';
  const allowed = ['basketball/nba','basketball/mens-college-basketball','football/nfl','football/college-football'];
  if (!allowed.includes(sport)) return res.status(400).json({ error: 'Sport not supported' });
  const cacheKey = `scores:${sport}:${dates}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    let url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
    if (dates) url += `?dates=${dates}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json();
    const games = (data.events || []).map(ev => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      return {
        id: ev.id, name: ev.name, shortName: ev.shortName || ev.name,
        homeTeam: home?.team?.displayName || '?', homeAbbr: home?.team?.abbreviation || '?',
        homeScore: parseInt(home?.score || 0),
        awayTeam: away?.team?.displayName || '?', awayAbbr: away?.team?.abbreviation || '?',
        awayScore: parseInt(away?.score || 0),
        status: comp.status?.type?.description || '',
        shortDetail: comp.status?.type?.shortDetail || '',
        period: comp.status?.period || 0,
        clock: comp.status?.displayClock || '',
        completed: comp.status?.type?.completed || false,
        inProgress: ['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD'].includes(comp.status?.type?.name),
        statusName: comp.status?.type?.name || '',
      };
    });
    const result = { games };
    setCache(cacheKey, result, SCORES_TTL);
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'ESPN timeout' });
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// ── ESPN Play-by-Play ─────────────────────────────────────────────────────────
app.get('/playbyplay', rateLimit(60, 60 * 1000), async (req, res) => {
  const { gameId, sport } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  const allowedSports = ['basketball/nba','basketball/mens-college-basketball','football/nfl','football/college-football'];
  const safeSport = allowedSports.includes(sport) ? sport : 'basketball/mens-college-basketball';
  const pbpKey = `pbp:${safeSport}:${gameId}`;
  const cachedPbp = getCached(pbpKey);
  if (cachedPbp) return res.json(cachedPbp);

  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${safeSport}/summary?event=${gameId}`;
    const controller = new AbortController();
    const pbpTimeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(pbpTimeout);
    const data = await response.json();
    const plays = (data.plays || []).map(p => ({
      id: p.id, text: p.text || '',
      period: p.period?.number || 0,
      clock: p.clock?.displayValue || '',
      homeScore: p.homeScore, awayScore: p.awayScore,
    }));
    const pbpResult = { plays };
    setCache(pbpKey, pbpResult, PBP_TTL);
    res.json(pbpResult);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'ESPN timeout' });
    res.status(500).json({ error: 'Failed to fetch play-by-play' });
  }
});

// ── Game CRUD ─────────────────────────────────────────────────────────────────
app.post('/games', async (req, res) => {
  try {
    const { type = 'squares', data = {} } = req.body;
    const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const code = makeCode();
    const hostToken = makeToken();
    await pool.query(
      'INSERT INTO games (id, type, code, host_token, data) VALUES ($1, $2, $3, $4, $5)',
      [id, type, code, hostToken, JSON.stringify(data)]
    );
    res.json({ id, code, hostToken });
  } catch (err) {
    console.error('POST /games error:', err.message);
    res.status(500).json({ error: 'Failed to create game', detail: err.message });
  }
});

app.get('/games/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, type, code, data, updated_at FROM games WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Game not found' });
    const row = result.rows[0];
    res.json({ id: row.id, type: row.type, code: row.code, data: row.data, updatedAt: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get game' });
  }
});

app.put('/games/:code', async (req, res) => {
  try {
    const { hostToken, data } = req.body;
    if (!hostToken || !data) return res.status(400).json({ error: 'hostToken and data required' });
    const result = await pool.query(
      'UPDATE games SET data = $1, updated_at = NOW() WHERE code = $2 AND host_token = $3 RETURNING id',
      [JSON.stringify(data), req.params.code.toUpperCase(), hostToken]
    );
    if (!result.rows.length) return res.status(403).json({ error: 'Invalid code or token' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update game' });
  }
});

app.delete('/games/:code', async (req, res) => {
  try {
    const { hostToken } = req.body;
    if (!hostToken) return res.status(400).json({ error: 'hostToken required' });
    const result = await pool.query(
      'DELETE FROM games WHERE code = $1 AND host_token = $2 RETURNING id',
      [req.params.code.toUpperCase(), hostToken]
    );
    if (!result.rows.length) return res.status(403).json({ error: 'Invalid code or token' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete game' });
  }
});

// ── Challenges ────────────────────────────────────────────────────────────────

// Viewer submits a challenge
app.post('/games/:code/challenges', async (req, res) => {
  try {
    const { playerName, periodLabel, message = '' } = req.body;
    if (!playerName || !periodLabel) return res.status(400).json({ error: 'playerName and periodLabel required' });
    const game = await pool.query('SELECT type FROM games WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!game.rows.length) return res.status(404).json({ error: 'Game not found' });
    await pool.query(
      'INSERT INTO challenges (game_code, game_type, player_name, period_label, message) VALUES ($1, $2, $3, $4, $5)',
      [req.params.code.toUpperCase(), game.rows[0].type, playerName, periodLabel, message]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit challenge' });
  }
});

// Host gets all challenges
app.get('/games/:code/challenges', async (req, res) => {
  try {
    const { hostToken } = req.query;
    if (!hostToken) return res.status(400).json({ error: 'hostToken required' });
    const game = await pool.query('SELECT id FROM games WHERE code = $1 AND host_token = $2', [req.params.code.toUpperCase(), hostToken]);
    if (!game.rows.length) return res.status(403).json({ error: 'Invalid token' });
    const result = await pool.query(
      'SELECT * FROM challenges WHERE game_code = $1 ORDER BY created_at DESC',
      [req.params.code.toUpperCase()]
    );
    res.json({ challenges: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get challenges' });
  }
});

// Host resolves a challenge
app.patch('/games/:code/challenges/:id', async (req, res) => {
  try {
    const { hostToken, status } = req.body;
    if (!hostToken || !status) return res.status(400).json({ error: 'hostToken and status required' });
    const game = await pool.query('SELECT id FROM games WHERE code = $1 AND host_token = $2', [req.params.code.toUpperCase(), hostToken]);
    if (!game.rows.length) return res.status(403).json({ error: 'Invalid token' });
    await pool.query('UPDATE challenges SET status = $1 WHERE id = $2 AND game_code = $3', [status, req.params.id, req.params.code.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve challenge' });
  }
});

// ── Pick Requests (Squares only) ──────────────────────────────────────────────

// Host creates pick invites for all players
app.post('/games/:code/picks/invite', async (req, res) => {
  try {
    const { hostToken, players } = req.body;
    if (!hostToken || !players?.length) return res.status(400).json({ error: 'hostToken and players required' });
    const game = await pool.query(
      'SELECT id FROM games WHERE code = $1 AND host_token = $2 AND type = $3',
      [req.params.code.toUpperCase(), hostToken, 'squares']
    );
    if (!game.rows.length) return res.status(403).json({ error: 'Invalid token or not a squares game' });
    const code = req.params.code.toUpperCase();
    // Remove old unclaimed picks
    await pool.query('DELETE FROM picks WHERE game_code = $1 AND row_idx IS NULL', [code]);
    const links = [];
    for (const name of players) {
      const token = makeToken();
      await pool.query(
        `INSERT INTO picks (game_code, player_name, player_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (game_code, player_name) DO UPDATE SET player_token = $3`,
        [code, name, token]
      );
      links.push({ name, token });
    }
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create pick invites' });
  }
});

// Get pick statuses
app.get('/games/:code/picks', async (req, res) => {
  try {
    const { hostToken, playerToken } = req.query;
    const code = req.params.code.toUpperCase();
    if (hostToken) {
      const game = await pool.query('SELECT id FROM games WHERE code = $1 AND host_token = $2', [code, hostToken]);
      if (!game.rows.length) return res.status(403).json({ error: 'Invalid token' });
      const result = await pool.query('SELECT player_name, row_idx, col_idx, claimed_at FROM picks WHERE game_code = $1 ORDER BY player_name', [code]);
      return res.json({ picks: result.rows });
    }
    if (playerToken) {
      const result = await pool.query(
        'SELECT p.player_name, p.row_idx, p.col_idx, g.data FROM picks p JOIN games g ON g.code = p.game_code WHERE p.game_code = $1 AND p.player_token = $2',
        [code, playerToken]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Pick link not found' });
      return res.json({ pick: result.rows[0] });
    }
    return res.status(400).json({ error: 'hostToken or playerToken required' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get picks' });
  }
});

// Player claims a square
app.post('/games/:code/picks/claim', async (req, res) => {
  try {
    const { playerToken, rowIdx, colIdx } = req.body;
    if (!playerToken || rowIdx === undefined || colIdx === undefined) return res.status(400).json({ error: 'playerToken, rowIdx, colIdx required' });
    const code = req.params.code.toUpperCase();

    const playerResult = await pool.query(
      'SELECT player_name, row_idx FROM picks WHERE game_code = $1 AND player_token = $2',
      [code, playerToken]
    );
    if (!playerResult.rows.length) return res.status(404).json({ error: 'Pick link not found' });
    const player = playerResult.rows[0];
    if (player.row_idx !== null) return res.status(409).json({ error: 'You already picked a square' });

    // Check deadline
    const gameResult = await pool.query('SELECT data FROM games WHERE code = $1', [code]);
    if (gameResult.rows.length) {
      const deadline = gameResult.rows[0].data?.pickDeadline;
      if (deadline && new Date(deadline) < new Date()) return res.status(403).json({ error: 'Pick deadline has passed' });
    }

    // Check if square is taken
    const taken = await pool.query('SELECT player_name FROM picks WHERE game_code = $1 AND row_idx = $2 AND col_idx = $3', [code, rowIdx, colIdx]);
    if (taken.rows.length) return res.status(409).json({ error: `Square already taken by ${taken.rows[0].player_name}` });

    // Claim it
    await pool.query(
      'UPDATE picks SET row_idx = $1, col_idx = $2, claimed_at = NOW() WHERE game_code = $3 AND player_token = $4',
      [rowIdx, colIdx, code, playerToken]
    );

    // Sync grid back to game data
    const allPicks = await pool.query('SELECT player_name, row_idx, col_idx FROM picks WHERE game_code = $1 AND row_idx IS NOT NULL', [code]);
    const gameData = gameResult.rows[0]?.data || {};
    const grid = (gameData.grid || Array(5).fill(null).map(() => Array(5).fill(''))).map(r => [...r]);
    for (const p of allPicks.rows) {
      if (p.row_idx !== null) grid[p.row_idx][p.col_idx] = p.player_name;
    }
    await pool.query('UPDATE games SET data = data || $1::jsonb, updated_at = NOW() WHERE code = $2', [JSON.stringify({ grid }), code]);

    res.json({ ok: true, playerName: player.player_name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to claim square' });
  }
});


// ── Groups ────────────────────────────────────────────────────────────────────

// Create a group
app.post('/groups', async (req, res) => {
  try {
    const { name, hostUserId, displayName } = req.body;
    if (!name || !hostUserId) return res.status(400).json({ error: 'name and hostUserId required' });
    const id = makeCode();
    await pool.query(
      'INSERT INTO groups (id, name, host_user_id) VALUES ($1, $2, $3)',
      [id, name, hostUserId]
    );
    // Add host as a member with role 'host'
    await pool.query(
      'INSERT INTO group_members (group_id, user_id, display_name, role) VALUES ($1, $2, $3, $4)',
      [id, hostUserId, displayName || 'Host', 'host']
    );
    res.json({ id, name });
  } catch (err) {
    console.error('POST /groups error:', err.message);
    res.status(500).json({ error: 'Failed to create group', detail: err.message });
  }
});

// Get all groups for a user
app.get('/groups', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const result = await pool.query(
      `SELECT g.id, g.name, g.host_user_id, g.created_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get groups' });
  }
});

// Get a single group with members
app.get('/groups/:id', async (req, res) => {
  try {
    const { userId } = req.query;
    const group = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });
    const members = await pool.query(
      'SELECT * FROM group_members WHERE group_id = $1 ORDER BY role DESC, joined_at ASC',
      [req.params.id]
    );
    const isHost = group.rows[0].host_user_id === userId;
    res.json({ ...group.rows[0], members: members.rows, isHost });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get group' });
  }
});

// Generate a new invite link (expires in 24 hours)
app.post('/groups/:id/invite', async (req, res) => {
  try {
    const { userId } = req.body;
    const group = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (!group.rows.length) return res.status(404).json({ error: 'Not found' });
    if (group.rows[0].host_user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
    
    // Invalidate old invites for this group
    await pool.query('DELETE FROM group_invites WHERE group_id = $1', [req.params.id]);
    
    const code = makeCode() + makeCode().slice(0, 2); // 8 char code
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await pool.query(
      'INSERT INTO group_invites (group_id, code, expires_at) VALUES ($1, $2, $3)',
      [req.params.id, code, expiresAt]
    );
    res.json({ code, expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// Join a group via invite code
app.post('/groups/join', async (req, res) => {
  try {
    const { code, userId, displayName } = req.body;
    if (!code || !displayName) return res.status(400).json({ error: 'code and displayName required' });
    
    // Check invite is valid and not expired
    const invite = await pool.query(
      'SELECT * FROM group_invites WHERE code = $1 AND expires_at > NOW()',
      [code]
    );
    if (!invite.rows.length) return res.status(404).json({ error: 'Invite link expired or invalid' });
    
    const groupId = invite.rows[0].group_id;
    
    // Check if already a member
    if (userId) {
      const existing = await pool.query(
        'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, userId]
      );
      if (existing.rows.length) return res.json({ groupId, alreadyMember: true });
    }
    
    await pool.query(
      'INSERT INTO group_members (group_id, user_id, guest_name, display_name, role) VALUES ($1, $2, $3, $4, $5)',
      [groupId, userId || null, userId ? null : displayName, displayName, 'member']
    );
    
    res.json({ groupId, joined: true });
  } catch (err) {
    console.error('POST /groups/join error:', err.message);
    res.status(500).json({ error: 'Failed to join group', detail: err.message });
  }
});

// Remove a member from a group
app.delete('/groups/:id/members/:memberId', async (req, res) => {
  try {
    const { userId } = req.body;
    const group = await pool.query('SELECT host_user_id FROM groups WHERE id = $1', [req.params.id]);
    if (!group.rows.length) return res.status(404).json({ error: 'Not found' });
    if (group.rows[0].host_user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
    await pool.query('DELETE FROM group_members WHERE id = $1 AND group_id = $2', [req.params.memberId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Get games for a group member (their dashboard)
app.get('/groups/:id/games', async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(
      `SELECT g.type, g.code, g.data, g.updated_at, gm.assignment, gm.display_name
       FROM game_members gm
       JOIN games g ON g.code = gm.game_code
       WHERE gm.group_id = $1 AND (gm.user_id = $2 OR $2 IS NULL)
       ORDER BY g.updated_at DESC`,
      [req.params.id, userId || null]
    );
    res.json({ games: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get group games' });
  }
});

// Add members to a game
app.post('/games/:code/members', async (req, res) => {
  try {
    const { hostToken, groupId, members } = req.body;
    // Verify host
    const game = await pool.query('SELECT host_token FROM games WHERE code = $1', [req.params.code]);
    if (!game.rows.length) return res.status(404).json({ error: 'Game not found' });
    if (game.rows[0].host_token !== hostToken) return res.status(403).json({ error: 'Not authorized' });
    
    // Insert each member
    for (const m of members) {
      await pool.query(
        `INSERT INTO game_members (game_code, group_id, user_id, guest_name, display_name, assignment)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [req.params.code, groupId, m.userId || null, m.guestName || null, m.displayName, m.assignment || null]
      );
    }
    res.json({ ok: true, added: members.length });
  } catch (err) {
    console.error('POST /games/:code/members error:', err.message);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
async function ensureSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      host_token  TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT 'Game Day',
      game_codes  TEXT[] NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
ensureSessionTable().catch(e => console.error('Session table error:', e.message));

app.post('/sessions', async (req, res) => {
  try {
    const { name = 'Game Day', gameCodes = [] } = req.body;
    const id = makeCode();
    const hostToken = makeToken();
    await pool.query(
      'INSERT INTO sessions (id, host_token, name, game_codes) VALUES ($1, $2, $3, $4)',
      [id, hostToken, name, gameCodes]
    );
    res.json({ id, hostToken });
  } catch (err) {
    console.error('POST /sessions error:', err.message);
    res.status(500).json({ error: 'Failed to create session', detail: err.message });
  }
});

app.get('/sessions/:id', async (req, res) => {
  try {
    const sess = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id.toUpperCase()]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Session not found' });
    const { id, name, game_codes, host_token, created_at } = sess.rows[0];
    const games = [];
    for (const code of game_codes) {
      const g = await pool.query('SELECT type, code, data, updated_at FROM games WHERE code = $1', [code]);
      if (g.rows.length) {
        const { type, code: gcode, data, updated_at } = g.rows[0];
        games.push({ type, code: gcode, data, updatedAt: updated_at });
      }
    }
    const isHost = req.query.hostToken === host_token;
    res.json({ id, name, games, createdAt: created_at, isHost });
  } catch (err) {
    console.error('GET /sessions error:', err.message);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.put('/sessions/:id', async (req, res) => {
  try {
    const { hostToken, name, gameCodes } = req.body;
    const sess = await pool.query('SELECT host_token FROM sessions WHERE id = $1', [req.params.id.toUpperCase()]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Not found' });
    if (sess.rows[0].host_token !== hostToken) return res.status(403).json({ error: 'Not authorized' });
    const fields = [];
    const vals = [];
    let i = 1;
    if (name !== undefined) { fields.push(`name = $${i++}`); vals.push(name); }
    if (gameCodes !== undefined) { fields.push(`game_codes = $${i++}`); vals.push(gameCodes); }
    fields.push(`updated_at = NOW()`);
    vals.push(req.params.id.toUpperCase());
    await pool.query(`UPDATE sessions SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update session' });
  }
});

app.listen(PORT, () => console.log(`Squares backend v2.2 running on port ${PORT}`));
