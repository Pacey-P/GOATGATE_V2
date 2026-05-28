const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

// ViGEm Gamepad Emulation Client
let ViGEmClient = null;
let vigemClientInstance = null;
let isVigemConnected = false;
try {
  ViGEmClient = require('vigemclient');
  vigemClientInstance = new ViGEmClient();
  vigemClientInstance.connect();
  isVigemConnected = true;
  console.log('[VIGEM] Connected to ViGEmBus successfully.');
} catch (e) {
  isVigemConnected = false;
  console.error('[VIGEM] Failed to initialize ViGEmClient:', e);
}

// Maps for virtual controllers
const virtualControllers = new Map(); // viewerId -> X360Controller
const viewerDpadStates = new Map(); // viewerId -> { up, down, left, right }


const API_SERVER = 'http://localhost:3001';
const TEMP_DIR = path.join(app.getPath('temp'), 'goatgate');

let authToken = null;
let loggedInUser = null;
let activeSessionId = null;
let appMode = 'social'; // 'social' or 'solo'

const http = require('http');
let loopbackServer = null;

function startLoopbackServer() {
  if (loopbackServer) return;
  
  loopbackServer = http.createServer((req, res) => {
    const urlObj = new URL(req.url, 'http://localhost:3002');
    if (urlObj.pathname === '/auth-callback') {
      const token = urlObj.searchParams.get('token');
      const userStr = urlObj.searchParams.get('user');
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; background: #0a0a0f; color: #e2e8f0; text-align: center; padding: 50px;">
            <h1 style="color: #8b5cf6;">Login Successful!</h1>
            <p>You can close this tab and return to the GOATGATE desktop app.</p>
          </body>
        </html>
      `);
      
      if (token && userStr) {
        const user = JSON.parse(decodeURIComponent(userStr));
        authToken = token;
        loggedInUser = user;
        
        if (mainWindow) {
          mainWindow.webContents.send('login-success', { token, user });
          mainWindow.webContents.send('log-message', `Logged in as ${user.name}`);
        }
      }
      
      setTimeout(() => {
        stopLoopbackServer();
      }, 1000);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  
  loopbackServer.listen(3002, () => {
    console.log('[AUTH] Loopback server listening on http://localhost:3002');
  });
}

function stopLoopbackServer() {
  if (loopbackServer) {
    loopbackServer.close();
    loopbackServer = null;
    console.log('[AUTH] Loopback server stopped.');
  }
}

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let mainWindow = null;
let streamProcess = null;
let dvrProcess = null;
let recordProcess = null;

let isStreaming = false;
let isDvrActive = false;
let isRecording = false;

let detectedEncoder = 'libx264';
let detectedAudioDevice = null;

function generateGateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

let gateCode = generateGateCode();

// Clean up directory helper
function cleanTempDir() {

  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      if (file.startsWith('dvr_') || file.startsWith('recording_') || file === 'dvr_list.txt' || file === 'concat_list.txt') {
        fs.unlinkSync(path.join(TEMP_DIR, file));
      }
    }
  } catch (e) {
    console.error("Failed to clean temp dir:", e);
  }
}

// 1. Detect GPU Encoder, Audio Device, and Open Windows
function getOpenWindows() {
  try {
    // Queries Windows processes with a non-empty window title
    const stdout = execSync('powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne \\"\\"} | Select-Object -ExpandProperty MainWindowTitle"', { encoding: 'utf8' });
    const titles = stdout.split('\r\n').map(t => t.trim()).filter(t => t.length > 0);
    return [...new Set(titles)]; // Remove duplicates
  } catch (e) {
    console.error("Failed to query open windows:", e);
    return [];
  }
}

function runDiagnostics() {
  // Detect GPU encoder
  try {
    const output = execSync('ffmpeg -encoders', { encoding: 'utf8' });
    if (output.includes('h264_nvenc')) {
      detectedEncoder = 'h264_nvenc';
    } else if (output.includes('h264_amf')) {
      detectedEncoder = 'h264_amf';
    } else if (output.includes('h264_mf')) {
      detectedEncoder = 'h264_mf';
    } else {
      detectedEncoder = 'libx264';
    }
  } catch (err) {
    console.error('Encoder detection failed, falling back to x264:', err);
    detectedEncoder = 'libx264';
  }

  // Detect DirectShow Audio Device
  try {
    execSync('ffmpeg -f dshow -list_devices true -i dummy', { stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr || '';
    const lines = stderr.split('\n');
    const audioDevices = [];
    for (let line of lines) {
      if (line.includes('(audio)')) {
        const match = line.match(/\"([^\"]+)\"/);
        if (match) {
          audioDevices.push(match[1]);
        }
      }
    }
    if (audioDevices.length > 0) {
      detectedAudioDevice = audioDevices[0];
    }
  }
  
  console.log(`[DIAGNOSTICS] Selected Encoder: ${detectedEncoder}`);
  console.log(`[DIAGNOSTICS] Selected Audio Device: ${detectedAudioDevice || 'None (Video Only)'}`);
}

// Helper to kill a spawned child process cleanly
function killProcess(proc) {
  if (proc) {
    try {
      proc.stdin.write('q'); // try ffmpeg friendly quit first
    } catch (e) {}
    setTimeout(() => {
      try {
        proc.kill('SIGINT');
      } catch (e) {
        try {
          proc.kill('SIGTERM');
        } catch (e2) {}
      }
    }, 500);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    useContentSize: true,
    icon: path.join(__dirname, 'logo.png'),
    title: "GOATGATE Desktop Gateway",
    resizable: false,
    frame: true,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 2. Desktop Capture Sources Handler
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
    }));
  } catch (err) {
    console.error("Failed to query capture sources:", err);
    return [];
  }
});


// 3. Start DVR Replay Buffer (rolling 10s chunks wrapped at 4 = 30-40s history)
function startDvr(windowTitle) {
  if (isDvrActive) return;
  cleanTempDir();

  const args = [];
  
  // Video input
  const ddaInput = windowTitle ? `ddagrab=framerate=60:window_title=${windowTitle}` : 'ddagrab=framerate=60';
  args.push('-f', 'lavfi', '-i', ddaInput);

  
  // Audio input
  if (detectedAudioDevice) {
    args.push('-f', 'dshow', '-i', `audio=${detectedAudioDevice}`);
  }

  // Encoding Video (VBR quality optimized)
  args.push('-c:v', detectedEncoder);
  if (detectedEncoder === 'h264_nvenc') {
    args.push('-preset', 'p3', '-rc', 'vbr', '-cq', '23');
  } else if (detectedEncoder === 'h264_amf') {
    args.push('-b:v', '4M');
  } else if (detectedEncoder === 'h264_mf') {
    args.push('-b:v', '4M');
  } else {
    args.push('-preset', 'superfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  }

  // Force keyframes at exactly 10s boundary (600 frames at 60fps) to make stitches clean
  args.push('-g', '60');

  // Encoding Audio
  if (detectedAudioDevice) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }


  // Segment output
  const listFile = path.join(TEMP_DIR, 'dvr_list.txt');
  const segmentPattern = path.join(TEMP_DIR, 'dvr_%03d.mp4');
  
  args.push(
    '-f', 'segment',
    '-segment_time', '10',
    '-segment_wrap', '4',
    '-segment_list', listFile,
    '-segment_list_size', '4',
    '-reset_timestamps', '1',
    '-y', segmentPattern
  );

  console.log(`[FFMPEG] Starting DVR: ffmpeg ${args.join(' ')}`);

  dvrProcess = spawn('ffmpeg', args, { detached: false });
  isDvrActive = true;
  updateUIState();

  dvrProcess.on('close', (code) => {
    console.log(`[FFMPEG] DVR process exited with code ${code}`);
    isDvrActive = false;
    dvrProcess = null;
    updateUIState();
  });
}

function stopDvr() {
  if (!isDvrActive) return;
  killProcess(dvrProcess);
}

// 4. Save DVR Clip (concat active chunks instantly and upload)
async function saveDvrClip(title, developer) {
  if (!isDvrActive) return;
  
  const listFile = path.join(TEMP_DIR, 'dvr_list.txt');
  if (!fs.existsSync(listFile)) {
    console.log('[DVR] List file does not exist yet. Please wait for segments to write.');
    return;
  }

  try {
    const content = fs.readFileSync(listFile, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
    
    if (lines.length === 0) {
      console.log('[DVR] No active segments recorded yet.');
      return;
    }

    console.log('[DVR] Splicing segments:', lines);

    // Write a safe concat manifest
    const concatManifestPath = path.join(TEMP_DIR, 'concat_list.txt');
    const manifestContent = lines
      .map(filename => `file '${path.join(TEMP_DIR, filename).replace(/\\/g, '/')}'`)
      .join('\n');
    fs.writeFileSync(concatManifestPath, manifestContent);

    // Execute zero-re-encoding concatenation
    const outputFilename = `dvr_clip_${Date.now()}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFilename);
    
    execSync(`ffmpeg -f concat -safe 0 -i "${concatManifestPath}" -c copy -y "${outputPath}"`);
    console.log('[DVR] Concat complete. Spliced file written to:', outputPath);

    // Upload to server
    await uploadFile(outputPath, outputFilename, title || '30s Replay Clip', developer, 'dvr', ['DVR Replay', 'Gameplay']);
    
    // Notify Renderer
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `DVR clip saved and uploaded successfully!`);
    }
  } catch (err) {
    console.error('[DVR] Failed to save DVR clip:', err);
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `DVR save failed: ${err.message}`);
    }
  }
}

// 5. Take Screenshot via ddagrab GPU capture
async function takeScreenshot(title, developer, windowTitle) {
  console.log('[SCREENSHOT] Snapping display...');
  const filename = `screenshot_${Date.now()}.png`;
  const outputPath = path.join(TEMP_DIR, filename);

  try {
    // Capture exactly 1 frame from ddagrab instantly
    const ddaInput = windowTitle ? `ddagrab=window_title=${windowTitle}` : 'ddagrab';
    execSync(`ffmpeg -f lavfi -i "${ddaInput}" -frames:v 1 -y "${outputPath}"`);
    console.log('[SCREENSHOT] Written to:', outputPath);

    // Upload
    await uploadFile(outputPath, filename, title || 'Development Screenshot', developer, 'screenshot');
    
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `Screenshot captured and uploaded!`);
    }
  } catch (err) {
    console.error('[SCREENSHOT] Failed to capture:', err);
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `Screenshot failed: ${err.message}`);
    }
  }
}

// 6. Toggle Manual Video Recording
function startRecording(title, developer, windowTitle) {
  if (isRecording) return;
  cleanTempDir();

  const filename = `recording_${Date.now()}.mp4`;
  const outputPath = path.join(TEMP_DIR, filename);
  
  const args = [];
  const ddaInput = windowTitle ? `ddagrab=framerate=60:window_title=${windowTitle}` : 'ddagrab=framerate=60';
  args.push('-f', 'lavfi', '-i', ddaInput);
  if (detectedAudioDevice) {
    args.push('-f', 'dshow', '-i', `audio=${detectedAudioDevice}`);
  }
  
  args.push('-c:v', detectedEncoder);
  if (detectedEncoder === 'h264_nvenc') {
    args.push('-preset', 'p3', '-rc', 'vbr', '-cq', '23');
  } else {
    args.push('-preset', 'superfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  }

  if (detectedAudioDevice) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }


  args.push('-y', outputPath);

  console.log(`[FFMPEG] Starting recording: ffmpeg ${args.join(' ')}`);

  recordProcess = spawn('ffmpeg', args, { detached: false });
  isRecording = true;
  updateUIState();

  recordProcess.on('close', async (code) => {
    console.log(`[FFMPEG] Recording process exited with code ${code}`);
    isRecording = false;
    recordProcess = null;
    updateUIState();

    if (fs.existsSync(outputPath)) {
      if (mainWindow) {
        mainWindow.webContents.send('log-message', `Recording complete. Uploading...`);
      }
      try {
        await uploadFile(outputPath, filename, title || 'Manual Recording Clip', developer, 'clip', ['Clip', 'Milestone']);
        if (mainWindow) {
          mainWindow.webContents.send('log-message', `Recording clip uploaded successfully!`);
        }
      } catch (err) {
        console.error('Failed to upload recording:', err);
        if (mainWindow) {
          mainWindow.webContents.send('log-message', `Upload failed: ${err.message}`);
        }
      }
    }
  });
}

function stopRecording() {
  if (!isRecording) return;
  killProcess(recordProcess);
}

// File Upload Helper
async function uploadFile(filePath, filename, title, developer, type, tags = ['Game Dev']) {
  const form = new FormData();
  form.append(type === 'screenshot' ? 'screenshot' : 'clip', fs.createReadStream(filePath));
  form.append('title', title);
  form.append('developer', developer);
  form.append('type', type);
  
  if (appMode === 'social') {
    form.append('gateCode', gateCode);
  } else {
    if (activeSessionId) {
      form.append('sessionId', activeSessionId);
    }
    form.append('isPublic', 'false');
  }

  form.append('tags', JSON.stringify(tags));

  const endpoint = type === 'screenshot' ? '/api/screenshots' : '/api/clips';
  
  const headers = {
    ...form.getHeaders()
  };
  
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  
  console.log(`[UPLOAD] Uploading to ${API_SERVER}${endpoint}...`);
  await axios.post(`${API_SERVER}${endpoint}`, form, {
    headers: headers,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  console.log('[UPLOAD] Upload complete.');
}

// UI State Updater
function updateUIState() {
  if (!mainWindow) return;
  mainWindow.webContents.send('state-updated', {
    isStreaming,
    isDvrActive,
    isRecording,
    detectedEncoder,
    detectedAudioDevice,
    gateCode,
    isVigemConnected
  });
}


// Register global keyboard hotkeys safely
function registerGlobalHotkeys() {
  globalShortcut.unregisterAll();

  // F10: Screenshot
  const f10Registered = globalShortcut.register('F10', () => {
    console.log('[HOTKEY] F10 Pressed (Screenshot)');
    if (mainWindow) {
      mainWindow.webContents.send('trigger-action', 'screenshot');
    }
  });

  // F11: Start/Stop Record
  const f11Registered = globalShortcut.register('F11', () => {
    console.log('[HOTKEY] F11 Pressed (Record Toggle)');
    if (mainWindow) {
      mainWindow.webContents.send('trigger-action', 'record-toggle');
    }
  });

  // F9: Save DVR Clip
  const f9Registered = globalShortcut.register('F9', () => {
    console.log('[HOTKEY] F9 Pressed (Save DVR Clip)');
    if (mainWindow) {
      mainWindow.webContents.send('trigger-action', 'dvr-save');
    }
  });

  console.log(`[HOTKEYS] F10 (Screenshot) registration status: ${f10Registered}`);
  console.log(`[HOTKEYS] F11 (Record) registration status: ${f11Registered}`);
  console.log(`[HOTKEYS] F9 (DVR Save) registration status: ${f9Registered}`);
}

// Lifecycle Handlers
app.whenReady().then(() => {
  runDiagnostics();
  createWindow();
  registerGlobalHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  
  // Disconnect any virtual gamepads
  disconnectAllControllers();
  
  // Terminate any active FFmpeg processes immediately
  stopDvr();
  stopRecording();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Virtual Gamepad Helpers
function getOrCreateController(viewerId) {
  if (!vigemClientInstance) return null;
  
  if (virtualControllers.has(viewerId)) {
    return virtualControllers.get(viewerId);
  }
  
  if (virtualControllers.size >= 4) {
    console.log(`[VIGEM] Max controller limit (4) reached. Cannot create controller for ${viewerId}`);
    return null;
  }
  
  try {
    console.log(`[VIGEM] Creating virtual Xbox 360 controller for viewer: ${viewerId}`);
    const controller = vigemClientInstance.createX360Controller();
    controller.connect();
    virtualControllers.set(viewerId, controller);
    viewerDpadStates.set(viewerId, { up: false, down: false, left: false, right: false });
    return controller;
  } catch (e) {
    console.error(`[VIGEM] Failed to create virtual controller:`, e);
    return null;
  }
}

function disconnectController(viewerId) {
  const controller = virtualControllers.get(viewerId);
  if (controller) {
    try {
      console.log(`[VIGEM] Disconnecting virtual controller for viewer: ${viewerId}`);
      controller.disconnect();
    } catch (e) {
      console.error(`[VIGEM] Error disconnecting controller:`, e);
    }
    virtualControllers.delete(viewerId);
    viewerDpadStates.delete(viewerId);
  }
}

function disconnectAllControllers() {
  console.log('[VIGEM] Disconnecting all virtual controllers...');
  virtualControllers.forEach((controller, viewerId) => {
    try {
      controller.disconnect();
    } catch (e) {}
  });
  virtualControllers.clear();
  viewerDpadStates.clear();
}

// IPC Communication
ipcMain.on('gamepad-input', (event, { viewerId, input }) => {
  const controller = getOrCreateController(viewerId);
  if (!controller) return;
  
  const { type, name, value } = input;
  
  try {
    if (type === 'button') {
      if (name.startsWith('DPAD_')) {
        let states = viewerDpadStates.get(viewerId);
        if (!states) {
          states = { up: false, down: false, left: false, right: false };
          viewerDpadStates.set(viewerId, states);
        }
        
        if (name === 'DPAD_UP') states.up = value;
        if (name === 'DPAD_DOWN') states.down = value;
        if (name === 'DPAD_LEFT') states.left = value;
        if (name === 'DPAD_RIGHT') states.right = value;
        
        const horz = states.right ? 1 : (states.left ? -1 : 0);
        const vert = states.up ? 1 : (states.down ? -1 : 0);
        
        controller.axis.dpadHorz.setValue(horz);
        controller.axis.dpadVert.setValue(vert);
      } else if (controller.button[name]) {
        controller.button[name].setValue(value);
      }
    } else if (type === 'axis') {
      if (controller.axis[name]) {
        controller.axis[name].setValue(value);
      }
    }
  } catch (err) {
    console.error(`[VIGEM] Error updating controller state for ${viewerId}:`, err);
  }
});

ipcMain.on('viewer-left', (event, { viewerId }) => {
  disconnectController(viewerId);
});

ipcMain.on('stop-all-gamepads', () => {
  disconnectAllControllers();
});

ipcMain.on('set-streaming-state', (event, state) => {
  isStreaming = state;
  updateUIState();
});

ipcMain.on('regenerate-gatecode', (event) => {
  gateCode = generateGateCode();
  updateUIState();
  event.reply('log-message', `Regenerated Room Gate Code: ${gateCode}`);
});


ipcMain.on('start-dvr', (event, { windowTitle }) => {
  startDvr(windowTitle);
});

ipcMain.on('stop-dvr', () => {
  stopDvr();
});

ipcMain.on('save-dvr-clip', (event, { title, developer }) => {
  saveDvrClip(title, developer);
});

ipcMain.on('take-screenshot', (event, { title, developer, windowTitle }) => {
  takeScreenshot(title, developer, windowTitle);
});

ipcMain.on('start-recording', (event, { title, developer, windowTitle }) => {
  startRecording(title, developer, windowTitle);
});

ipcMain.on('stop-recording', () => {
  stopRecording();
});

ipcMain.on('get-windows', (event) => {
  event.reply('windows-list', getOpenWindows());
});

ipcMain.on('get-state', (event) => {
  event.reply('state-updated', {
    isStreaming,
    isDvrActive,
    isRecording,
    detectedEncoder,
    detectedAudioDevice,
    gateCode,
    isVigemConnected,
    authToken,
    loggedInUser,
    activeSessionId,
    appMode
  });
});

ipcMain.on('start-login', () => {
  startLoopbackServer();
  const { shell } = require('electron');
  shell.openExternal(`${API_SERVER}/api/auth/google?clientType=desktop`);
});

ipcMain.on('logout', () => {
  authToken = null;
  loggedInUser = null;
  activeSessionId = null;
  if (mainWindow) {
    mainWindow.webContents.send('logout-success');
    mainWindow.webContents.send('log-message', 'Logged out.');
  }
});

ipcMain.on('set-mode', (event, mode) => {
  appMode = mode;
  console.log(`[MODE] Switched to ${mode}`);
});

ipcMain.on('create-session', async (event, { title }) => {
  if (!authToken) {
    event.reply('create-session-failed', 'Not authenticated');
    return;
  }
  try {
    const res = await axios.post(`${API_SERVER}/api/devlogs`, { title }, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    activeSessionId = res.data.id;
    event.reply('create-session-success', res.data);
    mainWindow.webContents.send('log-message', `Devlog session started: ${res.data.title}`);
  } catch (err) {
    console.error('Failed to create devlog session:', err);
    event.reply('create-session-failed', err.message);
  }
});

ipcMain.on('end-session', (event) => {
  activeSessionId = null;
  event.reply('session-ended');
  mainWindow.webContents.send('log-message', 'Devlog session ended.');
});
