import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'database.json');

const defaultData = {
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
    
    if (migrated) {
      console.log("[DB] Migrated database.json to room-based schema.");
      writeData(data);
    }
    
    return data;
  } catch (err) {
    console.error("Failed to read database. Restoring defaults:", err);
    return defaultData;
  }
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
