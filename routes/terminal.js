'use strict';
const pty = require('node-pty');

function attachTerminal(wss, sessionMiddleware) {
  wss.on('connection', (ws, req) => {
    // Authenticate via session
    sessionMiddleware(req, {}, () => {
      if (!req.session || !req.session.authenticated) {
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
          if (msg.type === 'input') shell.write(msg.data);
          if (msg.type === 'resize') shell.resize(msg.cols, msg.rows);
        } catch (_) {}
      });

      ws.on('close', () => { try { shell.kill(); } catch (_) {} });
    });
  });
}

module.exports = { attachTerminal };
