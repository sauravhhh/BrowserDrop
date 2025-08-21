// A simple signaling server for WebRTC
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Create a simple HTTP server to serve the client files ---
const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    let extname = path.extname(filePath);
    let contentType = 'text/html';

    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
    }
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocketServer({ noServer: true });

const clients = new Map();
const deviceNames = ["Indigo Fox", "Ruby Eagle", "Jade Turtle", "Gold Lion", "Opal Bear", "Sapphire Wolf"];

function getUniqueDeviceName() {
    const usedNames = Array.from(clients.values()).map(c => c.deviceName);
    const availableNames = deviceNames.filter(name => !usedNames.includes(name));
    return availableNames.length > 0 ? availableNames[Math.floor(Math.random() * availableNames.length)] : `User${clients.size + 1}`;
}

wss.on('connection', (ws) => {
    const clientId = Date.now().toString();
    const deviceName = getUniqueDeviceName();
    clients.set(ws, { id: clientId, deviceName });
    
    console.log(`Client ${deviceName} (${clientId}) connected`);

    // Notify the new client of its identity
    ws.send(JSON.stringify({ type: 'welcome', id: clientId, deviceName }));

    // Announce new client to all others
    const peerList = Array.from(clients.values()).map(c => ({ id: c.id, deviceName: c.deviceName }));
    for (const client of clients.keys()) {
        client.send(JSON.stringify({ type: 'updatePeers', peers: peerList }));
    }

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const { targetId, ...payload } = data;

        // Forward the message to the target client
        for (const [client, meta] of clients.entries()) {
            if (meta.id === targetId) {
                client.send(JSON.stringify({ ...payload, senderId: clientId }));
                break;
            }
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`Client ${deviceName} (${clientId}) disconnected`);
        // Announce departure to all others
        const peerList = Array.from(clients.values()).map(c => ({ id: c.id, deviceName: c.deviceName }));
        for (const client of clients.keys()) {
            client.send(JSON.stringify({ type: 'updatePeers', peers: peerList }));
        }
    });
});


// --- Upgrade HTTP requests to WebSocket ---
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

server.listen(3000, () => {
    console.log('HTTP server running on port 3000, serving client files.');
    console.log('Signaling server is also ready.');
});
