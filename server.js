require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set. AI endpoints will fail until you set it in .env");
}
if (!process.env.ADMIN_CODE) {
  console.warn("WARNING: ADMIN_CODE is not set. Set it in .env or the admin panel will never unlock.");
}

/* ------------------------------------------------------------------ */
/* Database: one file, zero setup. Good for hundreds-thousands of      */
/* visitors; swap for Postgres later without touching the routes below */
/* if you outgrow it — the query shapes are deliberately simple.       */
/* ------------------------------------------------------------------ */
const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'FREE',
    gen_used INTEGER NOT NULL DEFAULT 0,
    an_used INTEGER NOT NULL DEFAULT 0,
    fn_used INTEGER NOT NULL DEFAULT 0,
    cons_used INTEGER NOT NULL DEFAULT 0,
    pro_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    price REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id);
`);

function getOrCreateClient(id) {
  let row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!row) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO clients (id, plan, created_at, updated_at) VALUES (?, 'FREE', ?, ?)"
    ).run(id, now, now);
    row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  }
  return row;
}

const USAGE_COLUMN = {
  generator: "gen_used",
  analyzer: "an_used",
  funnels: "fn_used",
  consultant: "cons_used"
};

/** Returns {ok:true} and bumps the counter, or {ok:false} if the limit
 *  for this visitor's current plan is already used up. */
function checkAndBumpUsage(clientId, tool) {
  const row = getOrCreateClient(clientId);
  if (row.plan === "VIP") return { ok: true };

  if (row.plan === "PRO") {
    if (row.pro_used >= 100) return { ok: false, reason: "pro_limit" };
    db.prepare("UPDATE clients SET pro_used = pro_used + 1, updated_at = ? WHERE id = ?").run(Date.now(), clientId);
    return { ok: true };
  }

  const col = USAGE_COLUMN[tool];
  if (!col) return { ok: false, reason: "unknown_tool" };
  if (row[col] >= 3) return { ok: false, reason: "free_limit" };
  db.prepare(`UPDATE clients SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`).run(Date.now(), clientId);
  return { ok: true };
}

function clientIdFrom(req) {
  const id = req.header("X-Client-Id");
  // A visitor id is just an opaque random string the frontend generates
  // once and stores in localStorage — no login required for customers.
  if (!id || typeof id !== "string" || id.length < 8 || id.length > 128) return null;
  return id;
}

/* ------------------------------------------------------------------ */
/* Anthropic API proxy — the API key lives only here, server-side.     */
/* ------------------------------------------------------------------ */
async function askClaude(promptOrMessages, { json = false } = {}) {
  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [{ role: "user", content: promptOrMessages }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1400,
      messages
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  if (!json) return text;

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

/* ------------------------------------------------------------------ */
/* Public API — used by every visitor, no login                        */
/* ------------------------------------------------------------------ */

app.get("/api/my-status", (req, res) => {
  const clientId = clientIdFrom(req);
  if (!clientId) return res.status(400).json({ error: "missing_client_id" });
  const row = getOrCreateClient(clientId);
  const lastRequest = db
    .prepare("SELECT * FROM requests WHERE client_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(clientId);
  res.json({
    plan: row.plan,
    usage: { generator: row.gen_used, analyzer: row.an_used, funnels: row.fn_used, consultant: row.cons_used },
    proUsed: row.pro_used,
    lastRequest: lastRequest || null
  });
});

app.post("/api/payment-requests", (req, res) => {
  const clientId = clientIdFrom(req);
  const { plan, price } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "missing_client_id" });
  if (!["PRO", "VIP"].includes(plan)) return res.status(400).json({ error: "bad_plan" });

  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO requests (id, client_id, plan, price, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).run(id, clientId, plan, Number(price) || 0, Date.now());
  res.json({ ok: true, id });
});

app.post("/api/generate", async (req, res) => {
  const clientId = clientIdFrom(req);
  if (!clientId) return res.status(400).json({ error: "missing_client_id" });

  const gate = checkAndBumpUsage(clientId, "generator");
  if (!gate.ok) return res.status(402).json({ error: "limit_exceeded" });

  try {
    const { niche, target, geo, platform, tone, funnel } = req.body || {};
    const prompt =
      "Ты — опытный таргетолог и копирайтер, работающий с рынком СНГ. Собери полную рекламную связку.\n\n" +
      `Ниша/продукт: ${niche || "Онлайн-курс по мобилографии"}\n` +
      `Целевая аудитория: ${target || "Девушки 18–35 лет, начинающие блогеры"}\n` +
      `Гео: ${geo || "Казахстан"}\n` +
      `Площадка: ${platform || "Instagram / Facebook Ads (Meta)"}\n` +
      `Тональность: ${tone || "Вовлекающий, трендовый"}\n` +
      (funnel ? `Архитектура воронки: ${funnel}\n` : "") +
      "\nПиши по-русски, конкретно, без воды и без общих фраз вроде «качественный продукт». " +
      "Используй реальные интересы, доступные в рекламном кабинете выбранной площадки.\n\n" +
      "Ответь ТОЛЬКО JSON-объектом такой формы:\n" +
      '{"framework":"AIDA|PAS|4U","offer":"1 предложение","headlines":["3 варианта заголовка"],' +
      '"hook":"первые 3 секунды видео","body":"что показать и сказать в основной части","cta":"призыв к действию",' +
      '"audience":{"interests":["5-7 интересов"],"age":"18-35","geo":"...","placements":"..."},' +
      '"budget":"рекомендация по стартовому бюджету","kpi":"целевые CTR/CPL"}';

    const data = await askClaude(prompt, { json: true });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ai_error", message: String(e.message || e) });
  }
});

app.post("/api/analyze", async (req, res) => {
  const clientId = clientIdFrom(req);
  if (!clientId) return res.status(400).json({ error: "missing_client_id" });

  const gate = checkAndBumpUsage(clientId, "analyzer");
  if (!gate.ok) return res.status(402).json({ error: "limit_exceeded" });

  try {
    const { offer } = req.body || {};
    if (!offer || !String(offer).trim()) return res.status(400).json({ error: "missing_offer" });

    const prompt =
      "Ты — таргетолог-аналитик. Оцени рекламный оффер честно и строго, без комплиментов.\n\n" +
      `ОФФЕР:\n${offer}\n\n` +
      "Оцени ясность, конкретику выгоды, снятие возражений, доверие, силу призыва. " +
      "CTR оцени реалистично для холодного трафика в соцсетях. Пиши по-русски.\n\n" +
      "Ответь ТОЛЬКО JSON:\n" +
      '{"ctr":"например ≈ 1.8%","ctrLevel":"короткая оценка уровня","score":0-100,' +
      '"strengths":["2-4 пункта"],"weaknesses":["2-4 пункта"],"rewrite":["2-3 усиленных варианта оффера"]}';

    const data = await askClaude(prompt, { json: true });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ai_error", message: String(e.message || e) });
  }
});

app.post("/api/chat", async (req, res) => {
  const clientId = clientIdFrom(req);
  if (!clientId) return res.status(400).json({ error: "missing_client_id" });

  const gate = checkAndBumpUsage(clientId, "consultant");
  if (!gate.ok) return res.status(402).json({ error: "limit_exceeded" });

  try {
    const { turns } = req.body || {}; // [{role:'user'|'assistant', content}], last one is the new user message
    if (!Array.isArray(turns) || !turns.length) return res.status(400).json({ error: "missing_turns" });

    const system =
      "Ты — практикующий таргетолог с опытом в Meta Ads и TikTok Ads, работаешь с рынком СНГ и Казахстана. " +
      "Отвечай по-русски, коротко и по делу: конкретные настройки, цифры, структура кампаний, а не общие советы. " +
      "Если данных не хватает — задай один уточняющий вопрос. Не советуй обходить правила площадок и блокировки: " +
      "вместо этого объясняй, как пройти модерацию легально. Максимум 180 слов.";

    const messages = [{ role: "user", content: system }].concat(
      turns.slice(-12).map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: String(t.content || "") }))
    );

    const text = await askClaude(messages, { json: false });
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ai_error", message: String(e.message || e) });
  }
});

/* ------------------------------------------------------------------ */
/* Admin API — everything below requires the server-side ADMIN_CODE.   */
/* The code is compared here, on the server; it never ships to the     */
/* browser, so it is safe to keep simple.                              */
/* ------------------------------------------------------------------ */
function requireAdmin(req, res, next) {
  const code = req.header("X-Admin-Code");
  if (!process.env.ADMIN_CODE || code !== process.env.ADMIN_CODE) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const { code } = req.body || {};
  if (process.env.ADMIN_CODE && code === process.env.ADMIN_CODE) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.get("/api/admin/requests", requireAdmin, (req, res) => {
  const status = req.query.status === "all" ? null : "pending";
  const rows = status
    ? db.prepare("SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC LIMIT 200").all(status)
    : db.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 200").all();
  res.json(rows);
});

app.post("/api/admin/requests/:id/confirm", requireAdmin, (req, res) => {
  const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(req.params.id);
  if (!request) return res.status(404).json({ error: "not_found" });

  getOrCreateClient(request.client_id);
  db.prepare("UPDATE clients SET plan = ?, pro_used = 0, updated_at = ? WHERE id = ?").run(
    request.plan,
    Date.now(),
    request.client_id
  );
  db.prepare("UPDATE requests SET status = 'confirmed', decided_at = ? WHERE id = ?").run(Date.now(), req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/requests/:id/reject", requireAdmin, (req, res) => {
  db.prepare("UPDATE requests SET status = 'rejected', decided_at = ? WHERE id = ?").run(Date.now(), req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/manual-activate", requireAdmin, (req, res) => {
  const { clientId, plan } = req.body || {};
  if (!clientId || !["FREE", "PRO", "VIP"].includes(plan)) return res.status(400).json({ error: "bad_request" });
  getOrCreateClient(clientId);
  db.prepare("UPDATE clients SET plan = ?, pro_used = 0, updated_at = ? WHERE id = ?").run(plan, Date.now(), clientId);
  res.json({ ok: true });
});

app.get("/api/admin/clients/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(row);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Targetologist backend listening on port ${PORT}`));
