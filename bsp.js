// api/bsp.js — Vercel serverless function
// Fetches BSP for win + any extra place markets for a given race

const BETFAIR_LOGIN = 'https://identitysso.betfair.com/api/login';
const BETFAIR_API   = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY       = process.env.BETFAIR_APP_KEY;
const BF_EMAIL      = process.env.BETFAIR_EMAIL;
const BF_PASS       = process.env.BETFAIR_PASS;

async function getSessionToken() {
  const params = new URLSearchParams({ username: BF_EMAIL, password: BF_PASS });
  const res = await fetch(BETFAIR_LOGIN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Application': APP_KEY,
      'Accept': 'application/json',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.status !== 'SUCCESS') throw new Error('Betfair login failed: ' + data.error);
  return data.token;
}

async function betfairCall(sessionToken, method, params) {
  const res = await fetch(`${BETFAIR_API}/${method}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': APP_KEY,
      'X-Authentication': sessionToken,
    },
    body: JSON.stringify(params),
  });
  return res.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { course, date, time, horse } = req.query;
  // date format expected: YYYY-MM-DD, time: HH:MM

  if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

  try {
    const token = await getSessionToken();

    // Search window: ±2 hours around race time to catch all market types
    const raceDate = new Date(`${date}T${time || '12:00'}:00Z`);
    const from = new Date(raceDate.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const to   = new Date(raceDate.getTime() + 2 * 60 * 60 * 1000).toISOString();

    // Fetch all UK/IE horse racing markets around this race time
    const markets = await betfairCall(token, 'listMarketCatalogue', {
      filter: {
        eventTypeIds: ['7'], // Horse Racing
        marketCountries: ['GB', 'IE'],
        marketStartTime: { from, to },
        textQuery: course || undefined,
      },
      marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'EVENT'],
      maxResults: 50,
      sort: 'FIRST_TO_START',
    });

    if (!markets || !markets.length) {
      return res.status(404).json({ error: 'No markets found for this race' });
    }

    // Filter to markets matching our race time (within 10 mins)
    const raceMs = raceDate.getTime();
    const matchingMarkets = markets.filter(m => {
      const mMs = new Date(m.marketStartTime).getTime();
      return Math.abs(mMs - raceMs) < 10 * 60 * 1000;
    });

    if (!matchingMarkets.length) {
      // Fall back to all returned markets if time filter too strict
      matchingMarkets.push(...markets.slice(0, 5));
    }

    const marketIds = matchingMarkets.map(m => m.marketId);

    // Fetch BSP for all runners in these markets
    const books = await betfairCall(token, 'listMarketBook', {
      marketIds,
      priceProjection: { bspPrices: true },
    });

    // Build response: for each market, find our horse and return its BSP
    const results = matchingMarkets.map(market => {
      const book = books.find(b => b.marketId === market.marketId);
      const runners = (book?.runners || []).map(r => {
        const runnerDesc = market.runners?.find(rd => rd.selectionId === r.selectionId);
        return {
          name: runnerDesc?.runnerName || 'Unknown',
          selectionId: r.selectionId,
          bsp: r.sp?.actualSP || null,
          status: r.status,
        };
      }).filter(r => r.status !== 'REMOVED');

      // Try to match horse name if provided
      let targetRunner = null;
      if (horse) {
        const horseLower = horse.toLowerCase().replace(/[^a-z0-9]/g, '');
        targetRunner = runners.find(r => {
          const nameLower = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return nameLower.includes(horseLower) || horseLower.includes(nameLower);
        });
      }

      return {
        marketId: market.marketId,
        marketName: market.marketName || market.marketId,
        startTime: market.marketStartTime,
        targetRunner,
        allRunners: runners,
      };
    });

    return res.status(200).json({ markets: results });

  } catch (err) {
    console.error('BSP fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
}
