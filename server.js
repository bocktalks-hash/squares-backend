const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Database setup ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.query(`
  CREATE TABLE IF NOT EXISTS shared_games (
    code        TEXT PRIMARY KEY,
    type        TEXT NOT NULL DEFAULT 'squares',
    host_token  TEXT NOT NULL,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id           SERIAL PRIMARY KEY,
    game_code    TEXT NOT NULL REFERENCES shared_games(code) ON DELETE CASCADE,
    player_name  TEXT NOT NULL,
    period_label TEXT NOT NULL,
    message      TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TIMESTAMPTZ DEFAULT NOW()
  );
`).then(() => console.log('DB tables ready'))
  .catch(err => console.error('DB init error:', err.message));

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bock Talks backend running!', version: '1.1.0' });
});

// ─── Allowed sports ───────────────────────────────────────────────────────────
const ALLOWED_SPORTS = [
  'basketball/nba',
  'basketball/mens-college-basketball',
  'football/nfl',
  'football/college-football',
];

// ─── GET /scores?sport=basketball/nba ────────────────────────────────────────
// Returns today's games with live scores and status
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';

  if (!ALLOWED_SPORTS.includes(sport)) {
    return res.status(400).json({ error: 'Sport not supported', allowed: ALLOWED_SPORTS });
  }

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
    const response = await fetch(url, { headers: { 'User-Agent': 'BockTalks/1.0' } });

    if (!response.ok) {
      return res.status(502).json({ error: `ESPN returned ${response.status}` });
    }

    const data = await response.json();

    const games = (data.events || []).map(ev => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const status = comp.status;

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
        status: status?.type?.description || '',
        shortDetail: status?.type?.shortDetail || '',
        period: status?.period || 0,
        clock: status?.displayClock || '',
        completed: status?.type?.completed || false,
        inProgress: ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD']
          .includes(status?.type?.name),
        statusName: status?.type?.name || '',
        startTime: ev.date,
      };
    });

    res.json({ games, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error('ESPN /scores error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores from ESPN' });
  }
});

// ─── GET /playbyplay?gameId=401234567&sport=basketball/mens-college-basketball ─
// Returns play-by-play for a specific game — used by Timeout Game to detect
// "Official TV Timeout" events
app.get('/playbyplay', async (req, res) => {
  const { gameId, sport } = req.query;

  if (!gameId) {
    return res.status(400).json({ error: 'gameId is required' });
  }

  const resolvedSport = sport || 'basketball/mens-college-basketball';

  if (!ALLOWED_SPORTS.includes(resolvedSport)) {
    return res.status(400).json({ error: 'Sport not supported' });
  }

  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${resolvedSport}/summary?event=${gameId}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'BockTalks/1.0' } });

    if (!response.ok) {
      return res.status(502).json({ error: `ESPN returned ${response.status}` });
    }

    const data = await response.json();

    // Pull scoring summary and plays
    const plays = [];
    const tvTimeouts = [];

    // Walk through plays arrays per period
    const playByPlay = data.plays || [];
    playByPlay.forEach(play => {
      const text = (play.text || '').toLowerCase();
      const isTimeout = text.includes('official tv timeout') || text.includes('tv timeout');

      const entry = {
        id: play.id,
        period: play.period?.number || 0,
        clock: play.clock?.displayValue || '',
        text: play.text || '',
        homeScore: play.homeScore || 0,
        awayScore: play.awayScore || 0,
        isOfficialTvTimeout: isTimeout,
      };

      plays.push(entry);
      if (isTimeout) tvTimeouts.push(entry);
    });

    // Also pull boxscore for current score
    const homeTeam = data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home');
    const awayTeam = data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away');
    const status = data.header?.competitions?.[0]?.status;

    res.json({
      gameId,
      homeTeam: homeTeam?.team?.displayName || '?',
      homeScore: parseInt(homeTeam?.score || 0),
      awayTeam: awayTeam?.team?.displayName || '?',
      awayScore: parseInt(awayTeam?.score || 0),
      status: status?.type?.description || '',
      period: status?.period || 0,
      clock: status?.displayClock || '',
      completed: status?.type?.completed || false,
      plays,
      tvTimeouts,       // Just the TV timeout events for easy scanning
      totalPlays: plays.length,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('ESPN /playbyplay error:', err.message);
    res.status(500).json({ error: 'Failed to fetch play-by-play from ESPN' });
  }
});

// ─── GET /game?gameId=401234567&sport=... ─────────────────────────────────────
// Lightweight current score + status for a single game (used for fast polling)
app.get('/game', async (req, res) => {
  const { gameId, sport } = req.query;

  if (!gameId) return res.status(400).json({ error: 'gameId is required' });

  const resolvedSport = sport || 'basketball/nba';

  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${resolvedSport}/summary?event=${gameId}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'BockTalks/1.0' } });

    if (!response.ok) return res.status(502).json({ error: `ESPN ${response.status}` });

    const data = await response.json();

    const comp = data.header?.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    const status = comp?.status;

    res.json({
      gameId,
      homeTeam: home?.team?.displayName || '?',
      homeAbbr: home?.team?.abbreviation || '?',
      homeScore: parseInt(home?.score || 0),
      awayTeam: away?.team?.displayName || '?',
      awayAbbr: away?.team?.abbreviation || '?',
      awayScore: parseInt(away?.score || 0),
      status: status?.type?.description || '',
      period: status?.period || 0,
      clock: status?.displayClock || '',
      completed: status?.type?.completed || false,
      inProgress: ['STATUS_IN_PROGRESS', 'STATUS_HALFTIME', 'STATUS_END_PERIOD']
        .includes(status?.type?.name),
      statusName: status?.type?.name || '',
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('/game error:', err.message);
    res.status(500).json({ error: 'Failed to fetch game data' });
  }
});

// ─── POST /games — create a shared game ──────────────────────────────────────
app.post('/games', async (req, res) => {
  const { type, data } = req.body;
  if (!data) return res.status(400).json({ error: 'data is required' });

  let code, attempts = 0;
  while (attempts < 10) {
    code = makeCode();
    const exists = await pool.query('SELECT 1 FROM shared_games WHERE code=$1', [code]);
    if (exists.rowCount === 0) break;
    attempts++;
  }

  const hostToken = Math.random().toString(36).substring(2, 18) +
                    Math.random().toString(36).substring(2, 18);

  try {
    await pool.query(
      'INSERT INTO shared_games (code, type, host_token, data) VALUES ($1,$2,$3,$4)',
      [code, type || 'squares', hostToken, JSON.stringify(data)]
    );
    res.json({ code, hostToken });
  } catch (err) {
    console.error('POST /games error:', err.message);
    res.status(500).json({ error: 'Could not save game' });
  }
});

// ─── GET /games/:code — fetch game for viewers ────────────────────────────────
app.get('/games/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT code, type, data, updated_at FROM shared_games WHERE code=$1',
      [req.params.code.toUpperCase()]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Game not found' });
    const row = result.rows[0];
    res.json({ code: row.code, type: row.type, data: row.data, updatedAt: row.updated_at });
  } catch (err) {
    console.error('GET /games/:code error:', err.message);
    res.status(500).json({ error: 'Could not fetch game' });
  }
});

// ─── PUT /games/:code — host syncs game state ─────────────────────────────────
app.put('/games/:code', async (req, res) => {
  const { hostToken, data } = req.body;
  if (!hostToken || !data) return res.status(400).json({ error: 'hostToken and data required' });

  try {
    const result = await pool.query(
      `UPDATE shared_games
          SET data=$1, updated_at=NOW()
        WHERE code=$2 AND host_token=$3
        RETURNING code`,
      [JSON.stringify(data), req.params.code.toUpperCase(), hostToken]
    );
    if (result.rowCount === 0) return res.status(403).json({ error: 'Invalid code or token' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /games/:code error:', err.message);
    res.status(500).json({ error: 'Could not update game' });
  }
});

// ─── POST /games/:code/challenges — viewer submits a challenge ────────────────
app.post('/games/:code/challenges', async (req, res) => {
  const { playerName, periodLabel, message } = req.body;
  if (!playerName || !periodLabel) {
    return res.status(400).json({ error: 'playerName and periodLabel required' });
  }

  try {
    const gameCheck = await pool.query(
      'SELECT 1 FROM shared_games WHERE code=$1',
      [req.params.code.toUpperCase()]
    );
    if (gameCheck.rowCount === 0) return res.status(404).json({ error: 'Game not found' });

    const result = await pool.query(
      `INSERT INTO challenges (game_code, player_name, period_label, message)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.code.toUpperCase(), playerName, periodLabel, message || '']
    );
    res.json({ challenge: result.rows[0] });
  } catch (err) {
    console.error('POST /challenges error:', err.message);
    res.status(500).json({ error: 'Could not submit challenge' });
  }
});

// ─── GET /games/:code/challenges — host fetches all challenges ────────────────
app.get('/games/:code/challenges', async (req, res) => {
  const { hostToken } = req.query;
  if (!hostToken) return res.status(400).json({ error: 'hostToken required' });

  try {
    const auth = await pool.query(
      'SELECT 1 FROM shared_games WHERE code=$1 AND host_token=$2',
      [req.params.code.toUpperCase(), hostToken]
    );
    if (auth.rowCount === 0) return res.status(403).json({ error: 'Invalid token' });

    const result = await pool.query(
      'SELECT * FROM challenges WHERE game_code=$1 ORDER BY created_at DESC',
      [req.params.code.toUpperCase()]
    );
    res.json({ challenges: result.rows });
  } catch (err) {
    console.error('GET /challenges error:', err.message);
    res.status(500).json({ error: 'Could not fetch challenges' });
  }
});

// ─── PATCH /games/:code/challenges/:id — host resolves a challenge ────────────
app.patch('/games/:code/challenges/:id', async (req, res) => {
  const { hostToken, status } = req.body;
  if (!hostToken || !status) return res.status(400).json({ error: 'hostToken and status required' });
  if (!['accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: "status must be 'accepted' or 'dismissed'" });
  }

  try {
    const auth = await pool.query(
      'SELECT 1 FROM shared_games WHERE code=$1 AND host_token=$2',
      [req.params.code.toUpperCase(), hostToken]
    );
    if (auth.rowCount === 0) return res.status(403).json({ error: 'Invalid token' });

    await pool.query(
      'UPDATE challenges SET status=$1 WHERE id=$2 AND game_code=$3',
      [status, req.params.id, req.params.code.toUpperCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /challenges error:', err.message);
    res.status(500).json({ error: 'Could not update challenge' });
  }
});

app.listen(PORT, () => {
  console.log(`Bock Talks backend running on port ${PORT}`);
});
