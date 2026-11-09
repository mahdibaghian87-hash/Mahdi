import 'dotenv/config';
import express from 'express';
import html from './page.js';
import crypto from 'node:crypto';

const { TWELVE_KEY, ANTHROPIC_API_KEY, PORT = 3000 } = process.env;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

// Edit freely. Check each symbol is available on your Twelve Data plan.
const MARKETS = {
  gold:   { symbol: 'XAU/USD', name: { fa: 'طلا', en: 'Gold' } },
  brent:  { symbol: 'XBR/USD', name: { fa: 'نفت برنت', en: 'Brent oil' } },
  dow:    { symbol: 'DIA',     name: { fa: 'داو جونز (DIA)', en: 'Dow Jones (DIA)' } },
  eurusd: { symbol: 'EUR/USD', name: { fa: 'یورو/دلار', en: 'EUR/USD' } },
  gbpusd: { symbol: 'GBP/USD', name: { fa: 'پوند/دلار', en: 'GBP/USD' } },
  usdjpy: { symbol: 'USD/JPY', name: { fa: 'دلار/ین', en: 'USD/JPY' } },
};

/* ---------- cache ---------- */
const cache = new Map();
const inflight = new Map();
function cached(key, ttl, fn) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < ttl) return Promise.resolve(e.v);
  if (inflight.has(key)) return inflight.get(key);
  const p = fn()
    .then(v => { cache.set(key, { v, at: Date.now() }); return v; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------- market data + indicators ---------- */
async function getCandles(symbol) {
  const u = new URL('https://api.twelvedata.com/time_series');
  u.search = new URLSearchParams({ symbol, interval: '1h', outputsize: '120', apikey: TWELVE_KEY });
  const j = await (await fetch(u)).json();
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'No data');
  return j.values.map(v => ({ h: +v.high, l: +v.low, c: +v.close })).reverse();
}

const sma = (a, n) => { const s = a.slice(-n); return s.reduce((x, y) => x + y, 0) / s.length; };
function rsi(cl, n = 14) {
  let g = 0, l = 0;
  for (let i = cl.length - n; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function analyze(candles) {
  const cl = candles.map(c => c.c);
  const last = cl.at(-1);
  const ref = cl.at(-25) ?? cl[0];
  const s20 = sma(cl, 20), s50 = sma(cl, 50);
  const recent = candles.slice(-20);
  const trend = last > s20 && s20 > s50 ? 'up' : last < s20 && s20 < s50 ? 'down' : 'side';
  return {
    price: last,
    change: ((last - ref) / ref) * 100,
    trend,
    rsi: rsi(cl),
    sma20: s20,
    sma50: s50,
    support: Math.min(...recent.map(c => c.l)),
    resistance: Math.max(...recent.map(c => c.h)),
  };
}

const getAnalysis = id =>
  cached('a:' + id, 5 * 60e3, async () => analyze(await getCandles(MARKETS[id].symbol)));

/* ---------- AI ---------- */
async function claude(system, user, max = 500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'AI error');
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

const LANG = { fa: 'Persian (Farsi)', en: 'English' };
const SUMMARY_SYS = lang =>
  `You write short educational market commentary for beginners. Reply in ${LANG[lang]}, exactly 2 short sentences, plain text. ` +
  `Describe what the indicators show (trend, RSI zone, nearness to support/resistance). ` +
  `Never say buy or sell, never give price targets, never promise outcomes.`;
const ASK_SYS = lang =>
  `You are a patient teacher of technical analysis and risk management for beginner traders. Reply in ${LANG[lang]}, concise (under 150 words), plain text. ` +
  `Only discuss trading education, indicators, markets and risk. Politely decline other topics. ` +
  `Never give exact buy/sell signals, price targets or guarantees; if asked, explain how to evaluate a setup and stress risk management.`;

const getSummary = (id, lang) =>
  cached(`s:${id}:${lang}`, 10 * 60e3, async () => {
    const a = await getAnalysis(id);
    const data = { market: MARKETS[id].name.en, ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])) };
    return claude(SUMMARY_SYS(lang), JSON.stringify(data), 200);
  });

const hits = new Map();
function limited(uid, max = 15, windowMs = 3600e3) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now);
  hits.set(uid, arr);
  return false;
}

/* ---------- API ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));
app.get('/', (req, res) => res.type('html').send(html));

app.use('/api', (req, res, next) => { req.uid = req.ip; next(); });

const pickLang = l => (l === 'fa' ? 'fa' : 'en');

app.get('/api/markets', async (req, res) => {
  const lang = pickLang(req.query.lang);
  const out = await Promise.all(Object.keys(MARKETS).map(async id => {
    try {
      const a = await getAnalysis(id);
      return { id, name: MARKETS[id].name[lang], price: a.price, change: a.change, trend: a.trend };
    } catch (e) {
      return { id, name: MARKETS[id].name[lang], error: true };
    }
  }));
  res.json(out);
});

app.get('/api/analysis/:id', async (req, res) => {
  const id = req.params.id;
  if (!MARKETS[id]) return res.status(404).json({ error: 'Unknown market' });
  const lang = pickLang(req.query.lang);
  try {
    const a = await getAnalysis(id);
    let summary = null;
    try { summary = await getSummary(id, lang); } catch (e) { console.error('summary', e.message); }
    res.json({ id, name: MARKETS[id].name[lang], ...a, summary });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/ask', async (req, res) => {
  const q = String(req.body?.question || '').slice(0, 600).trim();
  if (!q) return res.status(400).json({ error: 'Empty question' });
  if (limited(req.uid)) return res.status(429).json({ error: 'Too many questions. Try again later.' });
  try {
    res.json({ answer: await claude(ASK_SYS(pickLang(req.body?.lang)), q, 500) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

if (!process.env.VERCEL) app.listen(PORT, () => console.log('Server on :' + PORT));

export default app;
