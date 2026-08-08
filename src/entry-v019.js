import legacyWorker from './worker.js';

const LINE_CONTACTS_KEY_VERSION = 'v1';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/' && url.searchParams.get('m')) {
      return Response.redirect(`${url.origin}/m/${encodeURIComponent(url.searchParams.get('m'))}`, 302);
    }

    if (request.method === 'GET' && path.startsWith('/m/')) {
      const token = decodeURIComponent(path.slice(3));
      return renderMessagePage(token, request, env, ctx);
    }

    if (request.method === 'POST' && path === '/api/message') {
      return createMessageWithReusableLineContacts(request, env, ctx);
    }

    if (request.method === 'GET' && path === '/line/callback') {
      return finishLineContact(request, env, ctx);
    }

    return legacyWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof legacyWorker.scheduled === 'function') {
      return legacyWorker.scheduled(controller, env, ctx);
    }
  }
};

async function createMessageWithReusableLineContacts(request, env, ctx) {
  let submittedRecipients = [];
  try {
    const form = await request.clone().formData();
    submittedRecipients = JSON.parse(String(form.get('recipients') || '[]'));
  } catch {
    // Let the legacy worker return its normal validation error.
  }

  const response = await legacyWorker.fetch(request, env, ctx);
  if (!response.ok) return response;

  let data;
  try {
    data = await response.clone().json();
  } catch {
    return response;
  }

  const lineRecipients = Array.isArray(submittedRecipients)
    ? submittedRecipients.filter(r => r?.channel === 'line')
    : [];
  const generatedLinks = Array.isArray(data.lineConnections) ? data.lineConnections : [];
  if (!lineRecipients.length || !generatedLinks.length) return response;

  const outwardLinks = [];

  for (let i = 0; i < lineRecipients.length; i++) {
    const submitted = lineRecipients[i] || {};
    const generated = generatedLinks[i];
    if (!generated?.connectUrl) continue;

    const connectToken = connectTokenFromUrl(generated.connectUrl);
    if (!connectToken) {
      outwardLinks.push(generated);
      continue;
    }

    const recipient = await env.DB.prepare(`
      SELECT id FROM recipients
      WHERE connect_token = ?1 AND channel = 'line'
      ORDER BY created_at DESC LIMIT 1
    `).bind(connectToken).first();
    if (!recipient) {
      outwardLinks.push(generated);
      continue;
    }

    const requestedContactToken = String(submitted.contactToken || '').trim();
    if (requestedContactToken) {
      const contact = await env.DB.prepare(`
        SELECT id, label, line_user_id, line_connected_at
        FROM line_contacts WHERE contact_token = ?1 LIMIT 1
      `).bind(requestedContactToken).first();

      if (contact) {
        await env.DB.prepare(`
          UPDATE recipients
          SET line_contact_id = ?1,
              line_user_id = COALESCE(?2, line_user_id),
              line_connected_at = COALESCE(?3, line_connected_at),
              delivery_status = CASE
                WHEN ?2 IS NOT NULL AND delivery_status = 'waiting_line' THEN 'pending'
                ELSE delivery_status
              END,
              last_error = CASE
                WHEN ?2 IS NOT NULL AND delivery_status = 'waiting_line' THEN NULL
                ELSE last_error
              END
          WHERE id = ?4
        `).bind(contact.id, contact.line_user_id || null, contact.line_connected_at || null, recipient.id).run();
        // A valid saved contact needs no new pre-registration link.
        continue;
      }
      // Stale local contact: gracefully turn this send into a new first-time registration.
    }

    const contactId = crypto.randomUUID();
    const contactToken = randomToken(32);
    const now = Date.now();
    const label = String(submitted.label || generated.label || 'LINE').slice(0, 100);
    await env.DB.prepare(`
      INSERT INTO line_contacts (
        id, contact_token, connect_token, label,
        line_user_id, line_connected_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?5)
    `).bind(contactId, contactToken, connectToken, label, now).run();
    await env.DB.prepare(`
      UPDATE recipients SET line_contact_id = ?1 WHERE id = ?2
    `).bind(contactId, recipient.id).run();

    outwardLinks.push({ ...generated, label, contactToken });
  }

  data.lineConnections = outwardLinks;
  data.lineContactsVersion = LINE_CONTACTS_KEY_VERSION;
  return json(data, response.status);
}

async function finishLineContact(request, env, ctx) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const contact = state ? await env.DB.prepare(`
    SELECT id, label FROM line_contacts WHERE connect_token = ?1 LIMIT 1
  `).bind(state).first() : null;

  const response = await legacyWorker.fetch(request, env, ctx);
  if (!contact || !response.ok) return response;

  const recipient = await env.DB.prepare(`
    SELECT line_user_id, line_connected_at
    FROM recipients
    WHERE connect_token = ?1 AND channel = 'line' LIMIT 1
  `).bind(state).first();

  if (recipient?.line_user_id) {
    const connectedAt = Number(recipient.line_connected_at || Date.now());
    await env.DB.prepare(`
      UPDATE line_contacts
      SET line_user_id = ?1, line_connected_at = ?2, updated_at = ?2
      WHERE id = ?3
    `).bind(recipient.line_user_id, connectedAt, contact.id).run();

    await env.DB.prepare(`
      UPDATE recipients
      SET line_user_id = ?1,
          line_connected_at = ?2,
          delivery_status = CASE WHEN delivery_status = 'waiting_line' THEN 'pending' ELSE delivery_status END,
          last_error = CASE WHEN delivery_status = 'waiting_line' THEN NULL ELSE last_error END
      WHERE line_contact_id = ?3 AND delivery_status <> 'sent'
    `).bind(recipient.line_user_id, connectedAt, contact.id).run();
  }

  return htmlPage(`LINEの登録が完了しました。<br><strong>${escapeHtml(contact.label)}</strong><br><br>この受取人は保存されました。次回から事前リンクなしで、指定日時にLINEへ自動送信できます。`, 200, true);
}

async function renderMessagePage(token, request, env, ctx) {
  if (!token) return messageHtmlPage('このメッセージは見つかりませんでした。', 404);

  const apiRequest = new Request(`${new URL(request.url).origin}/api/open/${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: request.headers
  });
  const response = await legacyWorker.fetch(apiRequest, env, ctx);

  let data = {};
  try { data = await response.json(); } catch {}

  if (response.status === 423) {
    const detail = data.unlockAt
      ? `${formatDateTimeTokyo(data.unlockAt)} まで開けません。`
      : 'まだ、その時ではありません。';
    return messageHtmlPage(detail, 423);
  }
  if (!response.ok || !data.ok) {
    return messageHtmlPage('このメッセージを開けませんでした。', response.status || 500);
  }

  const attachment = data.attachment?.url
    ? `<a class="attachment" href="${escapeHtml(data.attachment.url)}">ATTACHMENT — ${escapeHtml(data.attachment.filename || 'attachment')}</a>`
    : '';
  const safeBody = escapeHtml(data.body || '').replace(/\r?\n/g, '<br>');
  const sealed = data.createdAt ? formatDateTokyo(data.createdAt) : '';

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>TIME WILL TELL</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f0e9;color:#151515;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}.wrap{width:min(720px,100%);margin:0 auto;padding:38px 18px 48px}.title{font-size:clamp(34px,8vw,54px);letter-spacing:.12em;font-weight:600;margin:0 0 28px}.card{background:#fffdfa;border:1px solid #d8d0c5;border-radius:28px;padding:30px 22px;box-shadow:0 8px 28px rgba(0,0,0,.03)}.meta{font-size:12px;letter-spacing:.16em;color:#666;margin-bottom:8px}.sender{font-size:18px;font-weight:600;margin:0 0 6px}.sealed{font-size:12px;letter-spacing:.12em;color:#777;margin:0 0 28px}.message{font-size:18px;line-height:1.9;overflow-wrap:anywhere;word-break:break-word}.attachment{display:inline-block;margin-top:28px;color:#151515;text-decoration:none;border:1px solid #151515;border-radius:999px;padding:12px 16px;font-size:13px;letter-spacing:.08em}.foot{margin-top:24px;font-size:11px;letter-spacing:.12em;color:#8a847c}@media(max-width:480px){.wrap{padding-top:28px}.card{padding:26px 20px}.message{font-size:17px}}
</style>
</head>
<body>
<main class="wrap">
<h1 class="title">TIME WILL TELL</h1>
<section class="card">
<div class="meta">FROM</div>
<p class="sender">${escapeHtml(data.senderName || 'TIME WILL TELL')}</p>
${sealed ? `<p class="sealed">SEALED — ${escapeHtml(sealed)}</p>` : ''}
<div class="message">${safeBody}</div>
${attachment}
</section>
<div class="foot">TIME ITSELF IS THE KEY.</div>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

function connectTokenFromUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.at(-1) || '';
  } catch {
    return '';
  }
}

function formatDateTokyo(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(Number(timestamp)));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}.${map.month}.${map.day}`;
}

function formatDateTimeTokyo(timestamp) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(Number(timestamp)));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}/${map.month}/${map.day} ${map.hour}:${map.minute}`;
}

function randomToken(bytes = 24) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function htmlPage(content, status = 200, raw = false) {
  const body = raw ? content : escapeHtml(content);
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>TIME WILL TELL</title><style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%;background:#f4f0e9;color:#151515;margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(520px,100%);background:#fffdfa;border:1px solid #d8d0c5;border-radius:26px;padding:30px 24px}h1{font-size:26px;letter-spacing:.1em;margin:0 0 26px}p{line-height:1.8;margin:0}a{color:#151515}</style><body><main class="card"><h1>TIME WILL TELL</h1><p>${body}</p></main></body></html>`, {status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

function messageHtmlPage(content, status = 200) {
  return htmlPage(content, status, false);
}
