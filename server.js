const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Squares backend is running!' });
});

// Scores endpoint
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  const allowed = [
    'basketball/nba',
    'basketball/mens-college-basketball',
    'football/nfl',
    'football/college-football'
  ];
  if (!allowed.includes(sport)) {
    return res.status(400).json({ error: 'Sport not supported' });
  }

  try {
    const date = req.query.dates || req.query.date || '';
    const dateParam = date ? `?dates=${date}` : '';
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard${dateParam}`;
    console.log('Fetching ESPN:', url);
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
        startTime: ev.date || '',
      };
    });

    res.json({ games });
  } catch (err) {
    console.error('ESPN fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

// Play-by-play endpoint for Timeout Game challenge feature
app.get('/playbyplay', async (req, res) => {
  const { gameId, sport } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  const sportPath = sport || 'basketball/mens-college-basketball';
  const allowed = [
    'basketball/nba',
    'basketball/mens-college-basketball',
    'football/nfl',
    'football/college-football'
  ];
  if (!allowed.includes(sportPath)) {
    return res.status(400).json({ error: 'Sport not supported' });
  }

  try {
    const url = `https://site.web.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${gameId}`;
    const response = await fetch(url);
    const data = await response.json();

    const plays = (data.plays || []).map(p => ({
      id: p.id,
      text: p.text || '',
      clock: p.clock?.displayValue || '',
      period: p.period?.number || 0,
      homeScore: p.homeScore,
      awayScore: p.awayScore,
      scoringPlay: p.scoringPlay || false,
      type: p.type?.text || '',
    }));

    res.json({ plays });
  } catch (err) {
    console.error('Play-by-play fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch play-by-play' });
  }
});

app.listen(PORT, () => {
  console.log(`Squares backend running on port ${PORT}`);
});
