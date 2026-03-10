const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Database setup ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Create tables if they don't exist yet
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
    `);
    console.log('✅ Database ready');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  }
}
initDB();

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Squares backend running', version: '2.0' });
});

// ── ESPN Scores ───────────────────────────────────────────────────────────────
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  const dates = req.query.dates || '';

  const allowed = [
    'basketball/nba',
    'basketball/mens-college-basketball',
    'football/nfl',
    'football/college-football',
  ];
  if (!allowed.includes(sport)) {
    return res.status(400).json({ error: 'Sport not supported' });
  }

  try {
    let url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
    if (dates) url += `?dates=${dates}`;

    const response = await fetch(url);
    const data = await response.json();

    const games = (data.events || []).map(ev => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      return {
        id: ev.id,
        name: ev.name,
        shortName: ev.shortName || ev.name,
        homeTeam: home?.team?.displayName || '?',
        homeAbbr: home?.team?.abbreviation || '?',
        homeScore: parseInt(home?.score || 0),
        awayTeam: away?.team?.displayName || '?',
        awayAbbr: away?.team?.abbreviation || '?',
        awayScore: parseInt(away?.score || 0),
        status: comp.status?.type?.description || '',
        shortDetail: comp.status?.type?.shortDetail || '',
        period: comp.status?.period || 0,
        clock: comp.status?.displayClock || '',
        completed: comp.status?.type?.completed || false,
        inProgress: ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD']
          .includes(comp.status?.type?.name),
        statusName: comp.status?.type?.name || '',
      };
    });

    res.json({ games });
  } catch (err) {
    console.error('ESPN fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// ── ESPN Play-by-Play ─────────────────────────────────────────────────────────
app.get('/playbyplay', async (req, res) => {
  const { gameId, sport } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  const allowedSports = [
    'basketball/nba',
    'basketball/mens-college-basketball',
    'football/nfl',
    'football/college-football',
  ];
  const safeSport = allowedSports.includes(sport) ? sport : 'basketball/mens-college-basketball';

  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${safeSport}/summary?event=${gameId}`;
    const response = await fetch(url);
    const data = await response.json();

    const plays = (data.plays || []).map(p => ({
      id: p.id,
      text: p.text || '',
      period: p.period?.number || 0,
      clock: p.clock?.displayValue || '',
      homeScore: p.homeScore,
      awayScore: p.awayScore,
    }));

    res.json({ plays });
  } catch (err) {
    console.error('Play-by-play error:', err);
    res.status(500).json({ error: 'Failed to fetch play-by-play' });
  }
});

// ── Game API ──────────────────────────────────────────────────────────────────

// Generate a short random code like "ABC123"
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Generate a longer random token for the host
function makeToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// POST /games — create a new game
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
    console.error('Create game error:', err);
    res.status(500).json({ error: 'Failed to create game' });
  }
});

// GET /games/:code — get a game by its share code (viewer access)
app.get('/games/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, type, code, data, created_at, updated_at FROM games WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Game not found' });

    const row = result.rows[0];
    res.json({ id: row.id, type: row.type, code: row.code, data: row.data, updatedAt: row.updated_at });
  } catch (err) {
    console.error('Get game error:', err);
    res.status(500).json({ error: 'Failed to get game' });
  }
});

// PUT /games/:code — update a game (host only, requires hostToken)
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
    console.error('Update game error:', err);
    res.status(500).json({ error: 'Failed to update game' });
  }
});

// DELETE /games/:code — delete a game (host only)
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
    console.error('Delete game error:', err);
    res.status(500).json({ error: 'Failed to delete game' });
  }
});

app.listen(PORT, () => {
  console.log(`Squares backend v2 running on port ${PORT}`);
});
