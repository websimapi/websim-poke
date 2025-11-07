const logEl = document.getElementById('log');
const descEl = document.getElementById('desc');
const submitBtn = document.getElementById('submitBtn');
const refreshBtn = document.getElementById('refreshBtn');

// Use the global `room` created in index.html
const room = window.room;

// Allowed parent origin for postMessage
const ALLOWED_PARENT_ORIGIN = 'https://poketest.on.websim.com';

// Utility logger
function log(...args) {
  logEl.textContent += args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ') + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// Get token from query string ?token=...
function getTokenFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || params.get('challenge') || null;
}

const TOKEN = getTokenFromQuery();
if (!TOKEN) {
  descEl.textContent = 'No challenge token supplied in the URL. Add ?token=YOUR_TOKEN';
  log('No token found in query string.');
} else {
  descEl.textContent = `Found challenge token: ${TOKEN}`;
  log('Token:', TOKEN);
}

// Create a challenge record. Use versioned type so schema changes can be handled later.
async function submitChallenge(token) {
  try {
    submitBtn.disabled = true;
    log('Creating auth_challenge_v1 record...');
    const rec = await room.collection('auth_challenge_v1').create({
      token,
      // optional metadata you might want to include:
      created_by_page: window.location.href,
    });
    log('Record created:', rec);
    // After creating, send the list of recent rows (newest to oldest)
    await sendRecentRows();
  } catch (err) {
    log('Error creating record:', err && err.message ? err.message : err);
  } finally {
    submitBtn.disabled = false;
  }
}

// Get recent rows and postMessage to parent. We send a small payload.
async function sendRecentRows() {
  try {
    refreshBtn.disabled = true;
    log('Fetching recent auth_challenge_v1 rows...');
    const rows = room.collection('auth_challenge_v1').getList() || [];
    // getList returns newest->oldest (per docs)
    const payload = {
      type: 'websim_auth_challenges',
      origin: window.location.origin,
      page: window.location.href,
      timestamp: new Date().toISOString(),
      rows: rows.slice(0, 20).map(r => ({
        id: r.id,
        token: r.token,
        username: r.username,
        created_at: r.created_at,
      })),
    };
    // Post to parent (the listener app)
    log('Posting message to parent window:', payload);
    // Use explicit allowed origin for safety.
    window.parent.postMessage(payload, ALLOWED_PARENT_ORIGIN);
  } catch (err) {
    log('Error fetching/sending rows:', err && err.message ? err.message : err);
  } finally {
    refreshBtn.disabled = false;
  }
}

// Subscribe to changes and forward them live to parent. Subscription callback receives the latest list.
let unsubscribe = null;
function startSubscription() {
  try {
    log('Subscribing to auth_challenge_v1 updates...');
    unsubscribe = room.collection('auth_challenge_v1').subscribe(function (rows) {
      log('Subscription update received. Rows count:', rows.length);
      const payload = {
        type: 'websim_auth_challenge_update',
        origin: window.location.origin,
        page: window.location.href,
        timestamp: new Date().toISOString(),
        rows: rows.slice(0, 20).map(r => ({
          id: r.id,
          token: r.token,
          username: r.username,
          created_at: r.created_at,
        })),
      };
      // Post to the explicit allowed parent origin to avoid loops/accepting echoes.
      window.parent.postMessage(payload, ALLOWED_PARENT_ORIGIN);
    });
  } catch (err) {
    log('Subscription error:', err && err.message ? err.message : err);
  }
}

submitBtn.addEventListener('click', async () => {
  if (!TOKEN) {
    log('No token to submit.');
    return;
  }
  await submitChallenge(TOKEN);
});

refreshBtn.addEventListener('click', sendRecentRows);

// Auto submit if token present
if (TOKEN) {
  // Wait a tick to ensure Websim is ready
  (async () => {
    try {
      // small delay to allow the client to warm up
      await new Promise(r => setTimeout(r, 200));
      await submitChallenge(TOKEN);
      startSubscription();
    } catch (err) {
      log('Auto submission error:', err && err.message ? err.message : err);
    }
  })();
}

// Also listen for messages from parent asking for manual refresh
window.addEventListener('message', (ev) => {
  try {
    if (!ev.data || typeof ev.data !== 'object') return;
    // Ignore messages that originated from this page (prevent self/echo loops)
    if (ev.origin === window.location.origin) {
      log('Ignored message from same origin (likely self/echo):', ev.origin);
      return;
    }
    // Only accept messages from the allowed parent origin
    if (ev.origin !== ALLOWED_PARENT_ORIGIN) {
      log('Ignored message from origin:', ev.origin);
      return;
    }
    // Additionally ignore messages that carry our own page origin in their payload (extra safety)
    if (ev.data && ev.data.origin === window.location.origin) {
      log('Ignored message with origin payload matching this page (prevent loop).');
      return;
    }
    if (ev.data && ev.data.type === 'request_auth_challenges') {
      // Optionally verify ev.origin here before responding
      log('Parent requested auth challenges; sending...');
      sendRecentRows();
    }
  } catch (e) {
    log('message handler error', e);
  }
});