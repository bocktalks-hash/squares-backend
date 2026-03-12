const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Bock Talks backend running on port ${PORT}`);
});
