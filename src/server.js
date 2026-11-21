import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
// In-memory fallback (used only when DATABASE_URL is not set, e.g. local test)
const mem = new Map();
let dbReady = false;
if (pool) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS result_records (
      client_id VARCHAR(80) NOT NULL,
      id BIGSERIAL,
      period VARCHAR(80) NOT NULL,
      number INT NOT NULL CHECK (number >= 0 AND number <= 9),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (client_id, id)
    )`);
    dbReady = true;
  } catch (e) { console.error('DB init failed', e); }
}

const validClient = x => typeof x === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(x);
const sizeOf = n => (n >= 5 ? 'BIG' : 'SMALL');
const colorOf = n => (n === 0 ? 'Red + Violet' : n === 5 ? 'Green + Violet' : n % 2 === 1 ? 'Green' : 'Red');

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Bipin Bhai History & Statistics API', database: hasDb ? (dbReady ? 'connected' : 'error') : 'memory-fallback' }));

async function listRecords(clientId, limit = 100) {
  if (pool && dbReady) {
    const { rows } = await pool.query('SELECT id, period, number, created_at FROM result_records WHERE client_id=$1 ORDER BY id DESC LIMIT $2', [clientId, limit]);
    return rows.map(r => ({ id: String(r.id), period: r.period, number: r.number, size: sizeOf(r.number), color: colorOf(r.number), createdAt: r.created_at }));
  }
  return (mem.get(clientId) || []).slice(0, limit);
}

app.post('/api/records', async (req, res) => {
  const { clientId, period, number } = req.body || {};
  const num = Number(number);
  if (!validClient(clientId) || typeof period !== 'string' || !period.trim() || period.length > 80 || !Number.isInteger(num) || num < 0 || num > 9)
    return res.status(400).json({ error: 'Invalid record: period and a number 0-9 are required.' });
  try {
    if (pool && dbReady) {
      const { rows } = await pool.query('INSERT INTO result_records (client_id, period, number) VALUES ($1,$2,$3) RETURNING id, created_at', [clientId, period.trim(), num]);
      return res.json({ ok: true, record: { id: String(rows[0].id), period: period.trim(), number: num, size: sizeOf(num), color: colorOf(num), createdAt: rows[0].created_at } });
    }
    const arr = mem.get(clientId) || [];
    const rec = { id: String(Date.now()) + Math.floor(Math.random() * 1000), period: period.trim(), number: num, size: sizeOf(num), color: colorOf(num), createdAt: new Date().toISOString() };
    arr.unshift(rec); mem.set(clientId, arr.slice(0, 1000));
    return res.json({ ok: true, record: rec });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Could not save record' }); }
});

app.get('/api/records/:clientId', async (req, res) => {
  if (!validClient(req.params.clientId)) return res.status(400).json({ error: 'Invalid client id' });
  try { res.json({ records: await listRecords(req.params.clientId, Math.min(200, Number(req.query.limit) || 100)) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load records' }); }
});

app.delete('/api/records/:clientId/:id', async (req, res) => {
  const { clientId, id } = req.params;
  if (!validClient(clientId)) return res.status(400).json({ error: 'Invalid client id' });
  try {
    if (pool && dbReady) await pool.query('DELETE FROM result_records WHERE client_id=$1 AND id=$2', [clientId, id]);
    else mem.set(clientId, (mem.get(clientId) || []).filter(r => r.id !== id));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not delete record' }); }
});

app.get('/api/stats/:clientId', async (req, res) => {
  if (!validClient(req.params.clientId)) return res.status(400).json({ error: 'Invalid client id' });
  try {
    const records = await listRecords(req.params.clientId, 1000);
    const total = records.length;
    const big = records.filter(r => r.size === 'BIG').length;
    const small = total - big;
    const freq = Array.from({ length: 10 }, (_, n) => ({ number: n, count: records.filter(r => r.number === n).length }));
    freq.forEach(f => f.percent = total ? Math.round(f.count / total * 1000) / 10 : 0);
    const insights = [];
    if (total < 10) insights.push('Sample abhi chhota hai — kam se kam 10 results ke baad hi statistics ka matlab banta hai.');
    else insights.push(`Pichhle ${total} recorded results me BIG ${Math.round(big / total * 100)}% aur SMALL ${Math.round(small / total * 100)}% aaya hai. Ye sirf pichhla record hai.`);
    insights.push('Ye historical information hai, prediction nahi. Har naya round random hota hai — pichhle results agle result ko nahi badalte. No guaranteed wins.');
    res.json({ total, big, small, bigPercent: total ? Math.round(big / total * 1000) / 10 : null, smallPercent: total ? Math.round(small / total * 1000) / 10 : null, frequency: freq, recent: records.slice(0, 20), insights });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Stats unavailable' }); }
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Bipin History & Statistics listening on ${port} (db=${hasDb && dbReady})`));
