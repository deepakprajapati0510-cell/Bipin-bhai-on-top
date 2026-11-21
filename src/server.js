import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));

await pool.query(`CREATE TABLE IF NOT EXISTS prediction_records (
  client_id VARCHAR(80) NOT NULL,
  log_id VARCHAR(160) NOT NULL,
  period VARCHAR(80),
  predicted_size VARCHAR(12),
  actual_size VARCHAR(12),
  result VARCHAR(12),
  pattern TEXT,
  engine VARCHAR(80),
  confidence NUMERIC,
  created_at BIGINT,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, log_id)
)`);

const validClient = x => typeof x === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(x);
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Bipin bhai on top API' }));
app.post('/api/sync', async (req, res) => {
  const { clientId, records } = req.body || {};
  if (!validClient(clientId) || !Array.isArray(records) || records.length > 300) return res.status(400).json({ error: 'Invalid sync payload' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of records) {
      if (!r || typeof r.logId !== 'string' || r.logId.length > 160) continue;
      const result = String(r.result || '').toUpperCase();
      // Only finalized outcomes count. Pending or malformed entries are ignored.
      if (!['WIN', 'LOSS'].includes(result)) continue;
      await client.query(`INSERT INTO prediction_records
        (client_id, log_id, period, predicted_size, actual_size, result, pattern, engine, confidence, created_at, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (client_id, log_id) DO UPDATE SET
          period=EXCLUDED.period, predicted_size=EXCLUDED.predicted_size, actual_size=EXCLUDED.actual_size,
          result=EXCLUDED.result, pattern=EXCLUDED.pattern, engine=EXCLUDED.engine,
          confidence=EXCLUDED.confidence, created_at=EXCLUDED.created_at, payload=EXCLUDED.payload, synced_at=NOW()`,
        [clientId, r.logId, String(r.periodFull || r.periodShort || ''), String(r.predSize || ''), String(r.actualSize || ''), result,
         String(r.pattern || '').slice(0,500), String(r.engine || '').slice(0,80), Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
         Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : null, JSON.stringify(r)]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: records.length });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Could not sync records' }); }
  finally { client.release(); }
});
app.get('/api/learning/:clientId', async (req, res) => {
  const { clientId } = req.params;
  if (!validClient(clientId)) return res.status(400).json({ error: 'Invalid client id' });
  try {
    const { rows } = await pool.query(`SELECT result, COALESCE(NULLIF(pattern,''), NULLIF(engine,''), 'Unlabelled') AS group_name
      FROM prediction_records WHERE client_id=$1 ORDER BY created_at DESC NULLS LAST`, [clientId]);
    const wins = rows.filter(x => x.result === 'WIN').length;
    const losses = rows.filter(x => x.result === 'LOSS').length;
    const map = new Map();
    for (const row of rows) { const a=map.get(row.group_name)||{name:row.group_name,total:0,wins:0}; a.total++; if(row.result==='WIN')a.wins++; map.set(row.group_name,a); }
    const groups = [...map.values()].map(x=>({...x,rate:Math.round(x.wins/x.total*100)})).sort((a,b)=>b.total-a.total).slice(0,12);
    res.json({ total: rows.length, wins, losses, winRate: rows.length ? Math.round(wins/rows.length*1000)/10 : null, groups });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Learning report unavailable' }); }
});
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Bipin app listening on ${port}`));
