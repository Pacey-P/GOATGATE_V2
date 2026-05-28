import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'database.json');

const defaultData = {
  users: {},
  devlogSessions: {},
  clips: [],
  screenshots: [],
  gates: {},       // key: GATE_CODE (uppercase), value: { title, developer, isLive, viewerCount, startedAt }
  chatRooms: {}    // key: GATE_CODE, value: [ { id, user, message, timestamp } ]
};

function writeData(data) {
  try {
    const tempFile = DB_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error("Failed to write to database atomically:", err);
  }
}

export function getDb() {
  if (!fs.existsSync(DB_FILE)) {
    writeData(defaultData);
    return defaultData;
  }
  try {
    const content = fs.readFileSync(DB_FILE, 'utf-8');
    const data = JSON.parse(content);
    
    // Auto-migration for schema changes
    let migrated = false;
    if (!data.gates) {
      data.gates = {};
      migrated = true;
    }
    if (!data.chatRooms) {
      data.chatRooms = {};
      migrated = true;
    }
    if (!data.clips) {
      data.clips = [];
      migrated = true;
    }
    if (!data.screenshots) {
      data.screenshots = [];
      migrated = true;
    }
    if (!data.users) {
      data.users = {};
      migrated = true;
    }
    if (!data.devlogSessions) {
      data.devlogSessions = {};
      migrated = true;
    }
    
    // Migrate items
    if (data.clips) {
      data.clips.forEach(clip => {
        if (clip.isPublic === undefined) {
          clip.isPublic = true;
          migrated = true;
        }
        if (clip.userId === undefined) {
          clip.userId = null;
          migrated = true;
        }
        if (clip.sessionId === undefined) {
          clip.sessionId = null;
          migrated = true;
        }
        if (clip.isArchived === undefined) {
          clip.isArchived = false;
          migrated = true;
        }
      });
    }
    if (data.screenshots) {
      data.screenshots.forEach(snap => {
        if (snap.isPublic === undefined) {
          snap.isPublic = true;
          migrated = true;
        }
        if (snap.userId === undefined) {
          snap.userId = null;
          migrated = true;
        }
        if (snap.sessionId === undefined) {
          snap.sessionId = null;
          migrated = true;
        }
        if (snap.isArchived === undefined) {
          snap.isArchived = false;
          migrated = true;
        }
      });
    }
    
    if (migrated) {
      console.log("[DB] Migrated database.json to user/session relational schema.");
      writeData(data);
    }
    
    return data;
  } catch (err) {
    console.error("Failed to read database. Restoring defaults:", err);
    return defaultData;
  }
}

// User Operations
export function upsertUser(googleId, email, name) {
  const db = getDb();
  let userId = Object.keys(db.users).find(id => db.users[id].googleId === googleId);
  if (userId) {
    db.users[userId].email = email;
    db.users[userId].name = name;
  } else {
    userId = crypto.randomUUID();
    db.users[userId] = {
      googleId,
      email,
      name,
      outstandApiKey: ""
    };
  }
  writeData(db);
  return { id: userId, ...db.users[userId] };
}

export function updateUserOutstandKey(userId, apiKey) {
  const db = getDb();
  if (db.users[userId]) {
    db.users[userId].outstandApiKey = apiKey;
    writeData(db);
    return true;
  }
  return false;
}

export function getUser(userId) {
  const db = getDb();
  if (db.users[userId]) {
    return { id: userId, ...db.users[userId] };
  }
  return null;
}

// Devlog Session Operations
export function createDevlogSession(userId, title) {
  const db = getDb();
  const sessionId = crypto.randomUUID();
  
  let formattedTitle = title ? title.trim() : "";
  if (!formattedTitle) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);
    formattedTitle = `Devlog - ${dateStr} - ${timeStr}`;
  }
  
  db.devlogSessions[sessionId] = {
    userId,
    title: formattedTitle,
    createdAt: new Date().toISOString()
  };
  writeData(db);
  return { id: sessionId, ...db.devlogSessions[sessionId] };
}

export function getDevlogSessions(userId) {
  const db = getDb();
  const sessions = [];
  for (const [id, session] of Object.entries(db.devlogSessions)) {
    if (session.userId === userId) {
      sessions.push({ id, ...session });
    }
  }
  sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sessions;
}

export function getDevlogSession(sessionId) {
  const db = getDb();
  return db.devlogSessions[sessionId] || null;
}

export function publishToGoatFeed(mediaId, mediaType) {
  const db = getDb();
  let found = null;
  if (mediaType === 'video' || mediaType === 'clip' || mediaType === 'dvr') {
    found = db.clips.find(c => c.id === mediaId);
  } else if (mediaType === 'image' || mediaType === 'screenshot') {
    found = db.screenshots.find(s => s.id === mediaId);
  }
  
  if (found) {
    found.isPublic = true;
    writeData(db);
    return found;
  }
  return null;
}

export function saveClip(clip) {
  const db = getDb();
  db.clips.unshift(clip);
  writeData(db);
  return clip;
}

export function getClips() {
  return getDb().clips;
}

export function saveScreenshot(screenshot) {
  const db = getDb();
  db.screenshots.unshift(screenshot);
  writeData(db);
  return screenshot;
}

export function getScreenshots() {
  return getDb().screenshots;
}

// Gate Operations
export function registerGate(gateCode, title, developer) {
  const db = getDb();
  const code = gateCode.toUpperCase();
  
  if (!db.gates[code]) {
    db.gates[code] = {
      isLive: false,
      viewerCount: 0,
      startedAt: null
    };
  }
  
  db.gates[code].title = title;
  db.gates[code].developer = developer;
  
  writeData(db);
  return db.gates[code];
}

export function getGate(gateCode) {
  const db = getDb();
  const code = gateCode.toUpperCase();
  return db.gates[code] || null;
}

export function getLiveGates() {
  const db = getDb();
  const live = {};
  for (const [code, info] of Object.entries(db.gates)) {
    if (info.isLive) {
      live[code] = info;
    }
  }
  return live;
}

export function updateGateState(gateCode, stateUpdates) {
  const db = getDb();
  const code = gateCode.toUpperCase();
  
  if (!db.gates[code]) {
    db.gates[code] = {
      title: "Untitled Gate",
      developer: "Unknown Dev",
      isLive: false,
      viewerCount: 0,
      startedAt: null
    };
  }
  
  db.gates[code] = { ...db.gates[code], ...stateUpdates };
  writeData(db);
  return db.gates[code];
}

// Chat Room Operations
export function addChatMessage(gateCode, msg) {
  const db = getDb();
  const code = gateCode.toUpperCase();
  
  if (!db.chatRooms[code]) {
    db.chatRooms[code] = [];
  }
  
  db.chatRooms[code].push(msg);
  
  if (db.chatRooms[code].length > 100) {
    db.chatRooms[code].shift();
  }
  
  writeData(db);
  return msg;
}

export function getChatMessages(gateCode) {
  const db = getDb();
  const code = gateCode.toUpperCase();
  return db.chatRooms[code] || [];
}

export function deleteMediaItem(mediaId, mediaType) {
  const db = getDb();
  let found = null;
  let index = -1;
  
  if (mediaType === 'video' || mediaType === 'clip' || mediaType === 'dvr') {
    index = db.clips.findIndex(c => c.id === mediaId);
    if (index !== -1) {
      found = db.clips[index];
      db.clips.splice(index, 1);
    }
  } else if (mediaType === 'image' || mediaType === 'screenshot') {
    index = db.screenshots.findIndex(s => s.id === mediaId);
    if (index !== -1) {
      found = db.screenshots[index];
      db.screenshots.splice(index, 1);
    }
  }
  
  if (found) {
    writeData(db);
    return found;
  }
  return null;
}

export function archiveMediaItem(mediaId, mediaType, shouldArchive) {
  const db = getDb();
  let found = null;
  if (mediaType === 'video' || mediaType === 'clip' || mediaType === 'dvr') {
    found = db.clips.find(c => c.id === mediaId);
  } else if (mediaType === 'image' || mediaType === 'screenshot') {
    found = db.screenshots.find(s => s.id === mediaId);
  }
  
  if (found) {
    found.isArchived = shouldArchive;
    writeData(db);
    return found;
  }
  return null;
}

export function upgradeGuestUser(guestToken, authenticatedUserId) {
  const db = getDb();
  let upgradedCount = 0;
  
  // Upgrade devlog sessions
  for (const id of Object.keys(db.devlogSessions)) {
    if (db.devlogSessions[id].userId === guestToken) {
      db.devlogSessions[id].userId = authenticatedUserId;
      upgradedCount++;
    }
  }
  
  // Upgrade clips
  db.clips.forEach(clip => {
    if (clip.userId === guestToken) {
      clip.userId = authenticatedUserId;
      upgradedCount++;
    }
  });
  
  // Upgrade screenshots
  db.screenshots.forEach(snap => {
    if (snap.userId === guestToken) {
      snap.userId = authenticatedUserId;
      upgradedCount++;
    }
  });
  
  if (upgradedCount > 0) {
    writeData(db);
    console.log(`[DB] Upgraded ${upgradedCount} guest items from ${guestToken} to ${authenticatedUserId}`);
  }
  return upgradedCount;
}

// Reset live states on startup/module load
try {
  const db = getDb();
  let modified = false;
  for (const code of Object.keys(db.gates)) {
    if (db.gates[code].isLive || db.gates[code].viewerCount > 0) {
      db.gates[code].isLive = false;
      db.gates[code].viewerCount = 0;
      db.gates[code].startedAt = null;
      modified = true;
    }
  }
  if (modified) {
    writeData(db);
    console.log("[DB] Reset all gate live states on startup.");
  }
} catch (e) {
  console.error("[DB] Failed to reset live states on startup:", e);
}
