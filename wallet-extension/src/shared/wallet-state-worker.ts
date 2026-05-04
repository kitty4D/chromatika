/**
 * SharedWorker - broadcast bus between popup and side panel.
 * any message sent by one port is relayed to all connected ports (including sender).
 * keeps popup + side panel in sync without extra background polling.
 */

const ports: MessagePort[] = [];

// SharedWorker global scope: onconnect fires for each new connection
(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  ports.push(port);

  port.onmessage = (msg: MessageEvent) => {
    // relay to all connected surfaces
    for (const p of ports) {
      try { p.postMessage(msg.data); } catch { /* port already closed */ }
    }
  };

  // prune closed ports on each new connection
  for (let i = ports.length - 2; i >= 0; i--) {
    try {
      // sending a no-op; if it throws the port is dead
      ports[i].postMessage({ type: 'ping' });
    } catch {
      ports.splice(i, 1);
    }
  }

  port.start();
};
