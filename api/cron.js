import https from 'https';

const BETFAIR_API  = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY      = process.env.BETFAIR_APP_KEY;
const BF_EMAIL     = process.env.BETFAIR_EMAIL;
const BF_PASS      = process.env.BETFAIR_PASS;
const BF_CERT      = process.env.BETFAIR_CERT;
const BF_KEY       = process.env.BETFAIR_KEY;
const SUPA_URL     = 'https://zlgsgxgpctngewznifbi.supabase.co';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const text = await res.text();
  if (!text || !text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch(e) {
    console.error('betfairCall parse error:', text.slice(0, 200));
    return [];
  }
}

async function supaFetch(path, method, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1${path}`, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_SERVICE,
      'Authorization': 'Bearer ' + SUPA_SERVICE,
      'Prefer': method === 'PATCH' || method === 'POST' ? 'return=minimal' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text || !text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch(e) {
    return [];
  }
}

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

function calcEV(bet, sels) {
  const stake = parseFloat(bet.stake) || 0;
  if (!stake) return null;
  const validSels = sels.filter(s => s.odds_taken > 1 && s.fair_odds > 1);
  if (!validSels.length) return null;
  const takenProduct = validSels.reduce((a, s) => a * parseFloat(s.odds_taken), 1);
  const fairProduct  = validSels.reduce((a, s) => a * parseFloat(s.fair_odds), 1);
  if (!fairProduct) return null;
  return parseFloat((stake * (takenProduct / fairProduct - 1)).toFixed(2));
}

function mapOutcome(status, sortPriority, ewPlaces) {
  if (status === 'WINNER') return 'win';
  if (status === 'PLACED') return 'place';
  if (status === 'LOSER') {
    if (ewPlaces && sortPriority && sortPriority <= ewPlaces) return 'place';
    return 'lose';
  }
  if (status === 'REMOVED') return 'nr';
  return 'pending';
}

function calcReturns(bet, sels) {
  // Simple returns calc for singles — stake * odds if won, 0 if lost
  const stake = parseFloat(bet.stake) || 0;
  const isEW = bet.each_way;
  let returns = 0;
  for (const sel of sels) {
    const odds = parseFloat(sel.odds_taken) || 0;
    const ewFrac = parseFloat(sel.ew_frac) || 0.2;
    const halfStake = isEW ? stake / 2 : stake;
    if (sel.outcome === 'win') {
      returns += halfStake * odds; // win part
      if (isEW) returns += halfStake * (1 + (odds - 1) * ewFrac); // place part
    } else if (sel.outcome === 'place' && isEW) {
      returns += halfStake; // win part stake back
      returns += halfStake * (1 + (odds - 1) * ewFrac); // place part
    } else if (sel.outcome === 'nr' || sel.outcome === 'void') {
      returns += stake; // stake refund
    }
  }
  return parseFloat(returns.toFixed(2));
}

async function getCachedToken() {
  try {
    const res = await supaFetch('/cache?key=eq.betfair_token&select=value,expires_at', 'GET');
    if (Array.isArray(res) && res[0]) {
      const { value, expires_at } = res[0];
      if (new Date(expires_at) > new Date(Date.now() + 5 * 60 * 1000)) {
        return value;
      }
    }
  } catch(e) {}

  const token = await getSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
  try {
    await supaFetch('/cache?key=eq.betfair_token', 'DELETE');
    await supaFetch('/cache', 'POST', { key: 'betfair_token', value: token, expires_at: expiresAt });
  } catch(e) {
    console.error('Cron: failed to cache token:', e.message);
  }
  return token;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const bets = await supaFetch(
      '/bets?result=in.(pending,open)&select=id,sport,each_way,stake,selections',
      'GET'
    );

    if (!Array.isArray(bets) || !bets.length) {
      return res.status(200).json({ message: 'No pending bets', updated: 0 });
    }

    const now = Date.now();
    const PRE_RACE_STOP_MS = 2 * 60 * 1000; // stop fetching live prices 2 mins before off

    // Categorise bets
    const liveRefreshBets  = []; // pre-race, update live mid-price
    const autoSettleBets   = []; // post-race, fetch BSP + settle
    const hrRaceBets       = []; // HR without market_id, use race lookup

    for (const bet of bets) {
      const sels = typeof bet.selections === 'string' ? JSON.parse(bet.selections) : (bet.selections || []);
      const pendingSels = sels.filter(s => !s.outcome || s.outcome === 'pending');
      if (!pendingSels.length) continue;

      const isHR = bet.sport === 'horse_racing' || bet.sport === 'greyhounds';
      const hasMarketId = pendingSels.some(s => s.market_id && s.selection_id);

      if (hasMarketId) {
        // Check race time to decide pre vs post
        const hasFutureRace = pendingSels.some(s => {
          if (!s.race_date || !s.race_time) return true; // no time info, assume pre-race
          const offMs = new Date(`${s.race_date}T${s.race_time}:00Z`).getTime();
          return (offMs - now) > PRE_RACE_STOP_MS; // more than 2 mins away
        });
        const hasPastRace = pendingSels.some(s => {
          if (!s.race_date || !s.race_time) return false;
          const offMs = new Date(`${s.race_date}T${s.race_time}:00Z`).getTime();
          return offMs < now; // race has already started/finished
        });

        if (hasPastRace) autoSettleBets.push({ bet, sels, pendingSels });
        else if (hasFutureRace) liveRefreshBets.push({ bet, sels, pendingSels });
        // within 2 min window: skip — don't fetch inaccurate near-off prices

      } else if (isHR) {
        const raceSels = pendingSels.filter(s => s.race_date && s.race_time && s.name);
        if (raceSels.length) {
          const hasPast = raceSels.some(s => {
            const offMs = new Date(`${s.race_date}T${s.race_time}:00Z`).getTime();
            return offMs < now;
          });
          const hasFuture = raceSels.some(s => {
            const offMs = new Date(`${s.race_date}T${s.race_time}:00Z`).getTime();
            return (offMs - now) > PRE_RACE_STOP_MS;
          });
          if (hasPast) autoSettleBets.push({ bet, sels, activeSels: raceSels, useRaceLookup: true });
          else if (hasFuture) hrRaceBets.push({ bet, sels, activeSels: raceSels });
        }
      } else {
        // Non-HR with market_id but no race time — always refresh
        if (hasMarketId) liveRefreshBets.push({ bet, sels, pendingSels });
      }
    }

    console.log(`Cron: ${liveRefreshBets.length} live refresh, ${autoSettleBets.length} to settle, ${hrRaceBets.length} HR race`);

    if (!liveRefreshBets.length && !autoSettleBets.length && !hrRaceBets.length) {
      return res.status(200).json({ message: 'No bets to process', updated: 0 });
    }

    const token = await getCachedToken();
    let updatedCount = 0;

    // ── 1. Live pre-race refresh (mid-price, >2 mins before off) ──────────────
    if (liveRefreshBets.length) {
      const marketIdMap = new Map();
      for (const { bet, sels } of liveRefreshBets) {
        for (let i = 0; i < sels.length; i++) {
          const sel = sels[i];
          if (!sel.market_id || !sel.selection_id) continue;
          if (sel.outcome && sel.outcome !== 'pending') continue;
          if (!marketIdMap.has(sel.market_id)) marketIdMap.set(sel.market_id, []);
          marketIdMap.get(sel.market_id).push({ bet, sels, sel, selIdx: i });
        }
      }

      const chunks = [];
      const allIds = [...marketIdMap.keys()];
      for (let i = 0; i < allIds.length; i += 200) chunks.push(allIds.slice(i, i + 200));

      for (const chunk of chunks) {
        try {
          const books = await betfairCall(token, 'listMarketBook', {
            marketIds: chunk,
            priceProjection: { priceData: ['EX_BEST_OFFERS'] },
          });
          if (!Array.isArray(books)) continue;
          for (const book of books) {
            if (book.status !== 'OPEN' || book.inplay) continue; // skip in-play
            const entries = marketIdMap.get(book.marketId) || [];
            for (const { sels, sel, selIdx } of entries) {
              const runner = (book.runners || []).find(r => r.selectionId === sel.selection_id);
              if (!runner) continue;
              const price = getMidPrice(runner);
              if (!price) continue;
              sels[selIdx].fair_odds = price;
            }
          }
        } catch(e) {
          console.error('Cron live refresh error:', e.message);
        }
      }

      const updatedIds = new Set();
      for (const { bet, sels } of liveRefreshBets) {
        if (!updatedIds.has(bet.id)) {
          updatedIds.add(bet.id);
          const evOdds = calcEV(bet, sels);
          const patch = { selections: JSON.stringify(sels) };
          if (evOdds != null) patch.ev_odds = evOdds;
          await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', patch);
          updatedCount++;
        }
      }
    }

    // ── 2. Auto-settle post-race bets (fetch real BSP) ────────────────────────
    if (autoSettleBets.length) {
      // Collect all market IDs needing BSP
      const settleMarketMap = new Map();
      for (const entry of autoSettleBets) {
        const { bet, sels, pendingSels, useRaceLookup } = entry;
        if (useRaceLookup) continue; // handle separately below
        for (let i = 0; i < sels.length; i++) {
          const sel = sels[i];
          if (!sel.market_id || !sel.selection_id) continue;
          if (sel.outcome && sel.outcome !== 'pending') continue;
          if (!settleMarketMap.has(sel.market_id)) settleMarketMap.set(sel.market_id, []);
          settleMarketMap.get(sel.market_id).push({ bet, sels, sel, selIdx: i });
        }
      }

      if (settleMarketMap.size) {
        const chunks = [];
        const allIds = [...settleMarketMap.keys()];
        for (let i = 0; i < allIds.length; i += 200) chunks.push(allIds.slice(i, i + 200));

        for (const chunk of chunks) {
          try {
            const books = await betfairCall(token, 'listMarketBook', {
              marketIds: chunk,
              priceProjection: { priceData: ['SP_TRADED'], bspPrices: true },
            });
            if (!Array.isArray(books)) continue;

            for (const book of books) {
              if (book.status !== 'CLOSED') continue; // only settle closed markets
              const entries = settleMarketMap.get(book.marketId) || [];
              for (const { sels, sel, selIdx } of entries) {
                const runner = book.runners?.find(r => r.selectionId === sel.selection_id);
                if (!runner) continue;

                // Get actual BSP
                const bsp = runner.sp?.actualSP;
                if (bsp) {
                  sels[selIdx].fair_odds = parseFloat(bsp.toFixed(2));
                  console.log(`Cron settle: ${sel.name} BSP=${bsp} status=${runner.status}`);
                }

                // Determine outcome
                const ewPlaces = parseInt(sel.ew_places) || null;
                const sortPriority = runner.adjustedRating || null;
                const outcome = mapOutcome(runner.status, sortPriority, ewPlaces);
                if (outcome !== 'pending') sels[selIdx].outcome = outcome;
              }
            }
          } catch(e) {
            console.error('Cron settle error:', e.message);
          }
        }

        // Save settled bets
        const settledIds = new Set();
        for (const { bet, sels } of autoSettleBets.filter(e => !e.useRaceLookup)) {
          if (settledIds.has(bet.id)) continue;
          settledIds.add(bet.id);

          // Determine top-level result
          const outcomes = sels.map(s => s.outcome || 'pending');
          let result = 'open';
          if (outcomes.every(o => o === 'pending')) result = 'pending';
          else if (outcomes.every(o => o === 'nr' || o === 'void')) result = 'void';
          else if (outcomes.every(o => o === 'win' || o === 'nr' || o === 'void')) result = 'won';
          else if (outcomes.every(o => o === 'lose' || o === 'nr' || o === 'void')) result = 'lost';
          else if (outcomes.some(o => o === 'pending')) result = 'open';
          else result = 'partial';

          const returns = (result === 'won' || result === 'partial') ? calcReturns(bet, sels) : 0;
          const evOdds = calcEV(bet, sels);
          const patch = {
            selections: JSON.stringify(sels),
            result,
            returns,
          };
          if (evOdds != null) patch.ev_odds = evOdds;
          await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', patch);
          console.log(`Cron: settled bet ${bet.id} → ${result}, returns=${returns}`);
          updatedCount++;
        }
      }
    }

    // ── 3. HR race-based lookup (older bets without market_id) ────────────────
    if (hrRaceBets.length) {
      const raceCache = new Map();

      const fetchRaceMarkets = async (sel) => {
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
        if (!Array.isArray(markets) || !markets.length) { raceCache.set(key, null); return null; }
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
          const book = Array.isArray(books) ? books.find(b => b.marketId === market.marketId) : null;
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
      };

      for (const { bet, sels, activeSels } of hrRaceBets) {
        let changed = false;
        for (const sel of activeSels) {
          try {
            const markets = await fetchRaceMarkets(sel);
            if (!markets) continue;
            const hl = sel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            const findRunner = runners => runners?.find(r => {
              const n = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              return n.includes(hl) || hl.includes(n);
            });
            const winRunner = findRunner(markets.winMarket?.runners);
            if (winRunner?.midPrice) { sel.fair_odds = winRunner.midPrice; changed = true; }
            if (sel.ew_places || bet.each_way) {
              const ewPlaces = parseInt(sel.ew_places) || (bet.each_way ? 3 : null);
              let pm = null;
              if (ewPlaces) pm = markets.placeMarkets.find(p => p.placeCount === ewPlaces);
              if (!pm) pm = markets.placeMarkets.find(p => p.marketType === 'PLACE');
              if (!pm) pm = markets.placeMarkets.slice().sort((a, b) => (a.placeCount || 99) - (b.placeCount || 99))[0];
              const placeRunner = findRunner(pm?.runners);
              if (placeRunner?.midPrice) { sel.place_bsp = placeRunner.midPrice; changed = true; }
            }
          } catch(e) {
            console.error(`Cron HR error for ${sel.name}:`, e.message);
          }
        }
        if (changed) {
          const evOdds = calcEV(bet, sels);
          const patch = { selections: JSON.stringify(sels) };
          if (evOdds != null) patch.ev_odds = evOdds;
          await supaFetch(`/bets?id=eq.${bet.id}`, 'PATCH', patch);
          updatedCount++;
        }
      }
    }

    return res.status(200).json({ message: 'Done', updated: updatedCount, checked: bets.length });

  } catch (err) {
    console.error('Cron error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
