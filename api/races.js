// api/races.js — returns today's GB+IE horse racing markets grouped by course+time

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = await getSessionToken();

    const now  = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1hr ago
    const to   = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(); // 12hrs ahead

    // Get all WIN markets — these define the races
    const markets = await betfairCall(token, 'listMarketCatalogue', {
      filter: {
        eventTypeIds: ['7'],
        marketCountries: ['GB', 'IE'],
        marketStartTime: { from, to },
        marketTypeCodes: ['WIN'],
      },
      marketProjection: ['MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'EVENT'],
      maxResults: 200,
      sort: 'FIRST_TO_START',
    });

    if (!markets?.length) return res.status(200).json({ races: [] });

    // Group into races
    const races = markets.map(m => {
      const startTime = new Date(m.marketStartTime);
      const timeStr   = startTime.toISOString().slice(11, 16); // HH:MM UTC
      const dateStr   = startTime.toISOString().slice(0, 10);  // YYYY-MM-DD
      const course    = m.event?.venue || m.event?.name || m.marketName;

      const runners = (m.runners || [])
        .filter(r => r.sortPriority)
        .sort((a, b) => a.sortPriority - b.sortPriority)
        .map(r => ({ id: r.selectionId, name: r.runnerName }));

      return {
        marketId: m.marketId,
        course,
        date: dateStr,
        time: timeStr,
        name: m.marketName,
        label: `${course} ${timeStr}`,
        runners,
      };
    });

    return res.status(200).json({ races });

  } catch (err) {
    console.error('Races fetch error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
