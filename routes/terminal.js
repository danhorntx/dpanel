'use strict';
const pty       = require('node-pty');
const cookiePkg = require('cookie');
const sig       = require('cookie-signature');

/**
 * Look up the session directly from the MySQL session store, bypassing
 * express-session middleware entirely.  Middleware-based auth fails in a
 * WebSocket context because express-session calls res.on('finish', …) to
 * register its save hook — passing a fake response object throws before
 * next() is ever called, so req.session never gets populated.
 *
 * Instead we:
 *  1. Parse the connect.sid cookie from the Upgrade request headers
 *  2. Unsign it with the session secret
 *  3. Call store.get() directly — no response object needed
 */
function getSession(req, store, secret) {
  return new Promise((resolve) => {
    try {
      const cookies = cookiePkg.parse(req.headers.cookie || '');
      const raw = cookies['connect.sid'];
      if (!raw || !raw.startsWith('s:')) return resolve(null);

      const unsigned = sig.unsign(raw.slice(2), secret);
      if (!unsigned) return resolve(null);

      store.get(unsigned, (err, session) => {
        if (err || !session) return resolve(null);
        resolve(session);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function attachTerminal(wss, sessionStore, sessionSecret) {
  wss.on('connection', async (ws, req) => {
    const session = await getSession(req, sessionStore, sessionSecret);

    if (!session || !session.userId) {
      ws.send(JSON.stringify({ type: 'error', data: 'Not authenticated' }));
      return ws.close();
    }

    const shell = pty.spawn('/bin/bash', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: '/root',
      env: process.env,
    });

    shell.onData(data => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
    });

    shell.onExit(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }));
      ws.close();
    });

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'input')  shell.write(msg.data);
        if (msg.type === 'resize') shell.resize(msg.cols, msg.rows);
      } catch (_) {}
    });

    ws.on('close', () => { try { shell.kill(); } catch (_) {} });
  });
}

module.exports = { attachTerminal };
