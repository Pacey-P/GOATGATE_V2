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
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'goatgate-secret-key-12345';

function base64url(str, encoding = 'utf8') {
  return Buffer.from(str, encoding).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return Buffer.from(str, 'base64').toString('utf8');
}

function signToken(payload) {
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const payloadStr = JSON.stringify(payload);
  const part1 = base64url(header) + '.' + base64url(payloadStr);
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(part1).digest('base64');
  return part1 + '.' + base64url(signature, 'base64');
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const part1 = headerB64 + '.' + payloadB64;
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(part1).digest('base64');
    const expectedSignatureB64 = base64url(signature, 'base64');
    if (signatureB64 !== expectedSignatureB64) return null;
    return JSON.parse(base64urlDecode(payloadB64));
  } catch (e) {
    return null;
  }
}

function optionalAuthenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    const userPayload = verifyToken(token);
    if (userPayload) {
      req.userId = userPayload.userId;
    }
  }
  next();
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access token missing' });
  }
  const userPayload = verifyToken(token);
  if (!userPayload) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.userId = userPayload.userId;
  next();
}

const lastPublishTimes = new Map();
function publishRateLimiter(req, res, next) {
  const userId = req.userId;
  const now = Date.now();
  if (lastPublishTimes.has(userId)) {
    const elapsed = now - lastPublishTimes.get(userId);
    if (elapsed < 5000) {
      return res.status(429).json({ error: `Too many requests. Please wait ${((5000 - elapsed) / 1000).toFixed(1)}s before sharing again.` });
    }
  }
  lastPublishTimes.set(userId, now);
  next();
}

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

// Get all clips (public only)
app.get('/api/clips', (req, res) => {
  res.json(db.getClips().filter(c => c.isPublic));
});

// Upload clip
app.post('/api/clips', optionalAuthenticateToken, upload.single('clip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No clip file uploaded' });
  }
  
  const title = req.body.title || 'Untitled Clip';
  const developer = req.body.developer || 'Developer';
  const type = req.body.type || 'clip'; 
  const gateCode = (req.body.gateCode || '').toUpperCase();
  const userId = req.userId || null;
  const sessionId = req.body.sessionId || null;
  
  let isPublic = true;
  if (req.body.isPublic !== undefined) {
    isPublic = req.body.isPublic === 'true';
  } else if (sessionId) {
    isPublic = false;
  }
  
  const newClip = {
    id: uuidv4(),
    title,
    developer,
    type,
    gateCode,
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
    createdAt: new Date().toISOString(),
    tags: req.body.tags ? JSON.parse(req.body.tags) : ['Game Dev'],
    userId,
    sessionId,
    isPublic
  };
  
  db.saveClip(newClip);
  
  if (isPublic) {
    broadcastToAll({
      type: 'CLIP_UPLOADED',
      clip: newClip
    });
  }
  
  res.json(newClip);
});

// Get all screenshots (public only)
app.get('/api/screenshots', (req, res) => {
  res.json(db.getScreenshots().filter(s => s.isPublic));
});

// Upload screenshot
app.post('/api/screenshots', optionalAuthenticateToken, upload.single('screenshot'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No screenshot file uploaded' });
  }
  
  const title = req.body.title || 'Untitled Screenshot';
  const developer = req.body.developer || 'Developer';
  const gateCode = (req.body.gateCode || '').toUpperCase();
  const userId = req.userId || null;
  const sessionId = req.body.sessionId || null;
  
  let isPublic = true;
  if (req.body.isPublic !== undefined) {
    isPublic = req.body.isPublic === 'true';
  } else if (sessionId) {
    isPublic = false;
  }
  
  const newScreenshot = {
    id: uuidv4(),
    title,
    developer,
    gateCode,
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
    createdAt: new Date().toISOString(),
    tags: req.body.tags ? JSON.parse(req.body.tags) : ['Screenshot'],
    userId,
    sessionId,
    isPublic
  };
  
  db.saveScreenshot(newScreenshot);
  
  if (isPublic) {
    broadcastToAll({
      type: 'SCREENSHOT_UPLOADED',
      screenshot: newScreenshot
    });
  }
  
  res.json(newScreenshot);
});

// Auth Routes
app.get('/api/auth/google', (req, res) => {
  const clientType = req.query.clientType || 'web';
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  
  if (!GOOGLE_CLIENT_ID) {
    // Fall back to Mock Login callback
    return res.redirect(`/api/auth/google/callback?mock=true&clientType=${clientType}`);
  }
  
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + 
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=openid%20profile%20email&` +
    `state=${clientType}`;
  
  res.redirect(googleAuthUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, mock } = req.query;
  const clientType = state || req.query.clientType || 'web';
  
  let googleId, email, name;
  
  if (mock === 'true' || !process.env.GOOGLE_CLIENT_ID) {
    googleId = "mock_google_12345";
    email = "mock.developer@goatgate.app";
    name = "Mock Developer";
  } else {
    try {
      const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
      const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
      
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenRes.json();
      
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = await userRes.json();
      
      googleId = profile.sub;
      email = profile.email;
      name = profile.name || profile.given_name || "Google User";
    } catch (err) {
      console.error("Google Auth exchange failed, falling back to mock:", err);
      googleId = "mock_google_12345";
      email = "mock.developer@goatgate.app";
      name = "Mock Developer";
    }
  }
  
  const user = db.upsertUser(googleId, email, name);
  const token = signToken({ userId: user.id, email: user.email });
  const encodedUser = encodeURIComponent(JSON.stringify(user));
  
  if (clientType === 'desktop') {
    res.redirect(`http://localhost:3002/auth-callback?token=${token}&user=${encodedUser}`);
  } else {
    res.redirect(`/?token=${token}&user=${encodedUser}`);
  }
});

app.post('/api/users/outstand-key', authenticateToken, (req, res) => {
  const { apiKey } = req.body;
  if (apiKey === undefined) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  db.updateUserOutstandKey(req.userId, apiKey);
  res.json({ success: true });
});

// Devlog Sessions Routes
app.get('/api/devlogs', authenticateToken, (req, res) => {
  res.json(db.getDevlogSessions(req.userId));
});

app.post('/api/devlogs', authenticateToken, (req, res) => {
  const { title } = req.body;
  const session = db.createDevlogSession(req.userId, title);
  res.json(session);
});

app.get('/api/devlogs/media', authenticateToken, (req, res) => {
  const userClips = db.getClips().filter(c => c.userId === req.userId);
  const userSnaps = db.getScreenshots().filter(s => s.userId === req.userId);
  
  const combined = [
    ...userClips.map(c => ({ ...c, mediaType: 'video' })),
    ...userSnaps.map(s => ({ ...s, mediaType: 'image' }))
  ];
  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(combined);
});

// Public GoatFeed Routes
app.get('/api/feed/public', (req, res) => {
  const publicClips = db.getClips().filter(c => c.isPublic).map(c => ({ ...c, mediaType: 'video' }));
  const publicSnaps = db.getScreenshots().filter(s => s.isPublic).map(s => ({ ...s, mediaType: 'image' }));
  const combined = [...publicClips, ...publicSnaps];
  combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(combined);
});

app.post('/api/feed/publish', authenticateToken, (req, res) => {
  const { mediaId, mediaType } = req.body;
  if (!mediaId || !mediaType) {
    return res.status(400).json({ error: 'Missing mediaId or mediaType' });
  }
  const updated = db.publishToGoatFeed(mediaId, mediaType);
  if (updated) {
    broadcastToAll({
      type: mediaType === 'image' || mediaType === 'screenshot' ? 'SCREENSHOT_UPLOADED' : 'CLIP_UPLOADED',
      [mediaType === 'image' || mediaType === 'screenshot' ? 'screenshot' : 'clip']: updated
    });
    res.json({ success: true, media: updated });
  } else {
    res.status(404).json({ error: 'Media item not found' });
  }
});

// Social media publishing via Outstand.so
app.post('/api/socials/publish', authenticateToken, publishRateLimiter, async (req, res) => {
  const { mediaUrl, text, platforms } = req.body;
  if (!mediaUrl || !text || !platforms || !Array.isArray(platforms)) {
    return res.status(400).json({ error: 'Missing mediaUrl, text, or platforms' });
  }
  
  const user = db.getUser(req.userId);
  if (!user || !user.outstandApiKey) {
    return res.status(400).json({ error: 'Outstand.so API Key not configured. Please add your key in the settings panel.' });
  }
  
  const apiKey = user.outstandApiKey;
  
  if (apiKey === 'mock_key' || apiKey.startsWith('mock_')) {
    console.log(`[MOCK OUTSTAND] Publishing to platforms: ${platforms.join(', ')}`);
    console.log(`[MOCK OUTSTAND] Content: "${text}" | Media: ${mediaUrl}`);
    return res.json({ success: true, message: 'Successfully published to socials (MOCK)' });
  }
  
  try {
    const outstandResponse = await fetch('https://api.outstand.so/v1/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: text,
        mediaUrls: [mediaUrl],
        platforms: platforms
      })
    });
    
    if (!outstandResponse.ok) {
      const errorText = await outstandResponse.text();
      return res.status(outstandResponse.status).json({ error: `Outstand API Error: ${errorText}` });
    }
    
    const result = await outstandResponse.json();
    res.json({ success: true, result });
  } catch (err) {
    console.error('[OUTSTAND] Publish error:', err);
    res.status(500).json({ error: `Internal Server Error: ${err.message}` });
  }
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
    clips: db.getClips().filter(c => c.isPublic),
    screenshots: db.getScreenshots().filter(s => s.isPublic)
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
          clips: db.getClips().filter(c => c.isPublic),
          screenshots: db.getScreenshots().filter(s => s.isPublic)
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
