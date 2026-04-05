// api/markets.js — multi-step market picker for any Betfair sport
// Steps: competitions → events → markets (grouped) → runners + live mid-price

import https from 'https';

const BETFAIR_API = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const APP_KEY     = process.env.BETFAIR_APP_KEY;
const BF_EMAIL    = process.env.BETFAIR_EMAIL;
const BF_PASS     = process.env.BETFAIR_PASS;
const BF_CERT     = process.env.BETFAIR_CERT;
const BF_KEY      = process.env.BETFAIR_KEY;

const EVENT_TYPE_IDS = {
  horse_racing: '7',
  greyhounds:   '4339',
  football:     '1',
  tennis:       '2',
  cricket:      '4',
  golf:         '3',
  darts:        '3503',
  snooker:      '6422',
  boxing:       '6',
  mma:          '7524',
  basketball:   '7522',
  american_football: '6423',
  cycling:      '11',
};

const LIQUID_SPORTS = new Set(['horse_racing', 'greyhounds', 'football', 'tennis', 'golf', 'cricket']);

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
  if (data.loginStatus !== 'SUCCESS') throw new Error('Login failed: ' + data.loginStatus);
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

function getMarketGroup(marketType, marketName) {
  const t = (marketType || '').toUpperCase();
  const n = (marketName || '').toLowerCase();
  if (t === 'MATCH_ODDS' || t === 'WIN' || t === 'MONEYLINE' || n.includes('match winner') || n.includes('match bet')) return 'Match Betting';
  if (t.includes('PLACE') || t === 'OTHER_PLACE') return 'Each Way / Place';
  if (n.includes('180') || n.includes('checkout') || n.includes('leg')) return 'Darts Specials';
  if (n.includes('frame') || n.includes('century') || n.includes('snooker break')) return 'Snooker Specials';
  if (n.includes('shot') || n.includes('birdie') || n.includes('hole in one')) return 'Golf Specials';
  if (n.includes('corner')) return 'Corners';
  if (n.includes('card') || n.includes('booking')) return 'Cards';
  if (t.includes('GOAL') || n.includes('goal') || n.includes('score')) return 'Goals';
  if (n.includes('next goal')) return 'Next Goal';
  if (n.includes('both teams') || n.includes('btts')) return 'Both Teams';
  if (n.includes('handicap') || t.includes('HANDICAP') || t.includes('AH')) return 'Handicap';
  if (n.includes('over') || n.includes('under') || n.includes('o/u') || t.includes('OVER_UNDER')) return 'Over / Under';
  if (n.includes('half') || n.includes('1st') || n.includes('2nd') || n.includes('period')) return 'Half / Period';
  if (n.includes('set') || n.includes('game') || n.includes('break')) return 'Sets / Games';
  if (t === 'OUTRIGHT_WINNER' || n.includes('outright') || n.includes('tournament winner')) return 'Outright';
  return 'Other';
}

const GROUP_ORDER = ['Match Betting', 'Each Way / Place', 'Over / Under', 'Handicap', 'Goals', 'Next Goal', 'Both Teams', 'Half / Period', 'Corners', 'Cards', 'Sets / Games', 'Darts Specials', 'Snooker Specials', 'Golf Specials', 'Outright', 'Other'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { step, sport, competitionId, eventId, marketId } = req.query;
  const eventTypeId = EVENT_TYPE_IDS[sport];

  if (!step) return res.status(400).json({ error: 'step required' });
  if (!eventTypeId && step !== 'runners') return res.status(400).json({ error: 'unknown sport' });

  const isLiquid = LIQUID_SPORTS.has(sport);
  const now  = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const to   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const token = await getSessionToken();

    // ── STEP 1: competitions ────────────────────────────────────────────────
    if (step === 'competitions') {
      const comps = await betfairCall(token, 'listCompetitions', {
        filter: { eventTypeIds: [eventTypeId], marketStartTime: { from, to } },
        maxResults: 100,
      });
      const competitions = (comps || [])
        .filter(c => c.competition?.id && c.competition?.name)
        .sort((a, b) => (b.marketCount || 0) - (a.marketCount || 0))
        .map(c => ({ id: c.competition.id, name: c.competition.name, marketCount: c.marketCount }));
      return res.status(200).json({ competitions, liquidityWarning: !isLiquid });
    }

    // ── STEP 2: events ──────────────────────────────────────────────────────
    if (step === 'events') {
      if (!competitionId) return res.status(400).json({ error: 'competitionId required' });
      const events = await betfairCall(token, 'listEvents', {
        filter: { eventTypeIds: [eventTypeId], competitionIds: [competitionId], marketStartTime: { from, to } },
        maxResults: 100,
      });
      const sorted = (events || [])
        .filter(e => e.event?.id)
        .sort((a, b) => new Date(a.event.openDate) - new Date(b.event.openDate))
        .map(e => ({
          id: e.event.id,
          name: e.event.name,
          openDate: e.event.openDate,
          label: e.event.name + (e.event.openDate
            ? ' · ' + new Date(e.event.openDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
            : ''),
        }));
      return res.status(200).json({ events: sorted });
    }

    // ── STEP 3: markets grouped ─────────────────────────────────────────────
    if (step === 'markets') {
      if (!eventId) return res.status(400).json({ error: 'eventId required' });
      const markets = await betfairCall(token, 'listMarketCatalogue', {
        filter: { eventIds: [eventId] },
        marketProjection: ['MARKET_DESCRIPTION', 'MARKET_START_TIME'],
        maxResults: 200,
      });
      const groupMap = {};
      for (const m of (markets || [])) {
        const group = getMarketGroup(m.description?.marketType, m.marketName);
        if (!groupMap[group]) groupMap[group] = [];
        groupMap[group].push({ id: m.marketId, name: m.marketName, marketType: m.description?.marketType });
      }
      const groups = GROUP_ORDER
        .filter(g => groupMap[g])
        .map(g => ({ group: g, markets: groupMap[g] }));
      Object.keys(groupMap).filter(g => !GROUP_ORDER.includes(g)).forEach(g => {
        groups.push({ group: g, markets: groupMap[g] });
      });
      return res.status(200).json({ groups, liquidityWarning: !isLiquid });
    }

    // ── STEP 4: runners + live mid-price ────────────────────────────────────
    if (step === 'runners') {
      if (!marketId) return res.status(400).json({ error: 'marketId required' });
      const [catalogue, books] = await Promise.all([
        betfairCall(token, 'listMarketCatalogue', {
          filter: { marketIds: [marketId] },
          marketProjection: ['RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'MARKET_START_TIME', 'EVENT'],
          maxResults: 1,
        }),
        betfairCall(token, 'listMarketBook', {
          marketIds: [marketId],
          priceProjection: { priceData: ['EX_BEST_OFFERS'] },
        }),
      ]);
      const market = catalogue?.[0];
      const book   = books?.[0];
      if (!market || !book) return res.status(404).json({ error: 'Market not found' });
      const isUsable = book.status === 'OPEN' && !book.inplay;
      const runners = (book.runners || [])
        .filter(r => r.status !== 'REMOVED')
        .map(r => {
          const desc = market.runners?.find(rd => rd.selectionId === r.selectionId);
          const midPrice = isUsable ? getMidPrice(r) : null;
          const handicap = r.handicap != null && r.handicap !== 0 ? r.handicap : null;
          const baseName = desc?.runnerName || 'Runner ' + r.selectionId;
          const name = handicap != null ? `${baseName} (${handicap > 0 ? '+' : ''}${handicap})` : baseName;
          return { selectionId: r.selectionId, name, handicap, midPrice, isLive: !!midPrice, status: r.status };
        })
        .sort((a, b) => (a.midPrice || 999) - (b.midPrice || 999));
      return res.status(200).json({
        marketId, marketName: market.marketName, marketType: market.description?.marketType,
        startTime: market.marketStartTime, eventName: market.event?.name,
        isUsable, runners, liquidityWarning: !isLiquid,
      });
    }

    return res.status(400).json({ error: 'Invalid step' });

  } catch (err) {
    console.error('Markets error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
