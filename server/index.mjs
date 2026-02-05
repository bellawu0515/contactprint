import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Node 18+ has global fetch.

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8787);

// --- Simple in-memory token cache ---
let cachedToken = null; // { token: string, expireAt: number }

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expireAt - 60_000 > now) {
    return cachedToken.token;
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET in server env');
  }

  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const json = await resp.json();
  if (!resp.ok || json?.code) {
    throw new Error(`Feishu token error: ${resp.status} ${JSON.stringify(json)}`);
  }

  const token = json.tenant_access_token;
  const expire = Number(json.expire || 0); // seconds
  cachedToken = { token, expireAt: now + expire * 1000 };
  return token;
}

async function feishuFetch(path, { method = 'GET', body, headers } = {}) {
  const token = await getTenantAccessToken();
  const resp = await fetch(`https://open.feishu.cn/open-apis${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json?.code) {
    throw new Error(`Feishu API error: ${resp.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function listAllRecords({ baseId, tableId, pageSize = 100 }) {
  let pageToken = undefined;
  let all = [];
  while (true) {
    const qs = new URLSearchParams();
    qs.set('page_size', String(pageSize));
    if (pageToken) qs.set('page_token', pageToken);

    const json = await feishuFetch(`/bitable/v1/apps/${baseId}/tables/${tableId}/records?${qs.toString()}`);
    const items = json?.data?.items || [];
    all = all.concat(items);

    const hasMore = Boolean(json?.data?.has_more);
    pageToken = json?.data?.page_token;
    if (!hasMore) break;
  }
  return all;
}

// --- API ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Get records of a table
app.get('/api/feishu/records', async (req, res) => {
  try {
    // 为了避免被随意探测/遍历其它 Base，这里强制从环境变量读取 Base ID。
    const baseId = String(process.env.FEISHU_BASE_ID || process.env.FEISHU_APP_TOKEN || '');
    const tableId = String(req.query.tableId || '');
    if (!baseId) return res.status(500).send('Server missing FEISHU_BASE_ID');
    if (!tableId) return res.status(400).send('Missing tableId');

    const items = await listAllRecords({ baseId, tableId });
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e?.message || e));
  }
});

// Get fields meta
app.get('/api/feishu/fields', async (req, res) => {
  try {
    const baseId = String(process.env.FEISHU_BASE_ID || '');
    const tableId = String(req.query.tableId || '');
    if (!baseId) return res.status(500).send('Server missing FEISHU_BASE_ID');
    if (!tableId) return res.status(400).send('Missing tableId');

    const json = await feishuFetch(`/bitable/v1/apps/${baseId}/tables/${tableId}/fields`);
    res.json(json?.data || json);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e?.message || e));
  }
});

// Gemini / AI generate
app.post('/api/ai/generate', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(400).send('Missing GEMINI_API_KEY in server env');

    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).send('Missing prompt');

    // Dynamic import to keep server fast-start.
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
    });

    const text = response?.text ?? '';
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e?.message || e));
  }
});

// Serve static dist in production (vite build)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');

app.use(express.static(distDir));
app.get('*', (_req, res) => {
  // SPA fallback
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
