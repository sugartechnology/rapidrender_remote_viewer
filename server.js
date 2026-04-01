const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const localIP = getLocalIP();
const sessions = {};

function generatePin() {
    let pin;
    do {
        pin = Math.floor(1000 + Math.random() * 9000).toString();
    } while (sessions[pin]);
    return pin;
}

// ─── Quest 2 Optimization Metadata ────────────────────────────────
const QUEST2_CONFIG = {
    recommendedResolution: '1832x1920',
    recommendedBitrate: 18000, // kbps
    recommendedFPS: 72
};

// ─── Unified Server (HTTP + WebSocket) on port 3000 ────────────────────────
const httpServer = https.createServer({
    key: fs.readFileSync('localhost+2-key.pem'),
    cert: fs.readFileSync('localhost+2.pem')
}, (req, res) => {
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

const wss = new WebSocket.Server({ server: httpServer });

httpServer.listen(3000, () => {
    console.log(`[Unified Server] Live on http://${localIP}:3000`);
    console.log(`[Unified Server] Signaling is handled on the same port.`);
    console.log(`[Quest 2 Optimizations] Recommended: ${QUEST2_CONFIG.recommendedResolution} @ ${QUEST2_CONFIG.recommendedBitrate} kbps`);
});

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    ws.id = Math.random().toString(36).substr(2, 9);
    console.log(`[Signaling] Client connected from ${ip} (ID: ${ws.id})`);

    ws.on('message', (data, isBinary) => {
        let msg;
        let isJson = false;

        try {
            // Check if it's text/JSON
            const str = data.toString();
            if (str.startsWith('{') && str.endsWith('}')) {
                msg = JSON.parse(str);
                isJson = true;
            }
        } catch (e) {
            isJson = false;
        }

        // 1. Handle Registration/Signaling (JSON)
        if (isJson && msg) {
            if (msg.type === 'register') {
                ws.role = msg.role;
                
                if (ws.role === 'sender') {
                    const pin = generatePin();
                    ws.pin = pin;
                    sessions[pin] = { sender: ws, receivers: new Set() };
                    console.log(`[Signaling] Registered sender with PIN: ${pin}`);
                    ws.send(JSON.stringify({ type: 'registered', pin: pin }));
                } else if (ws.role === 'receiver') {
                    const pin = msg.pin;
                    if (pin && sessions[pin]) {
                        ws.pin = pin;
                        sessions[pin].receivers.add(ws);
                        console.log(`[Signaling] Receiver ${ws.id} registered for PIN: ${pin}`);
                        if (sessions[pin].sender.readyState === WebSocket.OPEN) {
                            sessions[pin].sender.send(JSON.stringify({ type: 'receiver_joined', clientId: ws.id }));
                        }
                        ws.send(JSON.stringify({ type: 'session_ready', clientId: ws.id }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid PIN' }));
                    }
                }
                return;
            }

            // Normal Signaling Relay (tracking, request_360, etc.)
            if (ws.pin && sessions[ws.pin]) {
                const session = sessions[ws.pin];
                if (ws.role === 'sender') {
                    for (const receiver of session.receivers) {
                        if (receiver.readyState === WebSocket.OPEN) {
                            receiver.send(JSON.stringify(msg));
                        }
                    }
                } else if (ws.role === 'receiver') {
                    if (session.sender.readyState === WebSocket.OPEN) {
                        // Attach clientId to every message from receiver to sender
                        msg.clientId = ws.id;
                        session.sender.send(JSON.stringify(msg));
                    }
                }
            }
            return;
        }

        // 2. Handle Binary Imaging Relay
        // If we get here, it's not valid JSON. If the sender is registered, relay it.
        if (ws.pin && sessions[ws.pin]) {
            const session = sessions[ws.pin];
            if (ws.role === 'sender') {
                // Header-based routing: [ID_LEN (1 byte)][ID (string)][FaceIdx, SeqId, JPG...]
                const idLen = data[0];
                const targetId = data.slice(1, 1 + idLen).toString();
                const actualPayload = data.slice(1 + idLen);

                for (const receiver of session.receivers) {
                    if (receiver.id === targetId && receiver.readyState === WebSocket.OPEN) {
                        receiver.send(actualPayload);
                        break;
                    }
                }
            }
        }
    });

    ws.on('close', () => {
        if (ws.pin && sessions[ws.pin]) {
            console.log(`[Signaling] ${ws.role} disconnected from PIN ${ws.pin}`);
            const session = sessions[ws.pin];
            
            if (ws.role === 'sender') {
                for (const receiver of session.receivers) {
                    if (receiver.readyState === WebSocket.OPEN) {
                        receiver.send(JSON.stringify({ type: 'peer_disconnected', role: 'sender' }));
                    }
                }
                delete sessions[ws.pin];
            } else if (ws.role === 'receiver') {
                session.receivers.delete(ws);
                if (session.sender.readyState === WebSocket.OPEN) {
                    session.sender.send(JSON.stringify({ type: 'receiver_left', clientId: ws.id }));
                }
            }
        }
    });

    ws.on('error', (err) => {
        console.error(`[Signaling] WebSocket error: ${err.message}`);
    });
});