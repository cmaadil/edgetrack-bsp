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

  console.log('Login status:', res.status, '| response:', res.text.slice(0, 200));
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

function extractPlaceCount(market) {
  // Primary: Betfair stores number of places as numberOfWinners in market description
  const fromDesc = market.description?.numberOfWinners;
  if (fromDesc && fromDesc > 1) return fromDesc;
  // Fallback: parse market name for patterns like "5 Places", "4 To Be Placed", "Top 3 Finish"
  const name = market.marketName || '';
  const m = name.match(/(\d+)\s*(?:place|fi|tbp)/i) || name.match(/top\s*(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

function classifyMarket(marketType, marketName) {
  if (marketType === 'WIN') return 'win';
  if (marketType === 'PLACE') return 'place';
  if (marketType === 'OTHER_PLACE') return 'place'; // extra place markets e.g. 4 TBP
  if (marketType === 'EACH_WAY') return 'other';
  if (marketType === 'MATCH_BET' || marketType === 'REV_FORECAST') return 'other';
  // fallback on name
  if (/^win$/i.test(marketName)) return 'win';
  if (/to be placed|tbp/i.test(marketName)) return 'place';
  if (/top\s*\d+\s*fi/i.test(marketName)) return 'place';
  return 'other';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { course, date, time, horse, ewPlaces } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });

  const requestedPlaces = ewPlaces ? parseInt(ewPlaces) : null;

  try {
    const token = await getSessionToken();

    // Normalise date — handle DD/MM/YYYY or YYYY-MM-DD
    let normDate = date;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      const [d, m, y] = date.split('/');
      normDate = `${y}-${m}-${d}`;
    }

    const raceDate = new Date(`${normDate}T${time || '12:00'}:00Z`);
    // Wide window — settled markets may not appear in narrow searches
    const from = new Date(raceDate.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const to   = new Date(raceDate.getTime() + 2 * 60 * 60 * 1000).toISOString();

    console.log('Search:', { normDate, time, from, to, course, horse });

    const markets = await betfairCall(token, 'listMarketCatalogue', {
      filter: {
        eventTypeIds: ['7'],
        marketCountries: ['GB', 'IE'],
        marketStartTime: { from, to },
        // textQuery removed — Betfair venue names don't always match user input
      },
      marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'EVENT'],
      maxResults: 100,
      sort: 'FIRST_TO_START',
    });

    console.log('Markets found:', markets?.length, JSON.stringify(markets?.slice(0,10).map(m => ({ n: m.marketName, t: m.marketStartTime, mt: m.description?.marketType }))));

    if (!markets?.length) return res.status(404).json({ error: 'Market closed' });

    const raceMs = raceDate.getTime();
    // Tighten time window to ±10min when time was provided
    const timeWindowMs = time ? 10 * 60 * 1000 : 20 * 60 * 1000;
    let matchingMarkets = markets.filter(m =>
      Math.abs(new Date(m.marketStartTime).getTime() - raceMs) < timeWindowMs
    );

    // Filter by course if provided — match against event venue or name
    if (course && matchingMarkets.length > 0) {
      const courseLower = course.toLowerCase().replace(/[^a-z]/g, '');
      const courseFiltered = matchingMarkets.filter(m => {
        const venue = (m.event?.venue || m.event?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        return venue.includes(courseLower) || courseLower.includes(venue.slice(0, 4));
      });
      // Only apply course filter if it returns results — avoids over-filtering on venue name mismatches
      if (courseFiltered.length > 0) matchingMarkets = courseFiltered;
    }

    if (!matchingMarkets.length) matchingMarkets = markets.slice(0, 10);

    const books = await betfairCall(token, 'listMarketBook', {
      marketIds: matchingMarkets.map(m => m.marketId),
      priceProjection: { bspPrices: true },
    });

    // Check market statuses - never use live prices in-play or post-race
    const marketStatuses = {};
    books.forEach(b => { marketStatuses[b.marketId] = b.status; });

    // Only fetch live prices for markets that are OPEN and pre-race (not IN_PLAY, SUSPENDED, CLOSED)
    const preRaceMarketIds = matchingMarkets
      .map(m => m.marketId)
      .filter(id => {
        const status = marketStatuses[id];
        const book = books.find(b => b.marketId === id);
        const hasBSP = book?.runners?.some(r => r.sp?.actualSP > 1.01);
        return !hasBSP && (status === 'OPEN') && !books.find(b => b.marketId === id)?.inplay;
      });

    let liveBooks = [];
    if (preRaceMarketIds.length > 0) {
      liveBooks = await betfairCall(token, 'listMarketBook', {
        marketIds: preRaceMarketIds,
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      });
    }

    const enriched = matchingMarkets.map(market => {
      const marketType = market.description?.marketType || '';
      const marketName = market.marketName || '';
      const kind = classifyMarket(marketType, marketName);
      const placeCount = kind === 'place' ? extractPlaceCount(market) : null;

      const book = books.find(b => b.marketId === market.marketId);
      const liveBook = liveBooks.find(b => b.marketId === market.marketId);
      const isPreRace = preRaceMarketIds.includes(market.marketId);

      const runners = (book?.runners || []).map(r => {
        const desc = market.runners?.find(rd => rd.selectionId === r.selectionId);
        const bsp = r.sp?.actualSP > 1.01 ? r.sp.actualSP : null;
        const liveRunner = isPreRace ? liveBook?.runners?.find(lr => lr.selectionId === r.selectionId) : null;
        const bestBack = liveRunner?.ex?.availableToBack?.[0]?.price ?? null;
        const bestLay  = liveRunner?.ex?.availableToLay?.[0]?.price ?? null;
        // Mid-price = (back + lay) / 2 — true fair value with no overround
        const midPrice = bestBack > 1.01 && bestLay > 1.01
          ? parseFloat(((bestBack + bestLay) / 2).toFixed(2))
          : (bestBack > 1.01 ? bestBack : null);
        return {
          name: desc?.runnerName || 'Unknown',
          selectionId: r.selectionId,
          bsp,
          livePrice: !bsp && midPrice ? midPrice : null,
          isLive: !bsp && !!midPrice,
          status: r.status
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

      return { marketId: market.marketId, marketName, marketType, kind, placeCount, numberOfWinners: market.description?.numberOfWinners, startTime: market.marketStartTime, targetRunner, allRunners: runners };
    });

    const winMarket = enriched.find(m => m.kind === 'win');
    const allPlaceMarkets = enriched.filter(m => m.kind === 'place');
    console.log('Place markets found:', JSON.stringify(allPlaceMarkets.map(m => ({
      name: m.marketName,
      type: m.marketType,
      placeCount: m.placeCount,
      numberOfWinners: m.numberOfWinners,
    }))));
    console.log('Requested places:', requestedPlaces);

    let bestPlaceMarket = null;
    if (allPlaceMarkets.length > 0) {
      if (requestedPlaces) {
        // Exact match first
        bestPlaceMarket = allPlaceMarkets.find(m => m.placeCount === requestedPlaces);
        if (!bestPlaceMarket) {
          // Try ±1 tolerance (in case of off-by-one in name parsing)
          bestPlaceMarket = allPlaceMarkets.find(m => m.placeCount && Math.abs(m.placeCount - requestedPlaces) <= 1);
        }
        // Last resort: first place market
        if (!bestPlaceMarket) bestPlaceMarket = allPlaceMarkets[0];
      } else {
        bestPlaceMarket = allPlaceMarkets[0];
      }
    }
    console.log('Chosen place market:', bestPlaceMarket ? { name: bestPlaceMarket.marketName, placeCount: bestPlaceMarket.placeCount } : 'none');

    return res.status(200).json({ winMarket, bestPlaceMarket, allPlaceMarkets, allMarkets: enriched });

  } catch (err) {
    console.error('BSP fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
