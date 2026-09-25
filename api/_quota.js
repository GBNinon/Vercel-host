// api/_quota.js
// Shared helper (the underscore means Vercel does NOT turn this into its own URL).
// Daily and monthly AI limits per member, counted in Supabase (project qcz, table ams_ai_usage).
// Refunds need a one-time ticket that only this server sees (Supabase table ams_ai_tickets).
// Limits live in the Supabase function ai_quota_limits:
//   fridge_scan 3 a day / 30 a month, recipes 5 / 40, recipe_photo 5 / 40.
// No new secret needed: this uses the PUBLIC anon key (the same one inside the app)
// plus the member's own login token, sent by the app.
const axios = require('axios');

const SUPABASE_URL = 'https://qczutthumgpgxwepatte.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjenV0dGh1bWdwZ3h3ZXBhdHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwNzg5NzAsImV4cCI6MjA4NDY1NDk3MH0.vleNYVReRJnMruKBTXEb9gwdKVdhbiuLJTZoDiuUM0g';

function who(req) {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const device = String(req.headers['x-device-id'] || '').slice(0, 64);
  return { token, device };
}

async function rpc(fn, req, body) {
  const { token } = who(req);
  const r = await axios.post(
    SUPABASE_URL + '/rest/v1/rpc/' + fn,
    body,
    {
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: 'Bearer ' + (token || SUPABASE_ANON),
        'Content-Type': 'application/json',
      },
      timeout: 6000,
      validateStatus: () => true,
    }
  );
  return r;
}

// Returns { allowed: true } or { allowed: false, reason: 'day' | 'month' | 'id' }
async function takeQuota(req, kind) {
  const { token, device } = who(req);
  // Old app versions send nothing. They keep working until AI_REQUIRE_ID = 1 is set in Vercel.
  if (!token && !device) {
    return process.env.AI_REQUIRE_ID === '1' ? { allowed: false, reason: 'id' } : { allowed: true };
  }
  try {
    const body = { p_kind: kind, p_device: device || null };
    let r = await rpc('ai_quota_take', req, body);
    if (r.status === 401 && token) {
      // expired login token: count on the device instead
      req.headers['authorization'] = '';
      r = await rpc('ai_quota_take', req, body);
    }
    if (r.status >= 200 && r.status < 300 && r.data && typeof r.data.allowed === 'boolean') {
      // One-time refund ticket: stays on the server, never sent to the app.
      if (r.data.ticket) req._quotaTicket = r.data.ticket;
      delete r.data.ticket;
      return r.data;
    }
  } catch (e) { /* Supabase unreachable: do not block the family */ }
  return { allowed: true };
}

// The AI call failed: give that one use back, with the server-only ticket from takeQuota.
async function giveBack(req) {
  const ticket = req._quotaTicket;
  if (!ticket) return;
  req._quotaTicket = null;
  try { await rpc('ai_quota_give_back', req, { p_ticket: ticket }); } catch (e) { /* ignore */ }
}

function limitReply(res, q) {
  return res.status(429).json({ error: 'limit', reason: q.reason || 'day', day_limit: q.day_limit, month_limit: q.month_limit });
}

module.exports = { takeQuota, giveBack, limitReply };
