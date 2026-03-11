// api/settle.js — fetch BSP + outcome for a known marketId + selectionId

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
  const res  = await httpsRequest('https://identitysso-cert.betfair.com/api/certlogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Application': APP_KEY, 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    cert, key,
  }, body);
  const data = JSON.parse(res.text);
  if (data.loginStatus !== 'SUCCESS') throw new Error('Login failed: ' + data.loginStatus);
  return data.sessionToken;
}

async function betfairCall(token, method, params) {
  const res = await fetch(`${BETFAIR_API}/${method}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Application': APP_KEY, 'X-Authentication': token },
    body: JSON.stringify(params),
  });
  return res.json();
}

// Map Betfair runner status to EdgeTrack outcome
function mapOutcome(status, sortPriority, ewPlaces) {
  if (status === 'WINNER') return 'win';
  if (status === 'LOSER') {
    // Check if they placed within EW terms
    if (ewPlaces && sortPriority && sortPriority <= ewPlaces) return 'place';
    return 'lose';
  }
  if (status === 'REMOVED') return 'nr';
  if (status === 'PLACED') return 'place';
  return 'pending';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { winMarketId, placeMarketId, selectionId, ewPlaces } = req.query;
  if (!winMarketId || !selectionId) return res.status(400).json({ error: 'winMarketId and selectionId are required' });

  const selId    = parseInt(selectionId);
  const ewPlNum  = ewPlaces ? parseInt(ewPlaces) : null;
  const marketIds = [winMarketId, placeMarketId].filter(Boolean);

  try {
    const token = await getSessionToken();

    const books = await betfairCall(token, 'listMarketBook', {
      marketIds,
      priceProjection: { bspPrices: true },
    });

    const winBook   = books.find(b => b.marketId === winMarketId);
    const placeBook = placeMarketId ? books.find(b => b.marketId === placeMarketId) : null;

    if (!winBook) return res.status(404).json({ error: 'Market not found — may have closed' });

    const winRunner   = winBook.runners?.find(r => r.selectionId === selId);
    const placeRunner = placeBook?.runners?.find(r => r.selectionId === selId);

    if (!winRunner) return res.status(404).json({ error: 'Runner not found in market' });

    const winBSP   = winRunner.sp?.actualSP ?? null;
    const placeBSP = placeRunner?.sp?.actualSP ?? null;

    // Determine outcome from win market runner status
    const sortPriority = winRunner.adjustedRating || null; // finishing position proxy
    const outcome = mapOutcome(winRunner.status, sortPriority, ewPlNum);

    console.log('Settle:', { winMarketId, selectionId, status: winRunner.status, winBSP, placeBSP, outcome });

    return res.status(200).json({ winBSP, placeBSP, outcome, status: winRunner.status });

  } catch (err) {
    console.error('Settle error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
