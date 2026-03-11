// api/bsp.js — Vercel serverless function (cert-based login)

import https from 'https';

const BETFAIR_API = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY     = process.env.BETFAIR_APP_KEY;
const BF_EMAIL    = process.env.BETFAIR_EMAIL;
const BF_PASS     = process.env.BETFAIR_PASS;
const BF_CERT     = process.env.BETFAIR_CERT;
const BF_KEY      = process.env.BETFAIR_KEY;

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      cert: options.cert,
      key: options.key,
      rejectUnauthorized: false,
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getSessionToken() {
  const cert = Buffer.from(BF_CERT, 'base64').toString('utf8');
  const key  = Buffer.from(BF_KEY,  'base64').toString('utf8');
  const body = new URLSearchParams({ username: BF_EMAIL, password: BF_PASS }).toString();

  const res = await httpsRequest('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Application': APP_KEY,
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    cert,
    key,
  }, body);

  console.log('Betfair cert login status:', res.status);
  console.log('Betfair cert login response:', res.text.slice(0, 300));

  let data;
  try { data = JSON.parse(res.text); } catch(e) { throw new Error('Login parse failed: ' + res.text.slice(0, 200)); }
  if (data.loginStatus !== 'SUCCESS') throw new Error('Betfair login failed: ' + (data.loginStatus || JSON.stringify(data)));
  return data.sessionToken;
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
  const m = marketName.match(/(\d+)\s*(?:place|fi)/i);
  return m ? parseInt(m[1]) : null;
}

function classifyMarket(marketType, marketName) {
  if (marketType === 'WIN' || /^win$/i.test(marketName)) return 'win';
  if (marketType === 'PLACE') return 'place';
  if (/top\s*\d+\s*fi/i.test(marketName)) return 'place';
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

    if (!markets?.length) return res.status(404).json({ error: 'No markets found for this race' });

    const raceMs = raceDate.getTime();
    let matchingMarkets = markets.filter(m =>
      Math.abs(new Date(m.marketStartTime).getTime() - raceMs) < 10 * 60 * 1000
    );
    if (!matchingMarkets.length) matchingMarkets = markets.slice(0, 10);

    const books = await betfairCall(token, 'listMarketBook', {
      marketIds: matchingMarkets.map(m => m.marketId),
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
        return { name: desc?.runnerName || 'Unknown', selectionId: r.selectionId, bsp: r.sp?.actualSP ?? null, status: r.status };
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
    const bestPlaceMarket = requestedPlaces
      ? (allPlaceMarkets.find(m => m.placeCount === requestedPlaces) || allPlaceMarkets.find(m => m.placeCount === requestedPlaces - 1) || allPlaceMarkets[0])
      : allPlaceMarkets[0] || null;

    return res.status(200).json({ winMarket, bestPlaceMarket, allPlaceMarkets, allMarkets: enriched });

  } catch (err) {
    console.error('BSP fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
