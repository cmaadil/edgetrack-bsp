import https from 'https';

const BETFAIR_API  = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY      = process.env.BETFAIR_APP_KEY;
const BF_EMAIL     = process.env.BETFAIR_EMAIL;
const BF_PASS      = process.env.BETFAIR_PASS;
const BF_CERT      = process.env.BETFAIR_CERT;
const BF_KEY       = process.env.BETFAIR_KEY;
const SUPA_URL     = 'https://zlgsgxgpctngewznifbi.supabase.co';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Betfair helpers ──────────────────────────────────────────────────────────

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

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function supaFetch(path, method, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1${path}`, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_SERVICE,
      'Authorization': 'Bearer ' + SUPA_SERVICE,
      'Prefer': method === 'PATCH' ? 'return=minimal' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Mid-price helper ─────────────────────────────────────────────────────────

function getMidPrice(runner) {
  const backLevels = runner?.ex?.availableToBack || [];
  const layLevels  = runner?.ex?.availableToLay  || [];
  const bestLay = layLevels[0]?.price;
  let bestBack = null;
  for (const level of backLevels) {
    if (level.price > 1.01) {
      if (bestLay && level.price > bestLay * 3) continue;
      bestBack = level.price;
      break;
    }
  }
  if (bestBack && bestLay && bestBack < bestLay) return parseFloat(((bestBack + bestLay) / 2).toFixed(2));
  if (bestBack) return bestBack;
  if (bestLay) return bestLay;
  return null;
}

function extractPlaceCount(market) {
  const name = market.marketName || '';
  const topN = name.match(/top\s*(\d+)/i);
  if (topN) return parseInt(topN[1]);
  const leadingN = name.match(/^(\d+)\s*/);
  if (leadingN) return parseInt(leadingN[1]);
  return null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 1. Fetch all pending bets from Supabase (all sports)
    const betsRes = await fetch(
      `${SUPA_URL}/rest/v1/bets?result=in.(pending,open)&select=id,sport,each_way,selections`,
      {
        headers: {
          'apikey': SUPA_SERVICE,
          'Authorization': 'Bearer ' + SUPA_SERVICE,
          'Content-Type': 'application/json',
        }
      }
    );
    const betsText = await betsRes.text();
    if (!betsText || !betsText.trim()) {
      return res.status(200).json({ message: 'No pending bets', updated: 0 });
    }
    const bets = JSON.parse(betsText);

    if (!Array.isArray(bets) || !bets.length) {
      return res.status(200).json({ message: 'No pending bets', updated: 0 });
    }

    // 2. Split into HR bets (use race-based lookup) and non-HR bets (use stored market_id)
    const hrBets = [];
    const marketIdBets = []; // any sport with a stored market_id in selections

    for (const bet of bets) {
      const sels = typeof bet.selections === 'string' ? JSON.parse(bet.selections) : (bet.selections || []);
      const pendingSels = sels.filter(s => !s.outcome || s.outcome === 'pending');
      if (!pendingSels.length) continue;

      const isHR = bet.sport === 'horse_racing' || bet.sport === 'greyhounds';
      const hasMarketId = pendingSels.some(s => s.market_id && s.selection_id);

      if (hasMarketId) {
        // Prefer market_id based refresh for all sports including HR
        marketIdBets.push({ bet, sels, pendingSels });
      } else if (isHR) {
        // Fallback to race-based for HR bets without market_id
        const raceSels = pendingSels.filter(s => s.race_date && s.race_time && s.name);
        if (raceSels.length) hrBets.push({ bet, sels, activeSels: raceSels });
      }
    }

    console.log(`Cron: ${marketIdBets.length} market-ID bets, ${hrBets.length} HR race bets`);

    // Get Betfair session once (only if needed)
    let token = null;
    const needsToken = hrBets.length > 0 || marketIdBets.length > 0;
    if (needsToken) token = await getSessionToken();

    let updatedCount = 0;

    // 3. Refresh non-HR / market-ID bets using listMarketBook directly
    if (marketIdBets.length && token) {
      // Collect all unique market IDs
      const marketIdMap = new Map(); // marketId -> [{ bet, sel, selIdx }]
      for (const { bet, sels, pendingSels } of marketIdBets) {
        for (let i = 0; i < sels.length; i++) {
          const sel = sels[i];
          if (!sel.market_id || !sel.selection_id) continue;
          if (sel.outcome && sel.outcome !== 'pending') continue;
          if (!marketIdMap.has(sel.market_id)) marketIdMap.set(sel.market_id, []);
          marketIdMap.get(sel.market_id).push({ bet, sels, sel, selIdx: i });
        }
      }

      // Batch fetch all market books at once (up to 200 market IDs per call)
      const allMarketIds = [...marketIdMap.keys()];
      const chunks = [];
      for (let i = 0; i < allMarketIds.length; i += 200) chunks.push(allMarketIds.slice(i, i + 200));

      for (const chunk of chunks) {
        try {
          const books = await betfairCall(token, 'listMarketBook', {
            marketIds: chunk,
            priceProjection: { priceData: ['EX_BEST_OFFERS'] },
          });

          for (const book of (books || [])) {
            const entries = marketIdMap.get(book.marketId) || [];
            const isUsable = book.status === 'OPEN'; // include inplay for non-HR sports

            for (const { bet, sels, sel, selIdx } of entries) {
              const runner = (book.runners || []).find(r => r.selectionId === sel.selection_id);
              if (!runner) continue;
              const price = getMidPrice(runner);
              if (!price) continue;

              sels[selIdx].fair_odds = price;
              console.log(`Cron: ${bet.sport} bet ${bet.id} sel ${sel.name} → ${price}`);
            }
          }
        } catch(e) {
          console.error('Cron: market book fetch error:', e.message);
        }
      }

      // Save updated bets
      const updatedBetIds = new Set();
      for (const { bet, sels, pendingSels } of marketIdBets) {
        const anyChanged = pendingSels.some((s, i) => {
          const orig = (typeof bet.selections === 'string' ? JSON.parse(bet.selections) : bet.selections)[i];
          return orig?.fair_odds !== s.fair_odds;
        });
        // Always save if any market-ID sel was processed
        const hasMktId = sels.some(s => s.market_id && s.selection_id && (!s.outcome || s.outcome === 'pending'));
        if (hasMktId && !updatedBetIds.has(bet.id)) {
          updatedBetIds.add(bet.id);
          await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', { selections: JSON.stringify(sels) });
          updatedCount++;
        }
      }
    }

    // 4. Refresh HR bets via race-based lookup (for older bets without market_id)
    const raceCache = new Map();

    async function fetchRaceMarkets(sel) {
      const key = `${sel.race_date}|${sel.race_time}|${sel.course || ''}`;
      if (raceCache.has(key)) return raceCache.get(key);

      const raceDate = new Date(`${sel.race_date}T${sel.race_time}:00Z`);
      const from = new Date(raceDate.getTime() - 10 * 60 * 1000).toISOString();
      const to   = new Date(raceDate.getTime() + 10 * 60 * 1000).toISOString();

      const markets = await betfairCall(token, 'listMarketCatalogue', {
        filter: { eventTypeIds: ['7'], marketCountries: ['GB', 'IE'], marketStartTime: { from, to } },
        marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'EVENT'],
        maxResults: 50,
        sort: 'FIRST_TO_START',
      });

      if (!markets?.length) { raceCache.set(key, null); return null; }

      let matching = markets;
      if (sel.course) {
        const cl = sel.course.toLowerCase().replace(/[^a-z]/g, '');
        const filtered = markets.filter(m => {
          const venue = (m.event?.venue || m.event?.name || '').toLowerCase().replace(/[^a-z]/g, '');
          return venue.includes(cl) || cl.includes(venue.slice(0, 4));
        });
        if (filtered.length) matching = filtered;
      }

      const books = await betfairCall(token, 'listMarketBook', {
        marketIds: matching.map(m => m.marketId),
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      });

      const result = { winMarket: null, placeMarkets: [] };
      for (const market of matching) {
        const book = books.find(b => b.marketId === market.marketId);
        if (!book || book.status !== 'OPEN' || book.inplay) continue;
        const mt = market.description?.marketType || '';
        const mn = market.marketName || '';
        const isWin   = mt === 'WIN' || /^win$/i.test(mn);
        const isPlace = mt === 'PLACE' || mt === 'OTHER_PLACE' || /to be placed|tbp/i.test(mn);
        const runners = (book.runners || []).map(r => {
          const desc = market.runners?.find(rd => rd.selectionId === r.selectionId);
          return { name: desc?.runnerName || 'Unknown', selectionId: r.selectionId, midPrice: getMidPrice(r), status: r.status };
        }).filter(r => r.status !== 'REMOVED');
        if (isWin && !result.winMarket) result.winMarket = { marketId: market.marketId, runners };
        else if (isPlace) result.placeMarkets.push({ marketId: market.marketId, marketType: mt, placeCount: extractPlaceCount(market), runners });
      }

      raceCache.set(key, result);
      return result;
    }

    for (const { bet, sels, activeSels } of hrBets) {
      let changed = false;
      for (const sel of activeSels) {
        try {
          const markets = await fetchRaceMarkets(sel);
          if (!markets) continue;
          const horseLower = sel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const findRunner = runners => runners?.find(r => {
            const n = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return n.includes(horseLower) || horseLower.includes(n);
          });
          const winRunner = findRunner(markets.winMarket?.runners);
          if (winRunner?.midPrice) { sel.fair_odds = winRunner.midPrice; changed = true; }
          if (sel.ew_places || bet.each_way) {
            const ewPlaces = parseInt(sel.ew_places) || (bet.each_way ? 3 : null);
            let placeMarket = null;
            if (ewPlaces) placeMarket = markets.placeMarkets.find(p => p.placeCount === ewPlaces);
            if (!placeMarket) placeMarket = markets.placeMarkets.find(p => p.marketType === 'PLACE');
            if (!placeMarket) placeMarket = markets.placeMarkets.slice().sort((a,b) => (a.placeCount||99)-(b.placeCount||99))[0];
            const placeRunner = findRunner(placeMarket?.runners);
            if (placeRunner?.midPrice) { sel.place_bsp = placeRunner.midPrice; changed = true; }
          }
        } catch(e) { console.error(`Cron HR: error for ${sel.name}:`, e.message); }
      }
      if (changed) {
        await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', { selections: JSON.stringify(sels) });
        updatedCount++;
      }
    }

    return res.status(200).json({ message: 'Done', updated: updatedCount, checked: bets.length });

  } catch (err) {
    console.error('Cron error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
