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
app.get('/', (req, res) => res.json({ status: 'Squares backend running', version: '2.1' }));

// ── ESPN Scores ───────────────────────────────────────────────────────────────
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  const dates = req.query.dates || '';
  const allowed = ['basketball/nba','basketball/mens-college-basketball','football/nfl','football/college-football'];
  if (!allowed.includes(sport)) return res.status(400).json({ error: 'Sport not supported' });
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
    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// ── ESPN Play-by-Play ─────────────────────────────────────────────────────────
app.get('/playbyplay', async (req, res) => {
  const { gameId, sport } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  const allowedSports = ['basketball/nba','basketball/mens-college-basketball','football/nfl','football/college-football'];
  const safeSport = allowedSports.includes(sport) ? sport : 'basketball/mens-college-basketball';
  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${safeSport}/summary?event=${gameId}`;
    const response = await fetch(url);
    const data = await response.json();
    const plays = (data.plays || []).map(p => ({
      id: p.id, text: p.text || '',
      period: p.period?.number || 0,
      clock: p.clock?.displayValue || '',
      homeScore: p.homeScore, awayScore: p.awayScore,
    }));
    res.json({ plays });
  } catch (err) {
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
    res.status(500).json({ error: 'Failed to create game' });
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

app.listen(PORT, () => console.log(`Squares backend v2.1 running on port ${PORT}`));
