const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let currentMode = 'date';

const LINE_CONTACTS_KEY = 'timeWillTellLineContactsV1';

function loadLineContacts() {
  try {
    const value = JSON.parse(localStorage.getItem(LINE_CONTACTS_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter(x => x && x.contactToken && x.label).slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

function saveLineContact(item) {
  if (!item?.contactToken || !item?.label) return;
  try {
    const contacts = loadLineContacts().filter(x => x.contactToken !== item.contactToken);
    contacts.unshift({ label: String(item.label).slice(0, 100), contactToken: item.contactToken });
    localStorage.setItem(LINE_CONTACTS_KEY, JSON.stringify(contacts.slice(0, 50)));
  } catch {
    // The message still works even if this browser blocks local storage.
  }
}

function fillLineContactSelect(select, selectedToken = '') {
  const contacts = loadLineContacts();
  select.innerHTML = '';
  const choose = document.createElement('option');
  choose.value = '';
  choose.textContent = contacts.length ? '保存済みLINE受取人を選択' : '保存済みLINE受取人はまだありません';
  select.appendChild(choose);
  contacts.forEach(contact => {
    const option = document.createElement('option');
    option.value = contact.contactToken;
    option.textContent = contact.label;
    select.appendChild(option);
  });
  const fresh = document.createElement('option');
  fresh.value = '__new__';
  fresh.textContent = '＋ 新しいLINE受取人を登録';
  select.appendChild(fresh);
  select.value = selectedToken && contacts.some(x => x.contactToken === selectedToken) ? selectedToken : '';
}

const composeView = $('#composeView');
const doneView = $('#doneView');
const openView = $('#openView');
const triggerView = $('#triggerView');

function setOnly(view) {
  [composeView, doneView, openView, triggerView].forEach(v => v.hidden = v !== view);
}

function setMode(mode) {
  currentMode = mode;
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#dateFields').hidden = mode !== 'date';
  $('#whenFields').hidden = mode !== 'when';
  $('#sendAt').required = mode === 'date';
  $('#condition').required = mode === 'when';
}

$$('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

function updateRecipientCount() {
  const count = $('#recipients').children.length;
  $('#recipientCount').textContent = `${count} / 10`;
  $('#addEmailRecipient').disabled = count >= 10;
  $('#addLineRecipient').disabled = count >= 10;
}

function addRecipient(channel = 'email') {
  const host = $('#recipients');
  if (host.children.length >= 10) return;

  const node = $('#recipientTemplate').content.firstElementChild.cloneNode(true);
  const input = node.querySelector('.recipient-value');
  const lineSelect = node.querySelector('.recipient-line-contact');
  const contactTokenInput = node.querySelector('.recipient-contact-token');
  const channelValue = node.querySelector('.recipient-channel-value');
  const channelButtons = [...node.querySelectorAll('.recipient-channel-button')];

  function setRecipientChannel(nextChannel) {
    channelValue.value = nextChannel;
    channelButtons.forEach(button => {
      const active = button.dataset.channel === nextChannel;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    updateRecipientInput(nextChannel, input, lineSelect, contactTokenInput);
  }

  lineSelect.addEventListener('change', () => {
    const token = lineSelect.value;
    if (token === '__new__') {
      contactTokenInput.value = '';
      input.hidden = false;
      input.value = '';
      input.focus();
      return;
    }
    if (token) {
      const contact = loadLineContacts().find(x => x.contactToken === token);
      contactTokenInput.value = token;
      input.value = contact?.label || '';
      input.hidden = true;
      return;
    }
    contactTokenInput.value = '';
    input.value = '';
    input.hidden = loadLineContacts().length > 0;
  });

  channelButtons.forEach(button => {
    button.addEventListener('click', () => setRecipientChannel(button.dataset.channel));
  });

  node.querySelector('.remove-recipient').addEventListener('click', () => {
    if (host.children.length > 1) {
      node.remove();
      updateRecipientCount();
    }
  });

  setRecipientChannel(channel);
  host.appendChild(node);
  updateRecipientCount();
}

function updateRecipientInput(channel, input, lineSelect, contactTokenInput) {
  input.value = '';
  contactTokenInput.value = '';
  if (channel === 'email') {
    input.hidden = false;
    lineSelect.hidden = true;
    input.type = 'email';
    input.inputMode = 'email';
    input.autocomplete = 'email';
    input.placeholder = 'name@gmail.com';
    input.setAttribute('aria-label', 'Gmail / メールアドレス');
  } else {
    input.type = 'text';
    input.inputMode = 'text';
    input.autocomplete = 'name';
    input.placeholder = '新しいLINE受取人の名前';
    input.setAttribute('aria-label', 'LINE受取人の名前');
    fillLineContactSelect(lineSelect);
    lineSelect.hidden = false;
    input.hidden = loadLineContacts().length > 0;
  }
}

$('#addEmailRecipient').addEventListener('click', () => addRecipient('email'));
$('#addLineRecipient').addEventListener('click', () => addRecipient('line'));
addRecipient('email');

function collectRecipients() {
  return [...$('#recipients').children].map(row => {
    const channel = row.querySelector('.recipient-channel-value').value;
    const value = row.querySelector('.recipient-value').value.trim();
    if (channel === 'email') return { channel, address: value };
    const contactToken = row.querySelector('.recipient-contact-token').value.trim();
    return contactToken
      ? { channel, label: value, contactToken }
      : { channel, label: value };
  });
}

$('#messageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#formError');
  error.textContent = '';
  const button = $('#sealButton');
  button.disabled = true;
  button.textContent = 'SEALING…';

  try {
    const recipients = collectRecipients();
    if (recipients.some(r => (r.channel === 'email' ? !r.address : !r.label))) {
      throw new Error('送り先を入力してください。LINEは保存済み受取人を選ぶか、新しい受取人名を入力してください。');
    }

    const fd = new FormData();
    fd.set('senderName', $('#senderName').value.trim());
    fd.set('body', $('#body').value.trim());
    fd.set('mode', currentMode);
    fd.set('recipients', JSON.stringify(recipients));
    fd.set('triggerOwner', $('#triggerOwner').value);

    if (currentMode === 'date') {
      const localValue = $('#sendAt').value;
      if (!localValue) throw new Error('送信日時を指定してください。');
      fd.set('sendAt', new Date(localValue).toISOString());
    } else {
      fd.set('condition', $('#condition').value.trim());
    }

    const file = $('#attachment').files[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('添付は10MBまでです。');
      fd.set('attachment', file);
    }

    const res = await fetch('/api/message', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(apiError(data));

    showDone(data);
  } catch (err) {
    error.textContent = err.message || '保存できませんでした。';
  } finally {
    button.disabled = false;
    button.textContent = 'SEAL';
  }
});

function showDone(data) {
  setOnly(doneView);
  if (data.mode === 'date') {
    $('#doneSummary').textContent = `${new Date(data.sendAt).toLocaleString()} に ${data.recipientCount}件の送り先へ届けます。`;
  } else {
    $('#doneSummary').textContent = `条件が成立してTRIGGERされた時に ${data.recipientCount}件の送り先へ届けます。`;
  }

  const lineSetup = $('#lineSetup');
  const lineLinks = $('#lineLinks');
  lineLinks.innerHTML = '';
  if (data.lineConnections?.length) {
    lineSetup.hidden = false;
    data.lineConnections.forEach((item, i) => {
      saveLineContact(item);
      const id = `lineLink${i}`;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `<div class="muted"><strong>${escapeText(item.label)}</strong> — 初回だけこのリンクを受取人へ送ってください。登録後は次回から自動送信できます。</div><div class="copy-row"><input id="${id}" readonly><button class="copy-button" type="button" data-id="${id}">COPY</button></div>`;
      wrapper.querySelector('input').value = item.connectUrl;
      wrapper.querySelector('button').addEventListener('click', () => copyInput(id));
      lineLinks.appendChild(wrapper);
    });
  } else lineSetup.hidden = true;

  const triggerSetup = $('#triggerSetup');
  if (data.triggerUrl) {
    triggerSetup.hidden = false;
    $('#triggerUrl').value = data.triggerUrl;
  } else triggerSetup.hidden = true;
}

$('#newMessage').addEventListener('click', () => location.href = '/');
$$('[data-copy]').forEach(b => b.addEventListener('click', () => copyInput(b.dataset.copy)));

async function copyInput(id) {
  const value = document.getElementById(id).value;
  await navigator.clipboard.writeText(value);
}

function apiError(data) {
  const map = {
    rate_limited: '送信作成が多すぎます。しばらくしてからお試しください。',
    invalid_sender_name: '送信者名を入力してください。',
    invalid_message: 'メッセージを入力してください。',
    invalid_send_time: '未来の日時を指定してください。',
    invalid_condition: 'WHENの条件を入力してください。',
    invalid_email: 'Gmail / メールアドレスを確認してください。',
    line_label_required: 'LINE受取人の名前を入力してください。',
    invalid_line_contact: '保存済みLINE受取人が無効です。新しく登録し直してください。',
    attachment_too_large: '添付は10MBまでです。',
    server_not_configured: 'サーバー設定が完了していません。'
  };
  return map[data.error] || '保存できませんでした。';
}

function formatSealedDate(timestamp) {
  const d = new Date(Number(timestamp));
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

async function loadMessage(token) {
  setOnly(openView);
  try {
    const res = await fetch(`/api/open/${encodeURIComponent(token)}`);
    const data = await res.json();
    if (res.status === 423) {
      $('#notYet').hidden = false;
      $('#opened').hidden = true;
      $('#notYetText').textContent = data.unlockAt ? `${new Date(data.unlockAt).toLocaleString()} まで開けません。` : 'まだ、その時ではありません。';
      return;
    }
    if (!res.ok) throw new Error();
    $('#notYet').hidden = true;
    $('#opened').hidden = false;
    $('#messageSender').textContent = data.senderName ? `FROM — ${data.senderName}` : '';
    $('#messageSealed').textContent = data.createdAt ? `SEALED — ${formatSealedDate(data.createdAt)}` : '';
    $('#messageBody').textContent = data.body;
    if (data.attachment) {
      const link = $('#attachmentLink');
      link.hidden = false;
      link.href = data.attachment.url;
      link.textContent = `ATTACHMENT — ${data.attachment.filename}`;
    }
  } catch {
    $('#notYet').hidden = false;
    $('#notYetText').textContent = 'メッセージを開けませんでした。';
  }
}

async function loadTrigger(token) {
  setOnly(triggerView);
  try {
    const res = await fetch(`/api/trigger-info/${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) throw new Error();
    $('#triggerCondition').textContent = data.condition;
    $('#triggerStatus').textContent = data.triggered ? 'この条件はすでにTRIGGERされています。' : 'この条件が成立した時だけ押してください。';
    $('#triggerButton').disabled = data.triggered;
    $('#triggerButton').dataset.token = token;
  } catch {
    $('#triggerCondition').textContent = '無効なTRIGGER LINKです。';
    $('#triggerButton').hidden = true;
  }
}

$('#triggerButton').addEventListener('click', async (e) => {
  const token = e.currentTarget.dataset.token;
  if (!token) return;
  if (!confirm('この条件が成立したとして、メッセージを送信しますか？')) return;
  e.currentTarget.disabled = true;
  $('#triggerError').textContent = '';
  try {
    const res = await fetch(`/api/trigger/${encodeURIComponent(token)}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error();
    $('#triggerStatus').textContent = 'TRIGGERしました。メッセージの配送を開始しました。';
  } catch {
    $('#triggerError').textContent = 'TRIGGERできませんでした。';
    e.currentTarget.disabled = false;
  }
});

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

const params = new URLSearchParams(location.search);
if (params.get('m')) loadMessage(params.get('m'));
else if (params.get('trigger')) loadTrigger(params.get('trigger'));
else {
  setOnly(composeView);
  setMode('date');
  const d = new Date(Date.now() + 5 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
  $('#sendAt').value = local;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
}
