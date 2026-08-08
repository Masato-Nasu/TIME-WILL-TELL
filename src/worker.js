const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 10;
const MAX_MESSAGE_CHARS = 10000;
const MAX_SENDER_NAME_CHARS = 100;
const MAX_CONDITION_CHARS = 500;
const HUNDRED_YEARS_MS = 100 * 365.25 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/message' && request.method === 'POST') {
        return await createMessage(request, env);
      }
      if (path.startsWith('/api/open/') && request.method === 'GET') {
        return await openMessage(path.split('/').pop(), env);
      }
      if (path.startsWith('/api/attachment/') && request.method === 'GET') {
        return await getAttachment(path.split('/').pop(), env);
      }
      if (path.startsWith('/api/trigger-info/') && request.method === 'GET') {
        return await triggerInfo(path.split('/').pop(), env);
      }
      if (path.startsWith('/api/trigger/') && request.method === 'POST') {
        return await triggerMessage(path.split('/').pop(), env, ctx);
      }
      if (path.startsWith('/line/connect/') && request.method === 'GET') {
        return await beginLineConnect(path.split('/').pop(), env);
      }
      if (path === '/line/callback' && request.method === 'GET') {
        return await finishLineConnect(request, env, ctx);
      }
      if (path === '/gmail/connect' && request.method === 'GET') {
        return await beginGmailConnect(request, env);
      }
      if (path === '/gmail/callback' && request.method === 'GET') {
        return await finishGmailConnect(request, env);
      }
      if (path === '/api/health') {
        return json({ ok: true, app: 'TIME WILL TELL', now: Date.now() });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: 'internal_error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueMessages(env));
  }
};

async function createMessage(request, env) {
  if (!env.CONTENT_SECRET || env.CONTENT_SECRET.length < 24) {
    return json({ error: 'server_not_configured', detail: 'CONTENT_SECRET is missing or too short.' }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const allowed = await checkRateLimit(ip, env);
  if (!allowed) return json({ error: 'rate_limited' }, 429);

  const form = await request.formData();
  const senderName = String(form.get('senderName') || '').trim();
  const body = String(form.get('body') || '').trim();
  const mode = String(form.get('mode') || '');
  const sendAtRaw = String(form.get('sendAt') || '');
  const condition = String(form.get('condition') || '').trim();
  const triggerOwner = String(form.get('triggerOwner') || 'sender').slice(0, 32);
  const recipientsRaw = String(form.get('recipients') || '[]');
  const attachment = form.get('attachment');

  if (!senderName || senderName.length > MAX_SENDER_NAME_CHARS) {
    return json({ error: 'invalid_sender_name' }, 400);
  }
  if (!body || body.length > MAX_MESSAGE_CHARS) {
    return json({ error: 'invalid_message' }, 400);
  }
  if (!['date', 'when'].includes(mode)) {
    return json({ error: 'invalid_mode' }, 400);
  }

  let recipients;
  try {
    recipients = JSON.parse(recipientsRaw);
  } catch {
    return json({ error: 'invalid_recipients' }, 400);
  }
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_RECIPIENTS) {
    return json({ error: 'invalid_recipient_count' }, 400);
  }

  const normalizedRecipients = [];
  for (const r of recipients) {
    if (!r || !['email', 'line'].includes(r.channel)) return json({ error: 'invalid_recipient' }, 400);
    if (r.channel === 'email') {
      const address = String(r.address || '').trim().toLowerCase();
      if (!isEmail(address)) return json({ error: 'invalid_email', value: address }, 400);
      normalizedRecipients.push({ channel: 'email', address, label: String(r.label || '').slice(0, 100) });
    } else {
      const label = String(r.label || '').trim();
      if (!label) return json({ error: 'line_label_required' }, 400);
      normalizedRecipients.push({ channel: 'line', address: null, label: label.slice(0, 100) });
    }
  }

  const now = Date.now();
  let sendAt = null;
  let conditionEnc = null;
  let triggerToken = null;

  if (mode === 'date') {
    sendAt = Date.parse(sendAtRaw);
    if (!Number.isFinite(sendAt) || sendAt <= now + 30_000 || sendAt > now + HUNDRED_YEARS_MS) {
      return json({ error: 'invalid_send_time' }, 400);
    }
  } else {
    if (!condition || condition.length > MAX_CONDITION_CHARS) {
      return json({ error: 'invalid_condition' }, 400);
    }
    conditionEnc = await encryptText(condition, env.CONTENT_SECRET);
    triggerToken = randomToken(32);
  }

  if (attachment && typeof attachment === 'object' && attachment.size > MAX_ATTACHMENT_BYTES) {
    return json({ error: 'attachment_too_large', maxBytes: MAX_ATTACHMENT_BYTES }, 413);
  }

  const id = crypto.randomUUID();
  const publicToken = randomToken(24);
  const adminToken = randomToken(32);
  const senderNameEnc = await encryptText(senderName, env.CONTENT_SECRET);
  const bodyEnc = await encryptText(body, env.CONTENT_SECRET);

  let attachmentKey = null;
  let attachmentFilenameEnc = null;
  let attachmentType = null;
  let attachmentSize = null;

  if (attachment && typeof attachment === 'object' && attachment.size > 0) {
    const raw = await attachment.arrayBuffer();
    const encrypted = await encryptBytes(raw, env.CONTENT_SECRET);
    attachmentKey = `attachments/${id}`;
    attachmentFilenameEnc = await encryptText(attachment.name || 'attachment', env.CONTENT_SECRET);
    attachmentType = attachment.type || 'application/octet-stream';
    attachmentSize = attachment.size;
    await env.ATTACHMENTS.put(attachmentKey, encrypted);
  }

  const statements = [
    env.DB.prepare(`
      INSERT INTO messages (
        id, public_token, admin_token, trigger_token, mode, sender_name_enc, body_enc, condition_enc,
        trigger_owner, send_at, created_at, status, attachment_key,
        attachment_filename_enc, attachment_type, attachment_size
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'sealed', ?12, ?13, ?14, ?15)
    `).bind(
      id, publicToken, adminToken, triggerToken, mode, senderNameEnc, bodyEnc, conditionEnc,
      triggerOwner, sendAt, now, attachmentKey, attachmentFilenameEnc, attachmentType, attachmentSize
    )
  ];

  const lineLinks = [];
  for (const r of normalizedRecipients) {
    const recipientId = crypto.randomUUID();
    const connectToken = r.channel === 'line' ? randomToken(32) : null;
    statements.push(
      env.DB.prepare(`
        INSERT INTO recipients (
          id, message_id, channel, address, label, connect_token, delivery_status, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)
      `).bind(recipientId, id, r.channel, r.address, r.label, connectToken, now)
    );
    if (connectToken) {
      lineLinks.push({
        label: r.label,
        connectUrl: `${baseUrl(env)}/line/connect/${connectToken}`
      });
    }
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (attachmentKey) await env.ATTACHMENTS.delete(attachmentKey).catch(() => {});
    throw error;
  }

  await logCreation(ip, env);

  return json({
    ok: true,
    mode,
    sendAt,
    recipientCount: normalizedRecipients.length,
    lineConnections: lineLinks,
    triggerUrl: triggerToken ? `${baseUrl(env)}/?trigger=${triggerToken}` : null,
    managementToken: adminToken
  }, 201);
}

async function openMessage(publicToken, env) {
  const message = await env.DB.prepare(`
    SELECT id, mode, sender_name_enc, body_enc, condition_enc, send_at, triggered_at, status,
           attachment_key, attachment_filename_enc, attachment_type, attachment_size, created_at
    FROM messages WHERE public_token = ?1 LIMIT 1
  `).bind(publicToken).first();

  if (!message) return json({ error: 'not_found' }, 404);

  const now = Date.now();
  const released = isReleased(message, now);
  if (!released) {
    return json({
      error: 'not_yet',
      mode: message.mode,
      unlockAt: message.mode === 'date' ? message.send_at : null
    }, 423);
  }

  const senderName = message.sender_name_enc
    ? await decryptText(message.sender_name_enc, env.CONTENT_SECRET)
    : 'TIME WILL TELL';
  const body = await decryptText(message.body_enc, env.CONTENT_SECRET);
  const filename = message.attachment_filename_enc
    ? await decryptText(message.attachment_filename_enc, env.CONTENT_SECRET)
    : null;

  return json({
    ok: true,
    senderName,
    body,
    createdAt: message.created_at,
    attachment: message.attachment_key ? {
      filename,
      contentType: message.attachment_type,
      size: message.attachment_size,
      url: `${baseUrl(env)}/api/attachment/${publicToken}`
    } : null
  });
}

async function getAttachment(publicToken, env) {
  const message = await env.DB.prepare(`
    SELECT mode, send_at, triggered_at, attachment_key, attachment_filename_enc, attachment_type
    FROM messages WHERE public_token = ?1 LIMIT 1
  `).bind(publicToken).first();

  if (!message || !message.attachment_key) return new Response('Not found', { status: 404 });
  if (!isReleased(message, Date.now())) return new Response('NOT YET', { status: 423 });

  const object = await env.ATTACHMENTS.get(message.attachment_key);
  if (!object) return new Response('Not found', { status: 404 });
  const encrypted = await object.arrayBuffer();
  const decrypted = await decryptBytes(encrypted, env.CONTENT_SECRET);
  const filename = await decryptText(message.attachment_filename_enc, env.CONTENT_SECRET);
  const safeName = filename.replace(/[\r\n"]/g, '_');

  return new Response(decrypted, {
    headers: {
      'Content-Type': message.attachment_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Cache-Control': 'private, no-store'
    }
  });
}

async function triggerInfo(triggerToken, env) {
  const message = await env.DB.prepare(`
    SELECT mode, condition_enc, trigger_owner, triggered_at
    FROM messages WHERE trigger_token = ?1 LIMIT 1
  `).bind(triggerToken).first();
  if (!message || message.mode !== 'when') return json({ error: 'not_found' }, 404);

  return json({
    ok: true,
    condition: await decryptText(message.condition_enc, env.CONTENT_SECRET),
    triggerOwner: message.trigger_owner,
    triggered: !!message.triggered_at,
    triggeredAt: message.triggered_at || null
  });
}

async function triggerMessage(triggerToken, env, ctx) {
  const message = await env.DB.prepare(`
    SELECT id, mode, triggered_at FROM messages WHERE trigger_token = ?1 LIMIT 1
  `).bind(triggerToken).first();
  if (!message || message.mode !== 'when') return json({ error: 'not_found' }, 404);
  if (message.triggered_at) return json({ ok: true, alreadyTriggered: true, triggeredAt: message.triggered_at });

  const now = Date.now();
  await env.DB.prepare(`
    UPDATE messages SET triggered_at = ?1, status = 'released' WHERE id = ?2 AND triggered_at IS NULL
  `).bind(now, message.id).run();

  ctx.waitUntil(deliverMessage(message.id, env));
  return json({ ok: true, triggeredAt: now });
}

async function beginLineConnect(connectToken, env) {
  if (!env.LINE_LOGIN_CHANNEL_ID || !env.LINE_LOGIN_CHANNEL_SECRET) {
    return htmlPage('LINE連携はまだ設定されていません。', 503);
  }

  const recipient = await env.DB.prepare(`
    SELECT id, label, line_user_id FROM recipients WHERE connect_token = ?1 AND channel = 'line' LIMIT 1
  `).bind(connectToken).first();
  if (!recipient) return htmlPage('このLINE登録リンクは無効です。', 404);
  if (recipient.line_user_id) return htmlPage('LINEの登録は完了しています。');

  const redirectUri = `${baseUrl(env)}/line/callback`;
  const auth = new URL('https://access.line.me/oauth2/v2.1/authorize');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.LINE_LOGIN_CHANNEL_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('state', connectToken);
  auth.searchParams.set('scope', 'profile');
  auth.searchParams.set('bot_prompt', 'aggressive');
  return Response.redirect(auth.toString(), 302);
}

async function finishLineConnect(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return htmlPage('LINE連携を完了できませんでした。', 400);

  const recipient = await env.DB.prepare(`
    SELECT id, message_id, label FROM recipients WHERE connect_token = ?1 AND channel = 'line' LIMIT 1
  `).bind(state).first();
  if (!recipient) return htmlPage('このLINE登録リンクは無効です。', 404);

  const redirectUri = `${baseUrl(env)}/line/callback`;
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.LINE_LOGIN_CHANNEL_ID,
    client_secret: env.LINE_LOGIN_CHANNEL_SECRET
  });

  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody
  });
  if (!tokenRes.ok) {
    console.error('LINE token exchange failed', await tokenRes.text());
    return htmlPage('LINE連携を完了できませんでした。', 502);
  }
  const token = await tokenRes.json();

  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (!profileRes.ok) return htmlPage('LINEプロフィールを取得できませんでした。', 502);
  const profile = await profileRes.json();

  let friendFlag = true;
  try {
    const friendRes = await fetch('https://api.line.me/friendship/v1/status', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (friendRes.ok) {
      const friend = await friendRes.json();
      friendFlag = !!friend.friendFlag;
    }
  } catch (e) {
    console.error('Friendship check failed', e);
  }

  if (!friendFlag) {
    const extra = env.LINE_BOT_ADD_URL
      ? `<p><a href="${escapeHtml(env.LINE_BOT_ADD_URL)}">TIME WILL TELLをLINEで友だち追加</a>してから、もう一度登録リンクを開いてください。</p>`
      : '<p>TIME WILL TELLのLINE公式アカウントを友だち追加してから、もう一度登録リンクを開いてください。</p>';
    return htmlPage(`LINE公式アカウントの友だち追加が必要です。${extra}`, 409, true);
  }

  await env.DB.prepare(`
    UPDATE recipients SET line_user_id = ?1, line_connected_at = ?2, delivery_status = 'pending'
    WHERE id = ?3
  `).bind(profile.userId, Date.now(), recipient.id).run();

  const message = await env.DB.prepare(`
    SELECT id, mode, send_at, triggered_at FROM messages WHERE id = ?1 LIMIT 1
  `).bind(recipient.message_id).first();
  if (message && isReleased(message, Date.now())) {
    ctx.waitUntil(deliverRecipient(recipient.id, env));
  }

  return htmlPage(`LINEの登録が完了しました。<br><strong>${escapeHtml(profile.displayName || recipient.label || '')}</strong><br><br>指定された時が来るまで、メッセージ本文は届きません。`, 200, true);
}

async function beginGmailConnect(request, env) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return htmlPage('Gmail APIのOAuthクライアントがまだ設定されていません。', 503);
  }
  if (!env.CONTENT_SECRET || env.CONTENT_SECRET.length < 24) {
    return htmlPage('サーバーの暗号化設定が不足しています。', 503);
  }

  const state = await makeSignedOauthState(env.CONTENT_SECRET);
  const redirectUri = `${baseUrl(env)}/gmail/callback`;
  const senderAccount = gmailSenderAccount(env);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GMAIL_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.send');
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('include_granted_scopes', 'true');
  auth.searchParams.set('login_hint', senderAccount);
  auth.searchParams.set('state', state);
  return Response.redirect(auth.toString(), 302);
}

async function finishGmailConnect(request, env) {
  const url = new URL(request.url);
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return htmlPage(`Gmail連携がキャンセルされました。 (${oauthError})`, 400);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !(await verifySignedOauthState(state, env.CONTENT_SECRET))) {
    return htmlPage('Gmail連携を完了できませんでした。認証を最初からやり直してください。', 400);
  }

  const redirectUri = `${baseUrl(env)}/gmail/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    console.error('Gmail OAuth token exchange failed', await tokenRes.text());
    return htmlPage('Gmail連携を完了できませんでした。', 502);
  }

  const token = await tokenRes.json();
  if (!token.id_token) {
    return htmlPage('Googleアカウントを確認できませんでした。', 502);
  }

  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token.id_token)}`);
  if (!infoRes.ok) {
    return htmlPage('Googleアカウントを確認できませんでした。', 502);
  }
  const info = await infoRes.json();
  const expected = gmailSenderAccount(env);
  const actual = String(info.email || '').trim().toLowerCase();
  if (String(info.aud || '') !== String(env.GMAIL_CLIENT_ID) || actual !== expected) {
    return htmlPage(`この連携は ${expected} 専用です。現在のアカウント: ${actual || '不明'}`, 403);
  }

  if (!token.refresh_token) {
    return htmlPage('Gmailの長期認証情報を取得できませんでした。もう一度Gmail連携を実行してください。', 409);
  }

  await ensureAppSettings(env);
  const refreshEnc = await encryptText(token.refresh_token, env.CONTENT_SECRET);
  await env.DB.prepare(`
    INSERT INTO app_settings (key, value_enc, updated_at)
    VALUES ('gmail_refresh_token', ?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at
  `).bind(refreshEnc, Date.now()).run();

  return htmlPage(`Gmail送信アカウントの連携が完了しました。<br><strong>${escapeHtml(expected)}</strong><br><br>TIME WILL TELLはメール送信権限（gmail.send）のみを使用します。`, 200, true);
}

async function ensureAppSettings(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run();
}

function gmailSenderAccount(env) {
  return String(env.GMAIL_SENDER_ACCOUNT || 'timewilltellappjp@gmail.com').trim().toLowerCase();
}

async function makeSignedOauthState(secret) {
  const payload = `${Date.now()}.${randomToken(18)}`;
  const signature = await hmacBase64Url(secret, payload);
  return `${payload}.${signature}`;
}

async function verifySignedOauthState(state, secret) {
  if (!secret) return false;
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const timestamp = Number(parts[0]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await hmacBase64Url(secret, payload);
  return timingSafeEqual(parts[2], expected);
}

async function hmacBase64Url(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return bytesToBase64Url(new Uint8Array(signature));
}

function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function processDueMessages(env) {
  const now = Date.now();
  await env.DB.prepare(`
    UPDATE messages SET status = 'released'
    WHERE mode = 'date' AND status = 'sealed' AND send_at <= ?1
  `).bind(now).run();

  const due = await env.DB.prepare(`
    SELECT DISTINCT m.id
    FROM messages m
    JOIN recipients r ON r.message_id = m.id
    WHERE m.status = 'released'
      AND r.delivery_status IN ('pending', 'failed')
      AND (m.delivered_started_at IS NULL OR m.delivered_started_at < ?1)
    ORDER BY COALESCE(m.send_at, m.triggered_at) ASC
    LIMIT 25
  `).bind(now - 5 * 60 * 1000).all();

  for (const row of due.results || []) {
    await deliverMessage(row.id, env);
  }

  await env.DB.prepare(`DELETE FROM creation_log WHERE created_at < ?1`).bind(now - 2 * 24 * 60 * 60 * 1000).run();
}

async function deliverMessage(messageId, env) {
  const message = await env.DB.prepare(`
    SELECT id, public_token, mode, send_at, triggered_at, status
    FROM messages WHERE id = ?1 LIMIT 1
  `).bind(messageId).first();
  if (!message || !isReleased(message, Date.now())) return;

  const now = Date.now();
  await env.DB.prepare(`UPDATE messages SET delivered_started_at = ?1 WHERE id = ?2`).bind(now, messageId).run();

  const recipients = await env.DB.prepare(`
    SELECT id FROM recipients
    WHERE message_id = ?1 AND delivery_status IN ('pending', 'failed')
    ORDER BY created_at ASC
  `).bind(messageId).all();

  for (const r of recipients.results || []) {
    await deliverRecipient(r.id, env);
  }

  const left = await env.DB.prepare(`
    SELECT COUNT(*) AS c FROM recipients
    WHERE message_id = ?1 AND delivery_status IN ('pending', 'failed', 'waiting_line')
  `).bind(messageId).first();
  if ((left?.c || 0) === 0) {
    await env.DB.prepare(`UPDATE messages SET delivered_at = ?1 WHERE id = ?2`).bind(Date.now(), messageId).run();
  }
}

async function deliverRecipient(recipientId, env) {
  const row = await env.DB.prepare(`
    SELECT r.id, r.channel, r.address, r.label, r.line_user_id, r.delivery_status,
           m.public_token, m.mode, m.send_at, m.triggered_at, m.sender_name_enc
    FROM recipients r JOIN messages m ON m.id = r.message_id
    WHERE r.id = ?1 LIMIT 1
  `).bind(recipientId).first();

  if (!row || row.delivery_status === 'sent' || !isReleased(row, Date.now())) return;

  const url = `${baseUrl(env)}/?m=${row.public_token}`;
  const senderName = row.sender_name_enc
    ? await decryptText(row.sender_name_enc, env.CONTENT_SECRET)
    : 'TIME WILL TELL';
  let result;
  if (row.channel === 'email') {
    result = await sendEmail(row.address, url, senderName, env, recipientId);
  } else {
    if (!row.line_user_id) {
      await env.DB.prepare(`
        UPDATE recipients SET delivery_status = 'waiting_line', last_error = 'LINE recipient not connected'
        WHERE id = ?1
      `).bind(recipientId).run();
      return;
    }
    result = await sendLine(row.line_user_id, url, senderName, env, recipientId);
  }

  if (result.ok) {
    await env.DB.prepare(`
      UPDATE recipients SET delivery_status = 'sent', delivered_at = ?1, last_error = NULL WHERE id = ?2
    `).bind(Date.now(), recipientId).run();
  } else {
    await env.DB.prepare(`
      UPDATE recipients SET delivery_status = 'failed', last_error = ?1 WHERE id = ?2
    `).bind(String(result.error || 'delivery failed').slice(0, 500), recipientId).run();
  }
}

async function sendEmail(address, messageUrl, senderName, env, retryId) {
  const refreshToken = await getGmailRefreshToken(env);
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && refreshToken) {
    return sendEmailWithGmail(address, messageUrl, senderName, env, refreshToken, retryId);
  }

  // Keep Resend as a fallback until Gmail OAuth has been connected.
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    return { ok: false, error: 'Email delivery is not configured' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `time-will-tell-${retryId}`
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [address],
      subject: `TIME WILL TELL — ${senderName}`,
      html: emailHtml(messageUrl, senderName),
      text: emailText(messageUrl, senderName)
    })
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

async function getGmailRefreshToken(env) {
  if (env.GMAIL_REFRESH_TOKEN) return String(env.GMAIL_REFRESH_TOKEN);
  try {
    await ensureAppSettings(env);
    const row = await env.DB.prepare(`
      SELECT value_enc FROM app_settings WHERE key = 'gmail_refresh_token' LIMIT 1
    `).first();
    if (!row?.value_enc) return null;
    return await decryptText(row.value_enc, env.CONTENT_SECRET);
  } catch (error) {
    console.error('Gmail refresh token load failed', error);
    return null;
  }
}

async function sendEmailWithGmail(address, messageUrl, senderName, env, refreshToken, retryId) {
  const access = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!access.ok) {
    return { ok: false, error: `Gmail token refresh failed: ${await access.text()}` };
  }
  const accessData = await access.json();
  if (!accessData.access_token) return { ok: false, error: 'Gmail access token missing' };

  const raw = buildGmailRawMessage(address, messageUrl, senderName, gmailSenderAccount(env), retryId);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessData.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });
  if (!res.ok) return { ok: false, error: `Gmail send failed: ${await res.text()}` };
  return { ok: true };
}

function buildGmailRawMessage(address, messageUrl, senderName, senderAccount, retryId) {
  const boundary = `twt_${randomToken(12).replace(/[^A-Za-z0-9]/g, '')}`;
  const subject = encodeMimeWord(`TIME WILL TELL — ${senderName}`);
  const text = emailText(messageUrl, senderName);
  const html = emailHtml(messageUrl, senderName);
  const messageId = `<twt-${String(retryId).replace(/[^A-Za-z0-9._-]/g, '')}@time-will-tell>`;

  const mime = [
    `From: TIME WILL TELL <${senderAccount}>`,
    `To: ${address}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(utf8ToBase64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(utf8ToBase64(html)),
    `--${boundary}--`,
    ''
  ].join('\r\n');

  return bytesToBase64Url(new TextEncoder().encode(mime));
}

function emailText(messageUrl, senderName) {
  return `TIME WILL TELL\n\nFROM\n${senderName}\n\n${messageUrl}`;
}

function emailHtml(messageUrl, senderName) {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:auto;padding:32px;color:#111"><h1 style="letter-spacing:.08em;font-size:26px">TIME WILL TELL</h1><p style="margin:28px 0 4px;font-size:11px;letter-spacing:.18em;color:#666">FROM</p><p style="margin:0 0 24px;font-size:18px;line-height:1.6"><strong>${escapeHtml(senderName)}</strong></p><p><a href="${escapeHtml(messageUrl)}" style="display:inline-block;padding:12px 18px;border:1px solid #111;border-radius:999px;color:#111;text-decoration:none">OPEN</a></p></div>`;
}

function encodeMimeWord(value) {
  return `=?UTF-8?B?${utf8ToBase64(String(value || ''))}?=`;
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function wrapBase64(value) {
  return String(value || '').match(/.{1,76}/g)?.join('\r\n') || '';
}

async function sendLine(userId, messageUrl, senderName, env, retryId) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'LINE delivery is not configured' };
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Line-Retry-Key': retryId
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: `TIME WILL TELL\n\n${senderName} さんからメッセージが届きました。\n${messageUrl}` }]
    })
  });
  if (res.status === 409) return { ok: true };
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
}

function isReleased(message, now) {
  if (message.mode === 'date') return Number(message.send_at) <= now;
  return !!message.triggered_at;
}

async function checkRateLimit(ip, env) {
  const hash = await sha256Hex(`${env.RATE_SALT || 'twt'}:${ip}`);
  const since = Date.now() - 60 * 60 * 1000;
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS c FROM creation_log WHERE ip_hash = ?1 AND created_at >= ?2
  `).bind(hash, since).first();

  // Keep abuse protection, but allow enough room for normal use and testing.
  // Can be overridden later with RATE_LIMIT_PER_HOUR in Worker vars.
  const configured = Number(env.RATE_LIMIT_PER_HOUR || 30);
  const limit = Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 1), 1000) : 30;
  return Number(row?.c || 0) < limit;
}

async function logCreation(ip, env) {
  const hash = await sha256Hex(`${env.RATE_SALT || 'twt'}:${ip}`);
  await env.DB.prepare(`INSERT INTO creation_log (ip_hash, created_at) VALUES (?1, ?2)`).bind(hash, Date.now()).run();
}

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function secretKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptBytes(data, secret) {
  const key = await secretKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(iv.byteLength + encrypted.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(encrypted), iv.byteLength);
  return out.buffer;
}

async function decryptBytes(data, secret) {
  const bytes = new Uint8Array(data);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const key = await secretKey(secret);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
}

async function encryptText(text, secret) {
  const encrypted = new Uint8Array(await encryptBytes(new TextEncoder().encode(text), secret));
  return bytesToBase64Url(encrypted);
}

async function decryptText(text, secret) {
  const bytes = base64UrlToBytes(text);
  const plain = await decryptBytes(bytes.buffer, secret);
  return new TextDecoder().decode(plain);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomToken(bytes = 24) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function baseUrl(env) {
  return String(env.APP_BASE_URL || '').replace(/\/$/, '');
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
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
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIME WILL TELL</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f3ee;color:#151515;margin:0;display:grid;min-height:100vh;place-items:center}.card{width:min(520px,calc(100% - 40px));background:#fff;border:1px solid #d8d2c9;border-radius:24px;padding:32px;box-sizing:border-box}h1{font-size:24px;letter-spacing:.08em;margin:0 0 28px}p{line-height:1.75}a{color:#151515}</style><body><main class="card"><h1>TIME WILL TELL</h1><p>${body}</p></main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
