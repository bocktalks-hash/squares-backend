const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Run migrations sequentially
async function initDB() {
  await pool.query(`
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
  `);

  // Drop and recreate groups tables fresh to fix missing SERIAL sequences
  await pool.query(`
    DROP TABLE IF EXISTS group_invites CASCADE;
    DROP TABLE IF EXISTS group_members CASCADE;
    DROP TABLE IF EXISTS groups CASCADE;
  `);
  await pool.query(`
    CREATE TABLE groups (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      host_user_id TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE group_members (
      id           SERIAL PRIMARY KEY,
      group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id      TEXT,
      display_name TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      joined_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE group_invites (
      code       TEXT PRIMARY KEY,
      group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE
    );
  `);
  console.log('DB tables ready');
}

initDB().catch(err => console.error('DB init error:', err.message));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeCode(len = 6) {
  return Math.random().toString(36).substring(2, 2 + len).toUpperCase();
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Bock Talks backend running!', version: '2.0.0' });
});

// ─── Allowed sports ───────────────────────────────────────────────────────────
const ALLOWED_SPORTS = [
  'basketball/nba',
  'basketball/mens-college-basketball',
  'football/nfl',
  'football/college-football',
];

// ─── GET /scores ──────────────────────────────────────────────────────────────
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  if (!ALLOWED_SPORTS.includes(sport)) {
    return res.status(400).json({ error: 'Sport not supported', allowed: ALLOWED_SPORTS });
  }
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`;
    const response = await fetch(url, { headers: { 'User-Agent': 'BockTalks/1.0' } });
    if (!response.ok) return res.status(502).json({ error: `ESPN returned ${response.status}` });
    const data = await response.json();
    const games = (data.events || []).map(ev => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const status = comp.status;
      return {
        id: ev.id, name: ev.name, shortName: ev.shortName || ev.name,
        homeTeam: home?.team?.displayName || '?', homeAbbr: home?.team?.abbreviation || '?',
        homeScore: parseInt(home?.score || 0),
        awayTeam: away?.team?.displayName || '?', awayAbbr: away?.team?.abbreviation || '?',
        awayScore: parseInt(away?.score || 0),
        status: status?.type?.description || '', shortDetail: status?.type?.shortDetail || '',
        period: status?.period || 0, clock: status?.displayClock || '',
        completed: status?.type?.completed || false,
        inProgress: ['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD'].includes(status?.type?.name),
        statusName: status?.type?.name || '', startTime: ev.date,
      };
    });
    res.json({ games, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('ESPN /scores error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scores from ESPN' });
  }
});

// ─── GET /playbyplay ──────────────────────────────────────────────────────────
app.get('/playbyplay', async (req, res) => {
  const { gameId, sport } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId is required' });
  const resolvedSport = sport || 'basketball/mens-college-basketball';
  if (!ALLOWED_SPORTS.includes(resolvedSport)) return res.status(400).json({ error: 'Sport not supported' });
  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${resolvedSport}/summary?event=${gameId}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'BockTalks/1.0' } });
    if (!response.ok) return res.status(502).json({ error: `ESPN returned ${response.status}` });
    const data = await response.json();
    const plays = [], tvTimeouts = [];
    (data.plays || []).forEach(play => {
      const text = (play.text || '').toLowerCase();
      const isTimeout = text.includes('official tv timeout') || text.includes('tv timeout');
      const entry = {
        id: play.id, period: play.period?.number || 0,
        clock: play.clock?.displayValue || '', text: play.text || '',
        homeScore: play.homeScore || 0, awayScore: play.awayScore || 0,
        isOfficialTvTimeout: isTimeout,
      };
      plays.push(entry);
      if (isTimeout) tvTimeouts.push(entry);
    });
    const homeTeam = data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home');
    const awayTeam = data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away');
    const status = data.header?.competitions?.[0]?.status;
    res.json({
      gameId,
      homeTeam: homeTeam?.team?.displayName || '?', homeScore: parseInt(homeTeam?.score || 0),
      awayTeam: awayTeam?.team?.displayName || '?', awayScore: parseInt(awayTeam?.score || 0),
      status: status?.type?.description || '', period: status?.period || 0,
      clock: status?.displayClock || '', completed: status?.type?.completed || false,
      plays, tvTimeouts, totalPlays: plays.length, fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('ESPN /playbyplay error:', err.message);
    res.status(500).json({ error: 'Failed to fetch play-by-play from ESPN' });
  }
});

// ─── GET /game ────────────────────────────────────────────────────────────────
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
      homeTeam: home?.team?.displayName || '?', homeAbbr: home?.team?.abbreviation || '?',
      homeScore: parseInt(home?.score || 0),
      awayTeam: away?.team?.displayName || '?', awayAbbr: away?.team?.abbreviation || '?',
      awayScore: parseInt(away?.score || 0),
      status: status?.type?.description || '', period: status?.period || 0,
      clock: status?.displayClock || '', completed: status?.type?.completed || false,
      inProgress: ['STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_END_PERIOD'].includes(status?.type?.name),
      statusName: status?.type?.name || '', fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('/game error:', err.message);
    res.status(500).json({ error: 'Failed to fetch game data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED GAMES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/games', async (req, res) => {
  const { type, data } = req.body;
  if (!data) return res.status(400).json({ error: 'data is required' });
  let code, attempts = 0;
  while (attempts < 10) {
    code = makeCode(6);
    const exists = await pool.query('SELECT 1 FROM shared_games WHERE code=$1', [code]);
    if (exists.rowCount === 0) break;
    attempts++;
  }
  const hostToken = makeCode(16) + makeCode(16);
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

app.put('/games/:code', async (req, res) => {
  const { hostToken, data } = req.body;
  if (!hostToken || !data) return res.status(400).json({ error: 'hostToken and data required' });
  try {
    const result = await pool.query(
      'UPDATE shared_games SET data=$1, updated_at=NOW() WHERE code=$2 AND host_token=$3 RETURNING code',
      [JSON.stringify(data), req.params.code.toUpperCase(), hostToken]
    );
    if (result.rowCount === 0) return res.status(403).json({ error: 'Invalid code or token' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /games/:code error:', err.message);
    res.status(500).json({ error: 'Could not update game' });
  }
});

app.post('/games/:code/challenges', async (req, res) => {
  const { playerName, periodLabel, message } = req.body;
  if (!playerName || !periodLabel) return res.status(400).json({ error: 'playerName and periodLabel required' });
  try {
    const gameCheck = await pool.query('SELECT 1 FROM shared_games WHERE code=$1', [req.params.code.toUpperCase()]);
    if (gameCheck.rowCount === 0) return res.status(404).json({ error: 'Game not found' });
    const result = await pool.query(
      'INSERT INTO challenges (game_code, player_name, period_label, message) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.code.toUpperCase(), playerName, periodLabel, message || '']
    );
    res.json({ challenge: result.rows[0] });
  } catch (err) {
    console.error('POST /challenges error:', err.message);
    res.status(500).json({ error: 'Could not submit challenge' });
  }
});

app.get('/games/:code/challenges', async (req, res) => {
  const { hostToken } = req.query;
  if (!hostToken) return res.status(400).json({ error: 'hostToken required' });
  try {
    const auth = await pool.query('SELECT 1 FROM shared_games WHERE code=$1 AND host_token=$2', [req.params.code.toUpperCase(), hostToken]);
    if (auth.rowCount === 0) return res.status(403).json({ error: 'Invalid token' });
    const result = await pool.query('SELECT * FROM challenges WHERE game_code=$1 ORDER BY created_at DESC', [req.params.code.toUpperCase()]);
    res.json({ challenges: result.rows });
  } catch (err) {
    console.error('GET /challenges error:', err.message);
    res.status(500).json({ error: 'Could not fetch challenges' });
  }
});

app.patch('/games/:code/challenges/:id', async (req, res) => {
  const { hostToken, status } = req.body;
  if (!hostToken || !status) return res.status(400).json({ error: 'hostToken and status required' });
  if (!['accepted', 'dismissed'].includes(status)) return res.status(400).json({ error: "status must be 'accepted' or 'dismissed'" });
  try {
    const auth = await pool.query('SELECT 1 FROM shared_games WHERE code=$1 AND host_token=$2', [req.params.code.toUpperCase(), hostToken]);
    if (auth.rowCount === 0) return res.status(403).json({ error: 'Invalid token' });
    await pool.query('UPDATE challenges SET status=$1 WHERE id=$2 AND game_code=$3', [status, req.params.id, req.params.code.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /challenges error:', err.message);
    res.status(500).json({ error: 'Could not update challenge' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /groups?userId=xxx — list groups for a user
app.get('/groups', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.host_user_id, g.created_at,
             COUNT(gm.id)::int AS member_count
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id IN (
         SELECT group_id FROM group_members WHERE user_id = $1
       )
       GROUP BY g.id
       ORDER BY g.created_at DESC
    `, [userId]);
    res.json({ groups: result.rows });
  } catch (err) {
    console.error('GET /groups error:', err.message);
    res.status(500).json({ error: 'Could not fetch groups' });
  }
});

// POST /groups — create a group
app.post('/groups', async (req, res) => {
  const { name, hostUserId, displayName } = req.body;
  if (!name || !hostUserId) return res.status(400).json({ error: 'name and hostUserId required' });
  try {
    const group = await pool.query(
      'INSERT INTO groups (name, host_user_id) VALUES ($1,$2) RETURNING *',
      [name.trim(), hostUserId]
    );
    const g = group.rows[0];
    // Add host as first member
    await pool.query(
      'INSERT INTO group_members (group_id, user_id, display_name, role) VALUES ($1,$2,$3,$4)',
      [g.id, hostUserId, displayName || 'Host', 'host']
    );
    res.json({ id: g.id, name: g.name, host_user_id: g.host_user_id });
  } catch (err) {
    console.error('POST /groups error:', err.message);
    res.status(500).json({ error: 'Could not create group' });
  }
});

// GET /groups/:id?userId=xxx — get group detail with members
app.get('/groups/:id', async (req, res) => {
  const { userId } = req.query;
  try {
    const group = await pool.query('SELECT * FROM groups WHERE id=$1', [req.params.id]);
    if (group.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const g = group.rows[0];

    // Check membership if userId provided
    if (userId) {
      const mem = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', [g.id, userId]);
      if (mem.rowCount === 0) return res.status(403).json({ error: 'Not a member of this group' });
    }

    const members = await pool.query(
      'SELECT * FROM group_members WHERE group_id=$1 ORDER BY joined_at ASC',
      [g.id]
    );
    res.json({ ...g, members: members.rows });
  } catch (err) {
    console.error('GET /groups/:id error:', err.message);
    res.status(500).json({ error: 'Could not fetch group' });
  }
});

// POST /groups/:id/invite — generate an invite link (host only)
app.post('/groups/:id/invite', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const group = await pool.query('SELECT * FROM groups WHERE id=$1 AND host_user_id=$2', [req.params.id, userId]);
    if (group.rowCount === 0) return res.status(403).json({ error: 'Not the host of this group' });

    const code = makeCode(8);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await pool.query(
      'INSERT INTO group_invites (code, group_id, created_by, expires_at) VALUES ($1,$2,$3,$4)',
      [code, req.params.id, userId, expiresAt]
    );
    res.json({ code, expiresAt });
  } catch (err) {
    console.error('POST /groups/:id/invite error:', err.message);
    res.status(500).json({ error: 'Could not create invite' });
  }
});

// GET /groups/join/:code — look up an invite (before joining)
app.get('/groups/join/:code', async (req, res) => {
  try {
    const invite = await pool.query(
      'SELECT gi.*, g.name AS group_name FROM group_invites gi JOIN groups g ON g.id = gi.group_id WHERE gi.code=$1',
      [req.params.code]
    );
    if (invite.rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
    const inv = invite.rows[0];
    if (inv.used) return res.status(410).json({ error: 'Invite already used' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });
    res.json({ groupId: inv.group_id, groupName: inv.group_name, expiresAt: inv.expires_at });
  } catch (err) {
    console.error('GET /groups/join/:code error:', err.message);
    res.status(500).json({ error: 'Could not look up invite' });
  }
});

// POST /groups/join/:code — accept an invite and join
app.post('/groups/join/:code', async (req, res) => {
  const { userId, displayName } = req.body;
  if (!displayName) return res.status(400).json({ error: 'displayName required' });
  try {
    const invite = await pool.query(
      'SELECT * FROM group_invites WHERE code=$1',
      [req.params.code]
    );
    if (invite.rowCount === 0) return res.status(404).json({ error: 'Invite not found' });
    const inv = invite.rows[0];
    if (inv.used) return res.status(410).json({ error: 'Invite already used' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });

    // Check not already a member
    if (userId) {
      const existing = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
        [inv.group_id, userId]
      );
      if (existing.rowCount > 0) return res.json({ alreadyMember: true, groupId: inv.group_id });
    }

    await pool.query(
      'INSERT INTO group_members (group_id, user_id, display_name, role) VALUES ($1,$2,$3,$4)',
      [inv.group_id, userId || null, displayName.trim(), 'member']
    );

    // Mark invite as used (single-use)
    await pool.query('UPDATE group_invites SET used=TRUE WHERE code=$1', [req.params.code]);

    const group = await pool.query('SELECT name FROM groups WHERE id=$1', [inv.group_id]);
    res.json({ ok: true, groupId: inv.group_id, groupName: group.rows[0]?.name });
  } catch (err) {
    console.error('POST /groups/join/:code error:', err.message);
    res.status(500).json({ error: 'Could not join group' });
  }
});

// DELETE /groups/:id/members/:memberId — host removes a member
app.delete('/groups/:id/members/:memberId', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const group = await pool.query('SELECT * FROM groups WHERE id=$1 AND host_user_id=$2', [req.params.id, userId]);
    if (group.rowCount === 0) return res.status(403).json({ error: 'Not the host' });
    await pool.query('DELETE FROM group_members WHERE id=$1 AND group_id=$2', [req.params.memberId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /groups member error:', err.message);
    res.status(500).json({ error: 'Could not remove member' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Bock Talks backend running on port ${PORT}`);
});
