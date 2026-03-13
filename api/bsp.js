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
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      cert: options.cert,
      key: options.key,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
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
  const res  = await httpsRequest('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Application': APP_KEY,
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    cert, key,
  }, body);
  const data = JSON.parse(res.text);
  if (data.loginStatus !== 'SUCCESS') throw new Error('Betfair login failed: ' + data.loginStatus);
  return data.sessionToken;
}

async function betfairCall(token, method, params) {
  const res = await fetch(`${BETFAIR_API}/${method}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Application': APP_KEY,
      'X-Authentication': token,
    },
    body: JSON.stringify(params),
  });
  return res.json();
}

function getMidPrice(runner) {
  const back = runner?.ex?.availableToBack?.[0]?.price;
  const lay  = runner?.ex?.availableToLay?.[0]?.price;
  if (back > 1.01 && lay > 1.01) return parseFloat(((back + lay) / 2).toFixed(2));
  if (back > 1.01) return back;
  return null;
}

function extractPlaceCount(market) {
  const name = market.marketName || '';
  // "Top 3 Finish", "Top 4 Fin"
  const topN = name.match(/top\s*(\d+)/i);
  if (topN) return parseInt(topN[1]);
  // "4 TBP", "2 TBP", "3 To Be Placed", "4 To Be Placed", "3 Places" — leading number
  const leadingN = name.match(/^(\d+)\s*/);
  if (leadingN) return parseInt(leadingN[1]);
  return null;
}

function classifyMarket(marketType, marketName) {
  if (marketType === 'WIN') return 'win';
  if (marketType === 'PLACE' || marketType === 'OTHER_PLACE') return 'place';
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

    let normDate = date;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      const [d, m, y] = date.split('/');
      normDate = `${y}-${m}-${d}`;
    }

    const raceDate = new Date(`${normDate}T${time || '12:00'}:00Z`);
    const timeWindowMs = time ? 10 * 60 * 1000 : 20 * 60 * 1000;
    const from = new Date(raceDate.getTime() - timeWindowMs).toISOString();
    const to   = new Date(raceDate.getTime() + timeWindowMs).toISOString();

    const markets = await betfairCall(token, 'listMarketCatalogue', {
      filter: { eventTypeIds: ['7'], marketCountries: ['GB', 'IE'], marketStartTime: { from, to } },
      marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'EVENT'],
      maxResults: 100,
      sort: 'FIRST_TO_START',
    });

    if (!markets?.length) return res.status(404).json({ error: 'No markets found' });

    let matchingMarkets = markets;
    if (course) {
      const cl = course.toLowerCase().replace(/[^a-z]/g, '');
      const filtered = markets.filter(m => {
        const venue = (m.event?.venue || m.event?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        return venue.includes(cl) || cl.includes(venue.slice(0, 4));
      });
      if (filtered.length) matchingMarkets = filtered;
    }

    const books = await betfairCall(token, 'listMarketBook', {
      marketIds: matchingMarkets.map(m => m.marketId),
      priceProjection: { priceData: ['EX_BEST_OFFERS'] },
    });

    const enriched = matchingMarkets.map(market => {
      const book = books.find(b => b.marketId === market.marketId);
      const marketType = market.description?.marketType || '';
      const marketName = market.marketName || '';
      const kind = classifyMarket(marketType, marketName);
      const placeCount = kind === 'place' ? extractPlaceCount(market) : null;
      const isUsable = book?.status === 'OPEN' && !book?.inplay;

      const runners = isUsable ? (book?.runners || []).map(r => {
        const desc = market.runners?.find(rd => rd.selectionId === r.selectionId);
        const midPrice = getMidPrice(r);
        return { name: desc?.runnerName || 'Unknown', selectionId: r.selectionId, midPrice, isLive: !!midPrice, status: r.status };
      }).filter(r => r.status !== 'REMOVED') : [];

      let targetRunner = null;
      if (horse && runners.length) {
        const hl = horse.toLowerCase().replace(/[^a-z0-9]/g, '');
        targetRunner = runners.find(r => {
          const n = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return n.includes(hl) || hl.includes(n);
        }) || null;
      }

      return { marketId: market.marketId, marketName, marketType, kind, placeCount, numberOfWinners: market.description?.numberOfWinners, startTime: market.marketStartTime, isUsable, targetRunner, allRunners: runners };
    });

    const winMarket = enriched.find(m => m.kind === 'win' && m.isUsable);
    const allPlaceMarkets = enriched.filter(m => m.kind === 'place' && m.isUsable);

    // Log everything so we can debug mismatches
    console.log('All place markets:', JSON.stringify(allPlaceMarkets.map(m => ({
      name: m.marketName,
      type: m.marketType,
      placeCount: m.placeCount,
      numberOfWinners: m.numberOfWinners,
      isUsable: m.isUsable,
    }))));
    console.log('Requested places:', requestedPlaces);

    let bestPlaceMarket = null;
    if (allPlaceMarkets.length) {
      if (requestedPlaces) {
        // Exact match on placeCount
        bestPlaceMarket = allPlaceMarkets.find(m => m.placeCount === requestedPlaces);
        if (!bestPlaceMarket) {
          console.log('Exact match failed — place counts found:', allPlaceMarkets.map(m => ({ name: m.marketName, placeCount: m.placeCount, type: m.marketType })));
          // Prefer the standard PLACE market (marketType=PLACE, "To Be Placed") over OTHER_PLACE extras
          bestPlaceMarket = allPlaceMarkets.find(m => m.marketType === 'PLACE')
            || allPlaceMarkets.slice().sort((a, b) => (a.placeCount || 99) - (b.placeCount || 99))[0];
          console.log('Fallback to:', bestPlaceMarket?.marketName, bestPlaceMarket?.marketType);
        } else {
          console.log('Exact match found:', bestPlaceMarket.marketName, 'placeCount:', bestPlaceMarket.placeCount);
        }
      } else {
        // No places specified — prefer standard PLACE market
        bestPlaceMarket = allPlaceMarkets.find(m => m.marketType === 'PLACE')
          || allPlaceMarkets.slice().sort((a, b) => (a.placeCount || 99) - (b.placeCount || 99))[0];
      }
    }

    if (!winMarket && !bestPlaceMarket) {
      return res.status(404).json({ error: 'Market not available — may be inplay or closed' });
    }

    return res.status(200).json({
      winMarket,
      bestPlaceMarket,
      allPlaceMarkets,
      allMarkets: enriched,
      debug: {
        requestedPlaces,
        foundPlaceCounts: allPlaceMarkets.map(m => ({ name: m.marketName, placeCount: m.placeCount, numberOfWinners: m.numberOfWinners })),
        chosenPlaceCount: bestPlaceMarket?.placeCount ?? null,
      }
    });

    #hi

  } catch (err) {
    console.error('BSP fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
