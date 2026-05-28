const { ipcRenderer, shell } = require('electron');

// DOM Elements
const devNameInput = document.getElementById('dev-name');
const streamTitleInput = document.getElementById('stream-title');
const windowPicker = document.getElementById('window-picker');
const btnRefreshWindows = document.getElementById('btn-refresh-windows');
const gateCodeDisplay = document.getElementById('gate-code-display');
const btnRegenCode = document.getElementById('btn-regen-code');

const btnStream = document.getElementById('btn-stream');
const btnDvr = document.getElementById('btn-dvr');
const btnDvrSave = document.getElementById('btn-dvr-save');
const btnRecord = document.getElementById('btn-record');
const btnScreenshot = document.getElementById('btn-screenshot');

const overallStatus = document.getElementById('overall-status');
const streamBadge = document.getElementById('stream-badge');
const dvrBadge = document.getElementById('dvr-badge');

const encoderDiagnostic = document.getElementById('encoder-name');
const audioDiagnostic = document.getElementById('audio-device');
const terminalLogs = document.getElementById('terminal-logs');

// Chat DOM Elements
const hostChatCard = document.getElementById('host-chat-card');
const hostChatMessages = document.getElementById('host-chat-messages');
const hostChatInput = document.getElementById('host-chat-input');
const hostChatForm = document.getElementById('host-chat-form');
const chatCountBadge = document.getElementById('chat-count');

// Settings Card and Active Stream Banner DOM Elements
const settingsSection = document.getElementById('settings-section');
const streamInfoBanner = document.getElementById('stream-info-banner');
const streamInfoText = document.getElementById('stream-info-text');
const streamInfoCode = document.getElementById('stream-info-code');

// ViGEm status elements
const vigemStatusWarning = document.getElementById('vigem-status-warning');
const vigemDownloadLink = document.getElementById('vigem-download-link');
const vigemStatus = document.getElementById('vigem-status');

// Chat Message Appender Helper
function appendHostChatMessage(user, message) {
  if (hostChatMessages.innerText.includes('Chat will appear') || hostChatMessages.innerText.includes('Connected. No messages yet.')) {
    hostChatMessages.innerHTML = '';
  }
  
  const msgDiv = document.createElement('div');
  msgDiv.style.marginBottom = '4px';
  msgDiv.style.lineHeight = '1.3';
  msgDiv.style.wordBreak = 'break-all';
  
  const userSpan = document.createElement('strong');
  userSpan.innerText = `${user}: `;
  userSpan.style.color = 'var(--purple-accent)';
  userSpan.style.marginRight = '4px';
  
  const textSpan = document.createElement('span');
  textSpan.innerText = message;
  textSpan.style.color = '#e2e8f0';
  
  msgDiv.appendChild(userSpan);
  msgDiv.appendChild(textSpan);
  hostChatMessages.appendChild(msgDiv);
  
  hostChatMessages.scrollTop = hostChatMessages.scrollHeight;
}

// App variables matching main process
let isStreamingActive = false;
let isDvrActive = false;
let isRecordingActive = false;
let currentGateCode = '';
let localStream = null;
let ws = null;
const peerConnections = new Map(); // viewerId -> RTCPeerConnection

// Logger function
function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${msg}`;
  terminalLogs.innerText += `\n${line}`;
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// WebRTC Host Stream Control Functions
async function startWebRTCStream() {
  const title = streamTitleInput.value.trim() || 'GOATGATE Live Stream';
  const developer = devNameInput.value.trim() || 'SoloDev';
  const windowTitle = windowPicker.value;

  if (!currentGateCode) {
    log('Error: Room Gate Code not set yet.');
    return;
  }

  log(`Starting stream on "${windowTitle || 'Entire Desktop'}": "${title}"...`);

  try {
    log('Retrieving capture sources...');
    const sources = await ipcRenderer.invoke('get-sources');
    
    let targetSource = null;
    if (windowTitle) {
      // Find window matching selected title
      targetSource = sources.find(s => s.name === windowTitle);
      if (!targetSource) {
        // Try loose matching
        targetSource = sources.find(s => s.name.toLowerCase().includes(windowTitle.toLowerCase()));
      }
    }
    
    if (!targetSource) {
      // Fallback to screen
      targetSource = sources.find(s => s.id.startsWith('screen') || s.name.toLowerCase().includes('screen') || s.name.toLowerCase().includes('entire'));
    }
    
    if (!targetSource && sources.length > 0) {
      targetSource = sources[0];
    }
    
    if (!targetSource) {
      throw new Error('No capture sources found.');
    }
    
    log(`Selected capture source: ${targetSource.name} (${targetSource.id})`);
    
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: targetSource.id,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080,
          minFrameRate: 60,
          maxFrameRate: 60
        }
      }
    };
    
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    log('Local video stream captured successfully at 60 FPS.');
    
    // Connect signaling WS
    ws = new WebSocket('ws://localhost:3001');
    
    ws.onopen = () => {
      log('Signaling WebSocket connected.');
      ws.send(JSON.stringify({
        type: 'REGISTER_HOST',
        gateCode: currentGateCode,
        title: title,
        developer: developer
      }));
    };
    
    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'HOST_REGISTERED':
            log(`Gate registered on server. Code: ${data.gateCode}`);
            hostChatCard.style.display = 'block';
            hostChatMessages.innerHTML = '<span style="opacity: 0.4; font-style: italic;">Connected. No messages yet.</span>';
            chatCountBadge.innerText = '0 Viewers';
            ipcRenderer.send('set-streaming-state', true);
            break;
          case 'VIEWER_JOINED':
            log(`Viewer joined: ${data.user} (${data.viewerId}). Establishing WebRTC connection...`);
            handleViewerJoined(data.viewerId, data.user);
            break;
          case 'RTC_SIGNAL':
            handleRtcSignal(data.senderId, data.signal);
            break;
          case 'VIEWER_LEFT':
            log(`Viewer left: ${data.viewerId}`);
            handleViewerLeft(data.viewerId);
            ipcRenderer.send('viewer-left', { viewerId: data.viewerId });
            break;
          case 'NEW_CHAT_MESSAGE':
            appendHostChatMessage(data.chat.user, data.chat.message);
            break;
          case 'GAMEPAD_INPUT':
            ipcRenderer.send('gamepad-input', { viewerId: data.senderId, input: data.input });
            break;
        }
      } catch (err) {
        log(`WS error parsing message: ${err.message}`);
      }
    };
    
    ws.onclose = () => {
      log('Signaling WebSocket disconnected.');
      if (isStreamingActive) {
        stopWebRTCStream();
      }
    };
    
    ws.onerror = (err) => {
      log(`WS Error: ${err.message || 'Connection failed'}`);
    };
    
  } catch (err) {
    log(`Failed to start WebRTC stream: ${err.message}`);
    stopWebRTCStream();
  }
}

function stopWebRTCStream() {
  log('Stopping live stream...');
  
  // Hide chat card
  hostChatCard.style.display = 'none';
  hostChatMessages.innerHTML = '<span style="opacity: 0.4; font-style: italic;">Chat will appear here when you start streaming...</span>';
  chatCountBadge.innerText = '0 Viewers';
  
  // Stop all gamepad controllers
  ipcRenderer.send('stop-all-gamepads');
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (e) {}
    });
    localStream = null;
  }
  
  peerConnections.forEach((pc, id) => {
    try {
      pc.close();
    } catch (e) {}
  });
  peerConnections.clear();
  
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
  
  ipcRenderer.send('set-streaming-state', false);
}

async function handleViewerJoined(viewerId, username) {
  try {
    if (peerConnections.has(viewerId)) {
      handleViewerLeft(viewerId);
    }
    
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    });
    
    peerConnections.set(viewerId, pc);
    
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }
    
    pc.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          targetId: viewerId,
          signal: event.candidate
        }));
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`Viewer ${username || viewerId} connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        handleViewerLeft(viewerId);
      }
    };
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'RTC_SIGNAL',
        targetId: viewerId,
        signal: offer
      }));
      log(`Sent WebRTC Offer to viewer ${username || viewerId}`);
    }
    chatCountBadge.innerText = `${peerConnections.size} Viewers`;
  } catch (err) {
    log(`Failed to setup connection for viewer ${viewerId}: ${err.message}`);
  }
}

async function handleRtcSignal(senderId, signal) {
  try {
    const pc = peerConnections.get(senderId);
    if (!pc) return;
    
    if (signal.type === 'answer') {
      log(`Received WebRTC Answer from viewer ${senderId}`);
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
      log(`Received WebRTC ICE candidate from viewer ${senderId}`);
      await pc.addIceCandidate(new RTCIceCandidate(signal));
    }
  } catch (err) {
    log(`Error handling WebRTC signal from ${senderId}: ${err.message}`);
  }
}

function handleViewerLeft(viewerId) {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
    peerConnections.delete(viewerId);
    log(`Cleaned up connection for viewer ${viewerId}`);
    chatCountBadge.innerText = `${peerConnections.size} Viewers`;
  }
}

// 1. Send actions / Manage streaming state
btnStream.addEventListener('click', () => {
  if (!isStreamingActive) {
    startWebRTCStream();
  } else {
    stopWebRTCStream();
  }
});

btnDvr.addEventListener('click', () => {
  if (!isDvrActive) {
    const windowTitle = windowPicker.value;
    log(`Starting rolling DVR on "${windowTitle || 'Entire Desktop'}"...`);
    ipcRenderer.send('start-dvr', { windowTitle });
  } else {
    log('Stopping DVR buffer...');
    ipcRenderer.send('stop-dvr');
  }
});

btnDvrSave.addEventListener('click', () => {
  saveDvrClip();
});

btnRecord.addEventListener('click', () => {
  if (!isRecordingActive) {
    const title = streamTitleInput.value.trim() || 'Manual Record Clip';
    const developer = devNameInput.value.trim() || 'SoloDev';
    const windowTitle = windowPicker.value;
    log(`Starting manual recording on "${windowTitle || 'Entire Desktop'}"...`);
    ipcRenderer.send('start-recording', { title, developer, windowTitle });
  } else {
    log('Stopping manual recording...');
    ipcRenderer.send('stop-recording');
  }
});

btnScreenshot.addEventListener('click', () => {
  captureScreenshot();
});

function captureScreenshot() {
  const title = streamTitleInput.value.trim() || 'Screenshot';
  const developer = devNameInput.value.trim() || 'SoloDev';
  const windowTitle = windowPicker.value;
  log(`Snapping display source "${windowTitle || 'Entire Desktop'}"...`);
  ipcRenderer.send('take-screenshot', { title, developer, windowTitle });
}

function saveDvrClip() {
  if (!isDvrActive) return;
  const title = streamTitleInput.value.trim() || 'DVR 30s Replay';
  const developer = devNameInput.value.trim() || 'SoloDev';
  log('Splicing last 30s DVR buffer...');
  ipcRenderer.send('save-dvr-clip', { title, developer });
}

btnRegenCode.addEventListener('click', () => {
  log('Generating new Room Gate Code...');
  ipcRenderer.send('regenerate-gatecode');
});

// 2. Receive state updates from Main
ipcRenderer.on('state-updated', (event, state) => {
  isStreamingActive = state.isStreaming;
  isDvrActive = state.isDvrActive;
  isRecordingActive = state.isRecording;
  currentGateCode = state.gateCode;

  // Diagnostics info
  encoderDiagnostic.innerText = state.detectedEncoder;
  audioDiagnostic.innerText = state.detectedAudioDevice || 'No Audio Device (Video Only)';
  gateCodeDisplay.innerText = state.gateCode || '----';

  // Gamepad/ViGEm status updates
  if (state.isVigemConnected) {
    vigemStatusWarning.style.display = 'none';
    vigemStatus.innerText = 'Active';
    vigemStatus.style.color = 'var(--green-active)';
  } else {
    vigemStatusWarning.style.display = 'block';
    vigemStatus.innerText = 'Missing';
    vigemStatus.style.color = 'var(--red-live)';
  }

  // Toggle buttons disabled states
  btnRegenCode.disabled = isStreamingActive || isRecordingActive || isDvrActive;

  // Update stream controls
  const btnStreamText = btnStream.querySelector('.btn-text') || btnStream;
  if (isStreamingActive) {
    btnStreamText.innerText = 'Stop Live Stream';
    btnStream.className = 'btn btn-primary active';
    streamBadge.innerText = 'LIVE';
    streamBadge.className = 'badge live';
    windowPicker.disabled = true;
    
    // Toggle panels for single-screen compact layout
    settingsSection.style.display = 'none';
    streamInfoBanner.style.display = 'block';
    
    const title = streamTitleInput.value.trim() || 'GOATGATE Live Stream';
    const developer = devNameInput.value.trim() || 'SoloDev';
    streamInfoText.innerText = `${title} (by ${developer})`;
    streamInfoCode.innerText = state.gateCode || '----';
  } else {
    btnStreamText.innerText = 'Start Live Stream';
    btnStream.className = 'btn btn-primary';
    streamBadge.innerText = 'OFFLINE';
    streamBadge.className = 'badge';
    windowPicker.disabled = false;
    
    // Restore settings card
    settingsSection.style.display = 'block';
    streamInfoBanner.style.display = 'none';
  }

  // Update DVR controls
  const btnDvrText = btnDvr.querySelector('.btn-text') || btnDvr;
  if (isDvrActive) {
    btnDvrText.innerText = 'Disable Buffer';
    btnDvr.className = 'btn btn-secondary active';
    dvrBadge.innerText = 'BUFFERING';
    dvrBadge.className = 'badge active';
    windowPicker.disabled = true;
    
    // Disable save button for the first 10 seconds of buffering
    if (btnDvrSave.disabled && !window.dvrTimerActive) {
      window.dvrTimerActive = true;
      log('DVR buffering started. Preparing segment cache (10s)...');
      setTimeout(() => {
        window.dvrTimerActive = false;
        if (isDvrActive) {
          btnDvrSave.disabled = false;
          log('DVR buffer ready. Press F9 or click Save Clip to capture the last 30s.');
        }
      }, 10000);
    }
  } else {
    btnDvrText.innerText = 'Enable Buffer';
    btnDvr.className = 'btn btn-secondary';
    dvrBadge.innerText = 'DISABLED';
    dvrBadge.className = 'badge';
    btnDvrSave.disabled = true;
    window.dvrTimerActive = false;
    if (!isStreamingActive && !isRecordingActive) {
      windowPicker.disabled = false;
    }
  }

  // Update Manual Record button
  const btnRecordText = btnRecord.querySelector('.btn-text') || btnRecord;
  if (isRecordingActive) {
    btnRecordText.innerText = 'Stop Record';
    btnRecord.className = 'btn btn-secondary active';
    windowPicker.disabled = true;
  } else {
    btnRecordText.innerText = 'Record';
    btnRecord.className = 'btn btn-secondary';
    if (!isStreamingActive && !isDvrActive) {
      windowPicker.disabled = false;
    }
  }

  // Set top status indicators
  if (isStreamingActive) {
    overallStatus.innerText = 'BROADCASTING';
    overallStatus.style.background = 'var(--red-live)';
    overallStatus.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    overallStatus.style.color = 'white';
  } else if (isRecordingActive) {
    overallStatus.innerText = 'RECORDING';
    overallStatus.style.background = 'var(--purple-accent)';
    overallStatus.style.borderColor = 'rgba(139, 92, 246, 0.4)';
    overallStatus.style.color = 'white';
  } else if (isDvrActive) {
    overallStatus.innerText = 'DVR ACTIVE';
    overallStatus.style.background = 'rgba(34, 197, 94, 0.2)';
    overallStatus.style.borderColor = 'rgba(34, 197, 94, 0.4)';
    overallStatus.style.color = '#4ade80';
  } else {
    overallStatus.innerText = 'STANDBY';
    overallStatus.style.background = 'rgba(255, 255, 255, 0.04)';
    overallStatus.style.borderColor = 'var(--border-muted)';
    overallStatus.style.color = 'var(--text-secondary)';
  }
});

// 3. Receive actions from main triggered by hotkeys
ipcRenderer.on('trigger-action', (event, action) => {
  if (action === 'screenshot') {
    captureScreenshot();
  } else if (action === 'record-toggle') {
    btnRecord.click();
  } else if (action === 'dvr-save') {
    saveDvrClip();
  }
});

// Windows dropdown management
btnRefreshWindows.addEventListener('click', () => {
  log('Scanning active application windows...');
  ipcRenderer.send('get-windows');
});

ipcRenderer.on('windows-list', (event, windows) => {
  const currentValue = windowPicker.value;
  windowPicker.innerHTML = '<option value="">Entire Desktop</option>';
  windows.forEach(title => {
    const opt = document.createElement('option');
    opt.value = title;
    opt.innerText = title.length > 25 ? title.substring(0, 25) + '...' : title;
    opt.title = title;
    windowPicker.appendChild(opt);
  });
  if (windows.includes(currentValue)) {
    windowPicker.value = currentValue;
  }
  log(`Window scan complete. Found ${windows.length} capture sources.`);
});

// Receive log messages from Main
ipcRenderer.on('log-message', (event, msg) => {
  log(`[MAIN] ${msg}`);
});

// Initial state and window list fetch
ipcRenderer.send('get-state');
ipcRenderer.send('get-windows');

// Chat form listener
hostChatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = hostChatInput.value.trim();
  if (!message || !ws || ws.readyState !== WebSocket.OPEN) return;
  
  ws.send(JSON.stringify({
    type: 'CHAT_MESSAGE',
    message: message
  }));
  
  hostChatInput.value = '';
});

// Link handler for ViGEm download
vigemDownloadLink.addEventListener('click', (e) => {
  e.preventDefault();
  shell.openExternal('https://github.com/nefarius/ViGEmBus/releases/latest');
});
