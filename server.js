const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

// Telegram proxy endpoint
app.post('/api/telegram', async (req, res) => {
  try {
    const { message, reply_markup } = req.body;

    if (!message) {
      return res.status(400).json({ ok: false, error: 'No message' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, error: 'Telegram not configured' });
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(reply_markup ? { reply_markup } : {})
    };

    const tgRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await tgRes.json();
    res.json(data);
  } catch (err) {
    console.error('Telegram proxy error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
