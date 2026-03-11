// api/bsp.js — Vercel serverless function
// Fetches Win BSP + Place BSPs (with place count) for a given race

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

function extractPlaceCount(marketName) {
  const m = marketName.match(/(\d+)\s*place/i);
  return m ? parseInt(m[1]) : null;
}

function classifyMarket(marketType, marketName) {
  if (marketType === 'WIN' || /^win$/i.test(marketName)) return 'win';
  if (marketType === 'PLACE') return 'place';
  if (/extra.?place|each.?way/i.test(marketName)) return 'place';
  if (/to be placed|place betting/i.test(marketName)) return 'place';
  if (/match.?odds/i.test(marketName)) return 'win';
  return 'other';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { course, date, time, horse, ewPlaces } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });

  const requestedPlaces = ewPlaces ? parseInt(ewPlaces) : null;

  try {
    const token = await getSessionToken();

    const raceDate = new Date(`${date}T${time || '12:00'}:00Z`);
    const from = new Date(raceDate.getTime() - 30 * 60 * 1000).toISOString();
    const to   = new Date(raceDate.getTime() + 30 * 60 * 1000).toISOString();

    const markets = await betfairCall(token, 'listMarketCatalogue', {
      filter: {
        eventTypeIds: ['7'],
        marketCountries: ['GB', 'IE'],
        marketStartTime: { from, to },
        textQuery: course || undefined,
      },
      marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'EVENT'],
      maxResults: 100,
      sort: 'FIRST_TO_START',
    });

    if (!markets?.length) {
      return res.status(404).json({ error: 'No markets found for this race' });
    }

    const raceMs = raceDate.getTime();
    let matchingMarkets = markets.filter(m =>
      Math.abs(new Date(m.marketStartTime).getTime() - raceMs) < 10 * 60 * 1000
    );
    if (!matchingMarkets.length) matchingMarkets = markets.slice(0, 10);

    const marketIds = matchingMarkets.map(m => m.marketId);

    const books = await betfairCall(token, 'listMarketBook', {
      marketIds,
      priceProjection: { bspPrices: true },
    });

    const enriched = matchingMarkets.map(market => {
      const marketType = market.description?.marketType || '';
      const marketName = market.marketName || '';
      const kind = classifyMarket(marketType, marketName);
      const placeCount = kind === 'place' ? extractPlaceCount(marketName) : null;

      const book = books.find(b => b.marketId === market.marketId);
      const runners = (book?.runners || []).map(r => {
        const desc = market.runners?.find(rd => rd.selectionId === r.selectionId);
        return {
          name: desc?.runnerName || 'Unknown',
          selectionId: r.selectionId,
          bsp: r.sp?.actualSP ?? null,
          status: r.status,
        };
      }).filter(r => r.status !== 'REMOVED');

      let targetRunner = null;
      if (horse) {
        const horseLower = horse.toLowerCase().replace(/[^a-z0-9]/g, '');
        targetRunner = runners.find(r => {
          const n = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return n.includes(horseLower) || horseLower.includes(n);
        }) || null;
      }

      return { marketId: market.marketId, marketName, marketType, kind, placeCount, startTime: market.marketStartTime, targetRunner, allRunners: runners };
    });

    const winMarket = enriched.find(m => m.kind === 'win');
    const allPlaceMarkets = enriched.filter(m => m.kind === 'place');

    let bestPlaceMarket = null;
    if (requestedPlaces) {
      bestPlaceMarket = allPlaceMarkets.find(m => m.placeCount === requestedPlaces)
        || allPlaceMarkets.find(m => m.placeCount === requestedPlaces - 1)
        || allPlaceMarkets[0];
    } else {
      bestPlaceMarket = allPlaceMarkets[0] || null;
    }

    return res.status(200).json({ winMarket, bestPlaceMarket, allPlaceMarkets, allMarkets: enriched });

  } catch (err) {
    console.error('BSP fetch error:', err);
    return res.status(500).json({ error: err.message });
  }
}
