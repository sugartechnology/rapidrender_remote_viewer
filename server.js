const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── HTTP Server (serves test.html) on port 3000 ───────────────────────────
const httpServer = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'test.html');
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

httpServer.listen(3000, () => {
    console.log('[HTTP] Test page → http://192.168.0.213:3000');
});

// ─── WebSocket Signaling Server on port 8080 ───────────────────────────────
const wss = new WebSocket.Server({ port: 8080 });
const peers = {};

console.log('[Signaling] Server running on ws://192.168.0.213:8080');

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[Signaling] Client connected from ${ip}`);

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.warn('[Signaling] Invalid JSON received, ignoring.');
            return;
        }

        console.log(`[Signaling] Received type: ${msg.type} from ${msg.role || 'unknown'}`);

        if (msg.type === 'register') {
            ws.role = msg.role;
            peers[msg.role] = ws;
            console.log(`[Signaling] Registered role: ${msg.role}`);
            ws.send(JSON.stringify({ type: 'registered', role: msg.role }));
            return;
        }

        const targetRole = ws.role === 'sender' ? 'receiver' : 'sender';
        const target = peers[targetRole];

        if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify(msg));
            console.log(`[Signaling] Relayed ${msg.type} → ${targetRole}`);
        } else {
            console.warn(`[Signaling] Target '${targetRole}' not connected, message dropped.`);
        }
    });

    ws.on('close', () => {
        if (ws.role) {
            delete peers[ws.role];
            console.log(`[Signaling] ${ws.role} disconnected`);
        }
    });

    ws.on('error', (err) => {
        console.error(`[Signaling] WebSocket error: ${err.message}`);
    });
});