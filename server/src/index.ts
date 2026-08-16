import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { config, pool } from './db.js';
import { errorHandler } from './platform/http.js';
import { authRouter, mastersRouter } from './modules/masters.js';
import { planningRouter } from './modules/planning.js';
import { receivingRouter } from './modules/receiving.js';
import { costingRouter } from './modules/costing.js';
import { insightsRouter } from './modules/insights.js';
import { farmingRouter } from './modules/farming.js';
import { inventoryRouter } from './modules/inventory.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: config.webOrigin.split(','), credentials: true }));
app.use(cookieParser());
// QC photos arrive as base64 from the tablet camera, so the limit is generous.
app.use(express.json({ limit: '12mb' }));
app.use(morgan('tiny'));

app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS t, current_database() AS db');
    res.json({ ok: true, db: rows[0].db, time: rows[0].t, ai: config.ai.provider });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/masters', mastersRouter);
app.use('/api/planning', planningRouter);
app.use('/api/receiving', receivingRouter);
app.use('/api/costing', costingRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/farming', farmingRouter);
app.use('/api/inventory', inventoryRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint' }));
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`ChotuG Purchase API listening on http://localhost:${config.port}`);
  console.log(`AI provider: ${config.ai.provider}${config.ai.provider === 'rules' ? ' (statistics only — no LLM configured)' : ` (${config.ai.model})`}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
