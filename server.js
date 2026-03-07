const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your GitHub Pages site
app.use(cors());
app.use(express.json());

// Health check — visit this to confirm the server is running
app.get('/', (req, res) => {
  res.json({ status: 'Squares backend is running!' });
});

// ESPN scoreboard endpoint
// Usage: /scores?sport=basketball/nba
// Usage: /scores?sport=basketball/nba&date=20250315  (specific date)
app.get('/scores', async (req, res) => {
  const sport = req.query.sport || 'basketball/nba';
  const date = req.query.date || '';

  // Whitelist allowed sports so nobody can abuse the endpoint
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
    // If a date is provided, add it as a query param — ESPN accepts YYYYMMDD format
    const dateParam = date ? `?dates=${date}` : '';
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard${dateParam}`;
    const response = await fetch(url);
    const data = await response.json();

    // Pull out just what we need — keeps response small and fast
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
        startTime: ev.date || ''
      };
    });

    res.json({ games });

  } catch (err) {
    console.error('ESPN fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});

app.listen(PORT, () => {
  console.log(`Squares backend running on port ${PORT}`);
});
