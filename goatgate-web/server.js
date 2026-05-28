import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create uploads directory if it doesn't exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const id = uuidv4();
    cb(null, `${file.fieldname}-${id}${ext}`);
  }
});
const upload = multer({ storage });

// REST API Endpoints

// Get all clips
app.get('/api/clips', (req, res) => {
  res.json(db.getClips());
});

// Upload clip
app.post('/api/clips', upload.single('clip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No clip file uploaded' });
  }
  
  const title = req.body.title || 'Untitled Clip';
  const developer = req.body.developer || 'Developer';
  const type = req.body.type || 'clip'; 
  const gateCode = (req.body.gateCode || '').toUpperCase();
  
  const newClip = {
    id: uuidv4(),
    title,
    developer,
    type,
    gateCode,
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
    createdAt: new Date().toISOString(),
    tags: req.body.tags ? JSON.parse(req.body.tags) : ['Game Dev']
  };
  
  db.saveClip(newClip);
  
  broadcastToAll({
    type: 'CLIP_UPLOADED',
    clip: newClip
  });
  
  res.json(newClip);
});

// Get all screenshots
app.get('/api/screenshots', (req, res) => {
  res.json(db.getScreenshots());
});

// Upload screenshot
app.post('/api/screenshots', upload.single('screenshot'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No screenshot file uploaded' });
  }
  
  const title = req.body.title || 'Untitled Screenshot';
  const developer = req.body.developer || 'Developer';
  const gateCode = (req.body.gateCode || '').toUpperCase();
  
  const newScreenshot = {
    id: uuidv4(),
    title,
    developer,
    gateCode,
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
    createdAt: new Date().toISOString(),
    tags: req.body.tags ? JSON.parse(req.body.tags) : ['Screenshot']
  };
  
  db.saveScreenshot(newScreenshot);
  
  broadcastToAll({
    type: 'SCREENSHOT_UPLOADED',
    screenshot: newScreenshot
  });
  
  res.json(newScreenshot);
});

// Get all active streams/gates
app.get('/api/gates/live', (req, res) => {
  res.json(db.getLiveGates());
});

// Get single gate info
app.get('/api/gates/:gateCode', (req, res) => {
  const gate = db.getGate(req.params.gateCode);
  if (!gate) {
    return res.status(404).json({ error: 'Gate not found' });
  }
  res.json(gate);
});

// Serve static client build if it exists (production build)
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Setup HTTP & WebSocket Server
const HTTP_PORT = process.env.PORT || 3001;
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Maps to track active WebSockets and metadata
const socketMap = new Map(); // key: clientId (UUID), value: ws
const clientMetadata = new Map(); // key: ws, value: { clientId, gateCode, user, isHost }

// Tracks hosts by gate code
const gateHosts = new Map(); // key: GATE_CODE, value: clientId

function broadcastToAll(messageObj) {
  const payload = JSON.stringify(messageObj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastLobbyData() {
  const payload = JSON.stringify({
    type: 'LOBBY_UPDATE',
    liveGates: db.getLiveGates()
  });
  wss.clients.forEach(client => {
    const meta = clientMetadata.get(client);
    if (!meta || !meta.gateCode || meta.isHost) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });
}

function broadcastToRoom(gateCode, messageObj) {
  const payload = JSON.stringify(messageObj);
  const code = gateCode.toUpperCase();
  wss.clients.forEach(client => {
    const meta = clientMetadata.get(client);
    if (meta && meta.gateCode === code && !meta.isHost && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function updateRoomViewerCount(gateCode) {
  const code = gateCode.toUpperCase();
  let count = 0;
  wss.clients.forEach(client => {
    const meta = clientMetadata.get(client);
    if (meta && meta.gateCode === code && !meta.isHost) {
      count++;
    }
  });

  const updatedState = db.updateGateState(code, { viewerCount: count });
  
  broadcastToRoom(code, {
    type: 'VIEWER_COUNT_UPDATED',
    gateCode: code,
    viewerCount: count,
    streamState: updatedState
  });

  broadcastLobbyData();
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  socketMap.set(clientId, ws);
  clientMetadata.set(ws, { clientId, gateCode: null, user: null, isHost: false });

  // Send initial landing page data (active gates list, global clips/screenshots)
  ws.send(JSON.stringify({
    type: 'INIT_LOBBY',
    liveGates: db.getLiveGates(),
    clips: db.getClips(),
    screenshots: db.getScreenshots()
  }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      
      // 1. Host Registration (Desktop client registering stream room)
      if (parsed.type === 'REGISTER_HOST') {
        const code = parsed.gateCode.toUpperCase();
        const devName = parsed.developer || 'SoloDev';
        const title = parsed.title || 'GOATGATE Stream';
        
        console.log(`[HOST] Registering gate host ${code} (client: ${clientId})`);
        
        gateHosts.set(code, clientId);
        clientMetadata.set(ws, { clientId, gateCode: code, user: devName, isHost: true });

        // Update database
        const state = db.registerGate(code, title, devName);
        db.updateGateState(code, { isLive: true, startedAt: new Date().toISOString() });

        ws.send(JSON.stringify({
          type: 'HOST_REGISTERED',
          gateCode: code
        }));

        broadcastLobbyData();
      }

      // 2. Viewer Join Gate Room
      else if (parsed.type === 'JOIN_GATE') {
        const code = parsed.gateCode.toUpperCase();
        const username = parsed.user || 'DevGuest';
        
        console.log(`[VIEWER] Client ${clientId} joining gate ${code}`);
        clientMetadata.set(ws, { clientId, gateCode: code, user: username, isHost: false });
        
        // Send initial room chat history and gate state
        ws.send(JSON.stringify({
          type: 'INIT_ROOM_DATA',
          gateCode: code,
          streamState: db.getGate(code),
          chat: db.getChatMessages(code)
        }));

        updateRoomViewerCount(code);

        // Notify the gate's host that a new viewer wants WebRTC streaming
        const hostId = gateHosts.get(code);
        if (hostId) {
          const hostSocket = socketMap.get(hostId);
          if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
            hostSocket.send(JSON.stringify({
              type: 'VIEWER_JOINED',
              viewerId: clientId,
              user: username
            }));
          }
        }
      } 
      
      // 3. WebRTC Signaling Forwarding (Offer, Answer, ICE Candidates)
      else if (parsed.type === 'RTC_SIGNAL') {
        const targetId = parsed.targetId;
        const targetSocket = socketMap.get(targetId);
        if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
          targetSocket.send(JSON.stringify({
            type: 'RTC_SIGNAL',
            senderId: clientId,
            signal: parsed.signal
          }));
        }
      }
      
      // 3b. Gamepad Input Forwarding to Host
      else if (parsed.type === 'GAMEPAD_INPUT') {
        const meta = clientMetadata.get(ws);
        if (meta && meta.gateCode) {
          const hostId = gateHosts.get(meta.gateCode);
          if (hostId) {
            const hostSocket = socketMap.get(hostId);
            if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
              hostSocket.send(JSON.stringify({
                type: 'GAMEPAD_INPUT',
                senderId: clientId,
                input: parsed.input
              }));
            }
          }
        }
      }

      // 4. Viewer Leaving Gate
      else if (parsed.type === 'LEAVE_GATE') {
        const meta = clientMetadata.get(ws);
        if (meta && meta.gateCode) {
          const oldCode = meta.gateCode;
          
          // Notify Host that this viewer left so they can clean up PeerConnection
          const hostId = gateHosts.get(oldCode);
          if (hostId) {
            const hostSocket = socketMap.get(hostId);
            if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
              hostSocket.send(JSON.stringify({
                type: 'VIEWER_LEFT',
                viewerId: clientId
              }));
            }
          }

          clientMetadata.set(ws, { clientId, gateCode: null, user: null, isHost: false });
          updateRoomViewerCount(oldCode);
        }
        
        ws.send(JSON.stringify({
          type: 'INIT_LOBBY',
          liveGates: db.getLiveGates(),
          clips: db.getClips(),
          screenshots: db.getScreenshots()
        }));
      }
      
      // 5. Chat Messages (Room isolated)
      else if (parsed.type === 'CHAT_MESSAGE') {
        const meta = clientMetadata.get(ws);
        if (meta && meta.gateCode) {
          const chatMsg = {
            id: uuidv4(),
            user: meta.user || 'DevGuest',
            message: parsed.message,
            timestamp: new Date().toISOString(),
            isSystem: false
          };
          db.addChatMessage(meta.gateCode, chatMsg);
          
          // Broadcast to all viewers and host in the same gate room
          const code = meta.gateCode;
          const payload = JSON.stringify({
            type: 'NEW_CHAT_MESSAGE',
            gateCode: code,
            chat: chatMsg
          });
          
          wss.clients.forEach(client => {
            const m = clientMetadata.get(client);
            if (m && m.gateCode === code && client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        }
      }
    } catch (e) {
      console.error("Failed to parse WS message:", e);
    }
  });

  ws.on('close', () => {
    socketMap.delete(clientId);
    const meta = clientMetadata.get(ws);
    
    if (meta) {
      const code = meta.gateCode;
      
      if (meta.isHost) {
        // If host disconnected, close the gate
        console.log(`[HOST] Host ${code} closed connection. Shutting down gate.`);
        gateHosts.delete(code);
        db.updateGateState(code, { isLive: false, startedAt: null });
        
        // Notify all viewers in this gate that the stream ended
        broadcastToRoom(code, {
          type: 'STREAM_STATE_UPDATED',
          gateCode: code,
          streamState: { isLive: false }
        });
        
        // Clear all viewers' room bindings
        wss.clients.forEach(client => {
          const m = clientMetadata.get(client);
          if (m && m.gateCode === code && !m.isHost) {
            clientMetadata.set(client, { clientId: m.clientId, gateCode: null, user: null, isHost: false });
          }
        });

        broadcastLobbyData();
      } else if (code) {
        // If viewer disconnected, notify host to clean up WebRTC
        const hostId = gateHosts.get(code);
        if (hostId) {
          const hostSocket = socketMap.get(hostId);
          if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
            hostSocket.send(JSON.stringify({
              type: 'VIEWER_LEFT',
              viewerId: clientId
            }));
          }
        }
        updateRoomViewerCount(code);
      }
    }
    clientMetadata.delete(ws);
  });
});

// Start API & WebSocket server
httpServer.listen(HTTP_PORT, () => {
  console.log(`[API] GOATGATE server listening on http://localhost:${HTTP_PORT}`);
  console.log(`[WS] WebSocket server bound to same port (handling WebRTC signaling)`);
});
