import https from 'https';

const BETFAIR_API  = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY      = process.env.BETFAIR_APP_KEY;
const BF_EMAIL     = process.env.BETFAIR_EMAIL;
const BF_PASS      = process.env.BETFAIR_PASS;
const BF_CERT      = process.env.BETFAIR_CERT;
const BF_KEY       = process.env.BETFAIR_KEY;
const SUPA_URL     = 'https://zlgsgxgpctngewznifbi.supabase.co';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role — bypasses RLS

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
  const back = runner?.ex?.availableToBack?.[0]?.price;
  const lay  = runner?.ex?.availableToLay?.[0]?.price;
  if (back > 1.01 && lay > 1.01) return parseFloat(((back + lay) / 2).toFixed(2));
  if (back > 1.01) return back;
  return null;
}

function extractPlaceCount(market) {
  const fromDesc = market.description?.numberOfWinners;
  if (fromDesc && fromDesc > 1) return fromDesc;
  const name = market.marketName || '';
  const m = name.match(/(\d+)\s*(?:place|fi|tbp)/i) || name.match(/top\s*(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Vercel calls this via cron — also allow manual GET for testing
  if (req.method !== 'GET') return res.status(405).end();

  const now = Date.now();
  const WINDOW_MS = 3 * 60 * 1000; // 3 minutes ahead

  try {
    // 1. Fetch all pending horse racing bets from Supabase
    const bets = await supaFetch(
      `/bets?sport=eq.horse_racing&result=in.(pending,open)&select=id,selections,each_way`,
      'GET'
    );

    if (!Array.isArray(bets) || !bets.length) {
      console.log('Cron: no pending HR bets');
      return res.status(200).json({ message: 'No pending HR bets', updated: 0 });
    }

    // 2. Find bets with a race going off in the next WINDOW_MS
    // Each bet has selections JSON array with race_date + race_time per selection
    const toUpdate = [];

    for (const bet of bets) {
      const sels = typeof bet.selections === 'string' ? JSON.parse(bet.selections) : (bet.selections || []);
      const activeSels = sels.filter(s => {
        if (!s.race_date || !s.race_time || !s.name) return false;
        if (s.outcome && s.outcome !== 'pending') return false; // already settled
        const raceMs = new Date(`${s.race_date}T${s.race_time}:00Z`).getTime();
        const msUntilOff = raceMs - now;
        // Window: from now up to 3 mins ahead — don't fire if race already started (negative)
        return msUntilOff >= 0 && msUntilOff <= WINDOW_MS;
      });
      if (activeSels.length > 0) toUpdate.push({ bet, sels, activeSels });
    }

    if (!toUpdate.length) {
      console.log('Cron: no races in window');
      return res.status(200).json({ message: 'No races in window', updated: 0 });
    }

    console.log(`Cron: ${toUpdate.length} bets with races in window`);

    // 3. Get Betfair session once
    const token = await getSessionToken();

    // 4. Collect unique race keys to avoid duplicate API calls
    // Key: race_date|race_time|course
    const raceCache = new Map();

    async function fetchRaceMarkets(sel) {
      const key = `${sel.race_date}|${sel.race_time}|${sel.course || ''}`;
      if (raceCache.has(key)) return raceCache.get(key);

      const raceDate = new Date(`${sel.race_date}T${sel.race_time}:00Z`);
      const from = new Date(raceDate.getTime() - 10 * 60 * 1000).toISOString();
      const to   = new Date(raceDate.getTime() + 10 * 60 * 1000).toISOString();

      const markets = await betfairCall(token, 'listMarketCatalogue', {
        filter: {
          eventTypeIds: ['7'],
          marketCountries: ['GB', 'IE'],
          marketStartTime: { from, to },
        },
        marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'EVENT'],
        maxResults: 50,
        sort: 'FIRST_TO_START',
      });

      if (!markets?.length) { raceCache.set(key, null); return null; }

      // Filter by course if available
      let matching = markets;
      if (sel.course) {
        const cl = sel.course.toLowerCase().replace(/[^a-z]/g, '');
        const filtered = markets.filter(m => {
          const venue = (m.event?.venue || m.event?.name || '').toLowerCase().replace(/[^a-z]/g, '');
          return venue.includes(cl) || cl.includes(venue.slice(0, 4));
        });
        if (filtered.length) matching = filtered;
      }

      // Fetch live prices — only OPEN pre-race markets
      const marketIds = matching.map(m => m.marketId);
      const books = await betfairCall(token, 'listMarketBook', {
        marketIds,
        priceProjection: { priceData: ['EX_BEST_OFFERS'] },
      });

      // Guard: skip inplay or closed markets
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
          return {
            name: desc?.runnerName || 'Unknown',
            selectionId: r.selectionId,
            midPrice: getMidPrice(r),
            status: r.status,
          };
        }).filter(r => r.status !== 'REMOVED');

        if (isWin && !result.winMarket) {
          result.winMarket = { marketId: market.marketId, runners };
        } else if (isPlace) {
          result.placeMarkets.push({
            marketId: market.marketId,
            placeCount: extractPlaceCount(market),
            runners,
          });
        }
      }

      raceCache.set(key, result);
      return result;
    }

    // 5. Process each bet
    let updatedCount = 0;

    for (const { bet, sels, activeSels } of toUpdate) {
      let changed = false;

      for (const sel of activeSels) {
        try {
          const markets = await fetchRaceMarkets(sel);
          if (!markets) continue;

          const horseLower = sel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const findRunner = (runners) => runners?.find(r => {
            const n = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return n.includes(horseLower) || horseLower.includes(n);
          });

          // Win mid-price → fair_odds
          const winRunner = findRunner(markets.winMarket?.runners);
          if (winRunner?.midPrice) {
            sel.fair_odds = winRunner.midPrice;
            sel.bsp_fetched = false; // mark as live price, not BSP
            changed = true;
          }

          // Place mid-price → place_bsp
          if (sel.ew_places || bet.each_way) {
            const ewPlaces = parseInt(sel.ew_places) || 3;
            const placeMarket = markets.placeMarkets.find(p => p.placeCount === ewPlaces)
              || markets.placeMarkets[0];
            const placeRunner = findRunner(placeMarket?.runners);
            if (placeRunner?.midPrice) {
              sel.place_bsp = placeRunner.midPrice;
              changed = true;
            }
          }
        } catch (e) {
          console.error(`Cron: error for sel ${sel.name}:`, e.message);
        }
      }

      if (changed) {
        // Recompute ev_odds inline (simple single/perm EV)
        // Write updated selections + ev_odds back to Supabase
        await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', {
          selections: JSON.stringify(sels),
        });
        updatedCount++;
        console.log(`Cron: updated bet ${bet.id}`);
      }
    }

    return res.status(200).json({ message: 'Done', updated: updatedCount, checked: bets.length });

  } catch (err) {
    console.error('Cron error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
