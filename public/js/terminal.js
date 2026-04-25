// ── Terminal module ───────────────────────────────────────────────────────────
window.terminal = (() => {
  let term = null;
  let fitAddon = null;
  let ws = null;
  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    term = new Terminal({
      theme: {
        background:  '#06080c',
        foreground:  '#c9d1d9',
        cursor:      '#4f8ef7',
        cursorAccent:'#06080c',
        black:       '#1e2030',
        red:         '#f75f5f',
        green:       '#3dd68c',
        yellow:      '#f5a623',
        blue:        '#4f8ef7',
        magenta:     '#a07cf5',
        cyan:        '#56d1e0',
        white:       '#e4e8f0',
        brightBlack: '#3d4a60',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 2000,
      allowTransparency: true,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    // WebSocket
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/terminal`);

    ws.onopen = () => {
      term.writeln('\x1b[1;34m[DPanel]\x1b[0m Terminal connected. You are root — proceed carefully.\r\n');
    };

    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') term.write(msg.data);
        if (msg.type === 'exit')   term.writeln('\r\n\x1b[1;31m[Session ended]\x1b[0m');
        if (msg.type === 'error')  term.writeln(`\r\n\x1b[1;31m[Error: ${msg.data}]\x1b[0m`);
      } catch(_) {}
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[1;33m[Disconnected]\x1b[0m');
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[1;31m[WebSocket error — check your session]\x1b[0m');
    };

    term.onData(data => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize
    const observer = new ResizeObserver(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
    });
    observer.observe(document.getElementById('terminal-container'));
  }

  return { init };
})();
