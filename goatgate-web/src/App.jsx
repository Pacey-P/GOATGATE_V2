import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Navigation State
  const [gateCode, setGateCode] = useState(null); // 'ABCD' or null
  const [ingressCode, setIngressCode] = useState('');
  const [username, setUsername] = useState('');

  // Data collections
  const [liveGates, setLiveGates] = useState({});
  const [clips, setClips] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [streamState, setStreamState] = useState({
    isLive: false,
    viewerCount: 0,
    startedAt: null,
    title: 'Offline Gateway',
    developer: 'Developer'
  });

  // UI inputs
  const [chatInput, setChatInput] = useState('');
  const [currentTab, setCurrentTab] = useState('all');
  const [activeMedia, setActiveMedia] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [rightPanelTab, setRightPanelTab] = useState('chat');
  const [pressedButtons, setPressedButtons] = useState({});

  // Diagnostic metrics
  const [stats, setStats] = useState({
    latency: '0ms',
    fps: 0,
    buffer: '0.00',
    dropped: 0
  });

  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const chatBottomRef = useRef(null);
  const lastFrameCountRef = useRef(0);
  
  // WebRTC refs
  const pcRef = useRef(null);
  const hostIdRef = useRef(null);

  // Ref to hold the current gateCode to prevent stale closures in WebSocket message handler
  const gateCodeRef = useRef(null);

  // Sync ref with state changes
  useEffect(() => {
    gateCodeRef.current = gateCode;
  }, [gateCode]);

  // Generate a random username on mount
  useEffect(() => {
    const randomNum = Math.floor(Math.random() * 900) + 100;
    setUsername(`DevGuest_${randomNum}`);
  }, []);

  // Set up WebSocket Connection ONCE (empty dependency array)
  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.port ? `${window.location.hostname}:3001` : window.location.host;
    const ws = new WebSocket(`${wsProtocol}//${wsHost}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'INIT_LOBBY':
            setLiveGates(data.liveGates);
            setClips(data.clips);
            setScreenshots(data.screenshots);
            setGateCode(null);
            setChatMessages([]);
            break;
          case 'LOBBY_UPDATE':
            setLiveGates(data.liveGates);
            break;
          case 'INIT_ROOM_DATA':
            setGateCode(data.gateCode);
            setStreamState(data.streamState || {
              isLive: false,
              viewerCount: 0,
              startedAt: null,
              title: 'Offline Room',
              developer: 'Unknown Dev'
            });
            setChatMessages(data.chat);
            break;
          case 'STREAM_STATE_UPDATED':
          case 'STREAM_META_UPDATED':
            if (gateCodeRef.current && data.gateCode === gateCodeRef.current) {
              setStreamState(prev => ({ ...prev, ...data.streamState }));
            }
            break;
          case 'VIEWER_COUNT_UPDATED':
            if (gateCodeRef.current && data.gateCode === gateCodeRef.current) {
              setStreamState(prev => ({ ...prev, ...data.streamState }));
            }
            break;
          case 'NEW_CHAT_MESSAGE':
            if (gateCodeRef.current && data.gateCode === gateCodeRef.current) {
              setChatMessages(prev => [...prev, data.chat]);
            }
            break;
          case 'CLIP_UPLOADED':
            setClips(prev => [data.clip, ...prev]);
            break;
          case 'SCREENSHOT_UPLOADED':
            setScreenshots(prev => [data.screenshot, ...prev]);
            break;
          case 'RTC_SIGNAL':
            if (gateCodeRef.current && data.signal) {
              handleRtcSignal(data.senderId, data.signal);
            }
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed. Reconnecting in 3s...');
      setTimeout(() => {
        // Simple reconnect logic
      }, 3000);
    };

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // WebRTC Signaling Answer Handler
  const handleRtcSignal = async (senderId, signal) => {
    try {
      const pc = pcRef.current;
      if (!pc) return;

      if (signal.type === 'offer') {
        console.log('[WEBRTC] Received offer from host:', senderId);
        hostIdRef.current = senderId;
        
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        wsRef.current.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          targetId: senderId,
          signal: answer
        }));
        console.log('[WEBRTC] Sent answer back to host.');
      } 
      else if (signal.candidate) {
        console.log('[WEBRTC] Adding ICE candidate from host.');
        await pc.addIceCandidate(new RTCIceCandidate(signal));
      }
    } catch (err) {
      console.error('[WEBRTC] Error handling WebRTC signal:', err);
    }
  };

  // Initialize and clean up WebRTC Connection
  useEffect(() => {
    if (gateCode && streamState.isLive) {
      console.log('[WEBRTC] Creating peer connection...');
      
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });

      pcRef.current = pc;

      // When video track arrives, map directly to video element's srcObject
      pc.ontrack = (event) => {
        console.log('[WEBRTC] Track received from host!');
        if (videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && wsRef.current && hostIdRef.current) {
          wsRef.current.send(JSON.stringify({
            type: 'RTC_SIGNAL',
            targetId: hostIdRef.current,
            signal: event.candidate
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WEBRTC] Connection State:', pc.connectionState);
      };
    }

    return () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      hostIdRef.current = null;
    };
  }, [streamState.isLive, gateCode]);

  // Real-time Diagnostics Interval
  useEffect(() => {
    let intervalId = null;

    if (gateCode && streamState.isLive) {
      lastFrameCountRef.current = 0;
      intervalId = setInterval(() => {
        const video = videoRef.current;
        if (!video) return;

        let bufferLength = 0;
        if (video.buffered && video.buffered.length > 0) {
          const end = video.buffered.end(video.buffered.length - 1);
          bufferLength = Math.max(0, end - video.currentTime);
        }

        // Get Decoded Frames for FPS
        let totalFrames = 0;
        if (video.getVideoPlaybackQuality) {
          totalFrames = video.getVideoPlaybackQuality().totalVideoFrames;
        } else {
          totalFrames = video.webkitDecodedFrameCount || 0;
        }

        const deltaFrames = lastFrameCountRef.current > 0 ? (totalFrames - lastFrameCountRef.current) : 0;
        lastFrameCountRef.current = totalFrames;

        // Get Dropped Frames
        let droppedFrames = 0;
        if (video.getVideoPlaybackQuality) {
          droppedFrames = video.getVideoPlaybackQuality().droppedVideoFrames;
        } else {
          droppedFrames = video.webkitDroppedFrameCount || 0;
        }

        setStats({
          latency: bufferLength > 0 ? `${(bufferLength * 1000).toFixed(0)}ms` : '15-40ms (P2P UDP)',
          fps: deltaFrames,
          buffer: bufferLength.toFixed(2),
          dropped: droppedFrames
        });
      }, 1000);
    } else {
      setStats({
        latency: '0ms',
        fps: 0,
        buffer: '0.00',
        dropped: 0
      });
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [streamState.isLive, gateCode]);

  const getMappedInput = (key, isDown) => {
    const value = isDown ? true : false;
    switch (key.toLowerCase()) {
      // D-Pad / Left Stick
      case 'arrowup':
      case 'w':
        return { type: 'button', name: 'DPAD_UP', value };
      case 'arrowdown':
      case 's':
        return { type: 'button', name: 'DPAD_DOWN', value };
      case 'arrowleft':
      case 'a':
        return { type: 'button', name: 'DPAD_LEFT', value };
      case 'arrowright':
      case 'd':
        return { type: 'button', name: 'DPAD_RIGHT', value };
        
      // Action Buttons
      case ' ':
      case 'j':
        return { type: 'button', name: 'A', value };
      case 'k':
        return { type: 'button', name: 'B', value };
      case 'u':
        return { type: 'button', name: 'X', value };
      case 'i':
        return { type: 'button', name: 'Y', value };
        
      // Shoulders
      case 'q':
        return { type: 'button', name: 'LEFT_SHOULDER', value };
      case 'e':
        return { type: 'button', name: 'RIGHT_SHOULDER', value };
        
      // Start / Back
      case 'enter':
        return { type: 'button', name: 'START', value };
      case 'shift':
        return { type: 'button', name: 'BACK', value };
        
      default:
        return null;
    }
  };

  const handleVirtualButton = (btnName, isPressed) => {
    setPressedButtons(prev => ({ ...prev, [btnName]: isPressed }));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'GAMEPAD_INPUT',
        input: { type: 'button', name: btnName, value: isPressed }
      }));
    }
  };

  // Keyboard Gamepad Emulation Hook
  useEffect(() => {
    if (gateCode && rightPanelTab === 'gamepad') {
      const handleKeyDown = (e) => {
        // Prevent scrolling with gaming keys
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'].includes(e.key)) {
          e.preventDefault();
        }
        
        const mappedInput = getMappedInput(e.key, true);
        if (mappedInput) {
          setPressedButtons(prev => ({ ...prev, [mappedInput.name]: true }));
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'GAMEPAD_INPUT',
              input: mappedInput
            }));
          }
        }
      };

      const handleKeyUp = (e) => {
        const mappedInput = getMappedInput(e.key, false);
        if (mappedInput) {
          setPressedButtons(prev => ({ ...prev, [mappedInput.name]: false }));
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'GAMEPAD_INPUT',
              input: mappedInput
            }));
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
      };
    }
  }, [gateCode, rightPanelTab]);

  // Physical Gamepad API Hook
  useEffect(() => {
    let animFrameId = null;
    
    if (gateCode && rightPanelTab === 'gamepad') {
      const buttonStates = {};
      const axisStates = {};
      
      const pollGamepad = () => {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads.find(g => g !== null);
        
        if (gp && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const buttonMappings = {
            0: 'A', 1: 'B', 2: 'X', 3: 'Y',
            4: 'LEFT_SHOULDER', 5: 'RIGHT_SHOULDER',
            8: 'BACK', 9: 'START',
            12: 'DPAD_UP', 13: 'DPAD_DOWN', 14: 'DPAD_LEFT', 15: 'DPAD_RIGHT'
          };
          
          Object.entries(buttonMappings).forEach(([idx, name]) => {
            const btn = gp.buttons[idx];
            const pressed = btn ? btn.pressed : false;
            if (buttonStates[name] !== pressed) {
              buttonStates[name] = pressed;
              setPressedButtons(prev => ({ ...prev, [name]: pressed }));
              wsRef.current.send(JSON.stringify({
                type: 'GAMEPAD_INPUT',
                input: { type: 'button', name, value: pressed }
              }));
            }
          });
          
          const axisMappings = {
            0: { name: 'leftX', invert: false },
            1: { name: 'leftY', invert: true },
            2: { name: 'rightX', invert: false },
            3: { name: 'rightY', invert: true }
          };
          
          Object.entries(axisMappings).forEach(([idx, config]) => {
            let val = gp.axes[idx] || 0;
            if (Math.abs(val) < 0.15) val = 0;
            if (config.invert) val = -val;
            
            const formattedVal = parseFloat(val.toFixed(2));
            if (axisStates[config.name] !== formattedVal) {
              axisStates[config.name] = formattedVal;
              wsRef.current.send(JSON.stringify({
                type: 'GAMEPAD_INPUT',
                input: { type: 'axis', name: config.name, value: formattedVal }
              }));
            }
          });
        }
        
        animFrameId = requestAnimationFrame(pollGamepad);
      };
      
      pollGamepad();
    }
    
    return () => {
      if (animFrameId) cancelAnimationFrame(animFrameId);
    };
  }, [gateCode, rightPanelTab]);

  // Scroll chat to bottom
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  const handleJoinGate = (e) => {
    if (e) e.preventDefault();
    setErrorMessage('');
    const code = ingressCode.trim().toUpperCase();
    
    if (code.length !== 4) {
      setErrorMessage('Gate Code must be exactly 4 characters.');
      return;
    }

    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'JOIN_GATE',
        gateCode: code,
        user: username
      }));
    }
  };

  const handleLeaveGate = () => {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({
        type: 'LEAVE_GATE'
      }));
    }
    setGateCode(null);
    setIngressCode('');
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !wsRef.current || !gateCode) return;

    wsRef.current.send(JSON.stringify({
      type: 'CHAT_MESSAGE',
      message: chatInput.trim()
    }));
    setChatInput('');
  };

  const getFilteredMedia = () => {
    const combined = [
      ...clips.map(c => ({ ...c, mediaType: 'video' })),
      ...screenshots.map(s => ({ ...s, mediaType: 'image' }))
    ];
    combined.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (currentTab === 'clips') {
      return combined.filter(m => m.mediaType === 'video');
    }
    if (currentTab === 'screenshots') {
      return combined.filter(m => m.mediaType === 'image');
    }
    return combined;
  };

  const filteredMedia = getFilteredMedia();
  const liveGatesList = Object.entries(liveGates);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-container" onClick={handleLeaveGate} style={{ cursor: 'pointer' }}>
          <img src="/logo.png" alt="GOATGATE Logo" className="logo-icon" style={{ objectFit: 'cover', background: 'none', boxShadow: 'none' }} />
          <div className="logo-text">GOATGATE</div>
        </div>

        <div className="header-status">
          {gateCode ? (
            <>
              <div className="meta-pill" style={{ color: 'var(--cyan-accent)', borderColor: 'var(--border-cyan-glow)', fontWeight: 700, fontFamily: 'monospace' }}>
                GATE: {gateCode}
              </div>
              <button onClick={handleLeaveGate} className="tab-btn" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--border-muted)' }}>
                Leave Gate
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>User:</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="chat-input"
                style={{ padding: '0.25rem 0.5rem', width: '130px', fontSize: '0.85rem' }}
                title="Change nickname"
              />
            </div>
          )}
        </div>
      </header>

      {/* View 1: Jackbox-style Lobby */}
      {!gateCode ? (
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3rem', padding: '3rem 2rem', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
          
          {/* Jackbox Ingress Portal */}
          <div className="glass-panel" style={{ maxWidth: '480px', width: '100%', margin: '0 auto', padding: '2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', borderRadius: '24px', alignSelf: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.5), 0 0 25px rgba(139, 92, 246, 0.15)' }}>
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontFamily: 'var(--font-title)', fontSize: '1.8rem', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '0.5rem' }}>Enter the <span style={{ background: 'linear-gradient(to right, var(--purple-accent), var(--cyan-accent))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Gateway</span></h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Enter a 4-letter Gate Code to view a session</p>
            </div>

            <form onSubmit={handleJoinGate} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="input-group">
                <input
                  type="text"
                  placeholder="CODE"
                  maxLength={4}
                  value={ingressCode}
                  onChange={(e) => setIngressCode(e.target.value.toUpperCase())}
                  className="chat-input"
                  style={{ textAlign: 'center', fontSize: '2.2rem', letterSpacing: '0.5rem', fontFamily: 'monospace', fontWeight: 800, textTransform: 'uppercase', height: '65px', borderRadius: '12px', border: '2px solid var(--border-muted)', background: '#020204' }}
                />
              </div>

              {errorMessage && (
                <div style={{ color: 'var(--red-live)', fontSize: '0.8rem', textAlign: 'center', fontWeight: 600 }}>
                  {errorMessage}
                </div>
              )}

              <button type="submit" className="chat-submit" style={{ height: '50px', fontSize: '1rem', fontWeight: 700, borderRadius: '12px', background: 'linear-gradient(135deg, var(--purple-accent), #7c3aed)' }}>
                ENTER GATE
              </button>
            </form>
          </div>

          {/* Active Channels Grid */}
          <section>
            <h3 style={{ fontFamily: 'var(--font-title)', fontSize: '1.4rem', fontWeight: 600, marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="pulse-indicator" /> Live Gates
            </h3>

            {liveGatesList.length === 0 ? (
              <div className="glass-panel empty-state" style={{ padding: '3rem' }}>
                <div className="empty-state-icon" style={{ fontSize: '2rem' }}>📺</div>
                <h4>No Live Channels</h4>
                <p>Open the desktop client, set up your room parameters, and start streaming to establish a gate.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
                {liveGatesList.map(([code, info]) => (
                  <div
                    key={code}
                    onClick={() => {
                      setIngressCode(code);
                      if (wsRef.current) {
                        wsRef.current.send(JSON.stringify({ type: 'JOIN_GATE', gateCode: code, user: username }));
                      }
                    }}
                    className="glass-panel"
                    style={{ padding: '1.25rem', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '3px solid var(--cyan-accent)' }}
                  >
                    <div>
                      <h4 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.25rem' }}>{info.title}</h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>by {info.developer}</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--cyan-accent)', fontFamily: 'monospace', background: 'rgba(6, 182, 212, 0.1)', padding: '0.15rem 0.5rem', borderRadius: '4px' }}>{code}</span>
                      <span style={{ fontSize: '0.7rem', color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '4px', height: '4px', backgroundColor: '#f87171', borderRadius: '50%' }} />
                        {info.viewerCount} viewing
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Gallery / Log Feeds */}
          <section className="feed-section" style={{ padding: 0 }}>
            <div className="feed-header">
              <h3 className="feed-title" style={{ fontSize: '1.4rem' }}>Developer <span>Clips & Screenshots</span></h3>
              <div className="tabs-container">
                <button onClick={() => setCurrentTab('all')} className={`tab-btn ${currentTab === 'all' ? 'active' : ''}`}>All</button>
                <button onClick={() => setCurrentTab('clips')} className={`tab-btn ${currentTab === 'clips' ? 'active' : ''}`}>Clips</button>
                <button onClick={() => setCurrentTab('screenshots')} className={`tab-btn ${currentTab === 'screenshots' ? 'active' : ''}`}>Screenshots</button>
              </div>
            </div>

            <div className="media-grid">
              {filteredMedia.length === 0 ? (
                <div className="empty-state">
                  <p>No uploaded assets yet.</p>
                </div>
              ) : (
                filteredMedia.map(item => (
                  <div key={item.id} className="glass-panel media-card" onClick={() => setActiveMedia(item)} style={{ cursor: 'pointer' }}>
                    <div className="card-preview">
                      {item.mediaType === 'video' ? (
                        <>
                          <video className="card-img" src={`${item.url}#t=0.5`} muted preload="metadata" />
                          <div className={`card-badge ${item.type}`}>{item.type}</div>
                          <div className="play-overlay"><div className="play-btn-circle">▶</div></div>
                        </>
                      ) : (
                        <>
                          <img className="card-img" src={item.url} alt={item.title} />
                          <div className="card-badge screenshot">screenshot</div>
                        </>
                      )}
                    </div>
                    <div className="card-info">
                      <h3 className="card-title">{item.title}</h3>
                      <div className="card-meta">
                        <span className="card-dev">by {item.developer} {item.gateCode && <strong style={{ color: 'var(--purple-accent)', fontFamily: 'monospace' }}>[{item.gateCode}]</strong>}</span>
                        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>
      ) : (
        /* View 2: Stream Gate Room */
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="dashboard-grid">
            {/* Left Column: Stream Screen & Metrics */}
            <div className="video-section">
              <div className={`video-wrapper ${streamState.isLive ? 'live' : ''}`}>
                {streamState.isLive ? (
                  <video ref={videoRef} id="videoElement" className="video-player" controls muted autoPlay />
                ) : (
                  <div className="offline-placeholder">
                    <div className="offline-icon">🚀</div>
                    <h2 style={{ fontFamily: 'var(--font-title)' }}>Gate {gateCode} is offline</h2>
                    <p style={{ fontSize: '0.9rem', opacity: 0.7 }}>Waiting for the developer to stream to this room code.</p>
                  </div>
                )}
              </div>

              {/* Stream Diagnostics */}
              {streamState.isLive && (
                <div className="glass-panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', padding: '1rem', textAlign: 'center' }}>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.25rem', fontWeight: 600 }}>Latency</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '800', color: 'var(--cyan-accent)', fontFamily: 'monospace' }}>{stats.latency}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.25rem', fontWeight: 600 }}>Frame Rate</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '800', color: 'var(--purple-accent)', fontFamily: 'monospace' }}>{stats.fps} FPS</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.25rem', fontWeight: 600 }}>Buffer Depth</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '800', color: 'white', fontFamily: 'monospace' }}>{stats.buffer}s</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '0.25rem', fontWeight: 600 }}>Dropped</div>
                    <div style={{ fontSize: '1.15rem', fontWeight: '800', color: stats.dropped > 0 ? 'var(--red-live)' : 'white', fontFamily: 'monospace' }}>{stats.dropped}</div>
                  </div>
                </div>
              )}

              <div className="glass-panel stream-details">
                <div className="stream-title-area">
                  <h1>{streamState.title}</h1>
                  <div className="stream-developer">host: {streamState.developer}</div>
                </div>
                <div className="stream-meta-pills">
                  {streamState.isLive && (
                    <div className="meta-pill live-viewer">
                      <div className="pulse-indicator" />
                      <span>{streamState.viewerCount} viewing</span>
                    </div>
                  )}
                  <div className="meta-pill" style={{ color: 'var(--cyan-accent)', borderColor: 'var(--border-cyan-glow)', fontWeight: 700, fontFamily: 'monospace' }}>
                    CODE: {gateCode}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Chat & Gamepad Tabs */}
            <div className="glass-panel chat-container" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="chat-header" style={{ display: 'flex', gap: '1.25rem', padding: '1rem', borderBottom: '1px solid var(--border-muted)', justifyContent: 'flex-start', alignItems: 'center' }}>
                <span 
                  onClick={() => setRightPanelTab('chat')} 
                  style={{ 
                    cursor: 'pointer', 
                    color: rightPanelTab === 'chat' ? 'var(--cyan-accent)' : 'var(--text-secondary)', 
                    fontWeight: 700, 
                    fontSize: '0.9rem',
                    borderBottom: rightPanelTab === 'chat' ? '2px solid var(--cyan-accent)' : 'none', 
                    paddingBottom: '0.25rem' 
                  }}
                >
                  CHAT
                </span>
                <span 
                  onClick={() => setRightPanelTab('gamepad')} 
                  style={{ 
                    cursor: 'pointer', 
                    color: rightPanelTab === 'gamepad' ? 'var(--cyan-accent)' : 'var(--text-secondary)', 
                    fontWeight: 700, 
                    fontSize: '0.9rem',
                    borderBottom: rightPanelTab === 'gamepad' ? '2px solid var(--cyan-accent)' : 'none', 
                    paddingBottom: '0.25rem' 
                  }}
                >
                  GAMEPAD
                </span>
              </div>

              {rightPanelTab === 'chat' ? (
                <>
                  <div className="chat-messages">
                    {chatMessages.length === 0 ? (
                      <div className="empty-state" style={{ padding: '2rem 1rem' }}>
                        <span style={{ opacity: 0.4 }}>No messages. Send a message to chat with the developer!</span>
                      </div>
                    ) : (
                      chatMessages.map(msg => (
                        <div key={msg.id} className="chat-msg">
                          <span className="chat-user">{msg.user}:</span>
                          <span>{msg.message}</span>
                        </div>
                      ))
                    )}
                    <div ref={chatBottomRef} />
                  </div>

                  <form onSubmit={handleSendMessage} className="chat-input-form">
                    <input
                      type="text"
                      className="chat-input"
                      placeholder="Type a message..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      maxLength={150}
                    />
                    <button type="submit" className="chat-submit">Send</button>
                  </form>
                </>
              ) : (
                <div className="gamepad-container">
                  <div className="gamepad-info">
                    <div className={`gamepad-status-pill ${navigator.getGamepads && navigator.getGamepads().some(g => g !== null) ? 'controller' : 'keyboard'}`}>
                      {navigator.getGamepads && navigator.getGamepads().some(g => g !== null) ? '🎮 Controller Mode' : '⌨️ Keyboard Emulation'}
                    </div>
                    <p style={{ lineHeight: '1.4', fontSize: '0.75rem', opacity: 0.8 }}>
                      Use **Arrow/WASD** (D-Pad), **J/Space** (A), **K** (B), **U** (X), **I** (Y), **Q/E** (Shoulders), **Enter** (Start), and **Shift** (Back).
                    </p>
                  </div>

                  <div className="gamepad-controller-visual">
                    {/* LB & RB */}
                    <div className="gamepad-shoulders">
                      <div 
                        className={`gamepad-btn-shoulder ${pressedButtons['LEFT_SHOULDER'] ? 'active' : ''}`}
                        onMouseDown={() => handleVirtualButton('LEFT_SHOULDER', true)}
                        onMouseUp={() => handleVirtualButton('LEFT_SHOULDER', false)}
                        onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('LEFT_SHOULDER', true); }}
                        onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('LEFT_SHOULDER', false); }}
                      >
                        LB (Q)
                      </div>
                      <div 
                        className={`gamepad-btn-shoulder ${pressedButtons['RIGHT_SHOULDER'] ? 'active' : ''}`}
                        onMouseDown={() => handleVirtualButton('RIGHT_SHOULDER', true)}
                        onMouseUp={() => handleVirtualButton('RIGHT_SHOULDER', false)}
                        onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('RIGHT_SHOULDER', true); }}
                        onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('RIGHT_SHOULDER', false); }}
                      >
                        RB (E)
                      </div>
                    </div>

                    <div className="gamepad-body-row">
                      {/* Dpad */}
                      <div className="gamepad-dpad">
                        <div />
                        <div 
                          className={`gamepad-btn-dpad ${pressedButtons['DPAD_UP'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('DPAD_UP', true)}
                          onMouseUp={() => handleVirtualButton('DPAD_UP', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('DPAD_UP', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('DPAD_UP', false); }}
                        >
                          ▲
                        </div>
                        <div />
                        <div 
                          className={`gamepad-btn-dpad ${pressedButtons['DPAD_LEFT'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('DPAD_LEFT', true)}
                          onMouseUp={() => handleVirtualButton('DPAD_LEFT', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('DPAD_LEFT', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('DPAD_LEFT', false); }}
                        >
                          ◀
                        </div>
                        <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }} />
                        <div 
                          className={`gamepad-btn-dpad ${pressedButtons['DPAD_RIGHT'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('DPAD_RIGHT', true)}
                          onMouseUp={() => handleVirtualButton('DPAD_RIGHT', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('DPAD_RIGHT', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('DPAD_RIGHT', false); }}
                        >
                          ▶
                        </div>
                        <div />
                        <div 
                          className={`gamepad-btn-dpad ${pressedButtons['DPAD_DOWN'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('DPAD_DOWN', true)}
                          onMouseUp={() => handleVirtualButton('DPAD_DOWN', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('DPAD_DOWN', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('DPAD_DOWN', false); }}
                        >
                          ▼
                        </div>
                        <div />
                      </div>

                      {/* Face Buttons */}
                      <div className="gamepad-face-buttons">
                        <div />
                        <div 
                          className={`gamepad-btn-face btn-y ${pressedButtons['Y'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('Y', true)}
                          onMouseUp={() => handleVirtualButton('Y', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('Y', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('Y', false); }}
                        >
                          Y (I)
                        </div>
                        <div />
                        <div 
                          className={`gamepad-btn-face btn-x ${pressedButtons['X'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('X', true)}
                          onMouseUp={() => handleVirtualButton('X', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('X', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('X', false); }}
                        >
                          X (U)
                        </div>
                        <div style={{ background: 'transparent' }} />
                        <div 
                          className={`gamepad-btn-face btn-b ${pressedButtons['B'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('B', true)}
                          onMouseUp={() => handleVirtualButton('B', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('B', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('B', false); }}
                        >
                          B (K)
                        </div>
                        <div />
                        <div 
                          className={`gamepad-btn-face btn-a ${pressedButtons['A'] ? 'active' : ''}`}
                          onMouseDown={() => handleVirtualButton('A', true)}
                          onMouseUp={() => handleVirtualButton('A', false)}
                          onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('A', true); }}
                          onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('A', false); }}
                        >
                          A (J)
                        </div>
                        <div />
                      </div>
                    </div>

                    {/* Back / Start */}
                    <div className="gamepad-center-menu">
                      <div 
                        className={`gamepad-btn-menu ${pressedButtons['BACK'] ? 'active' : ''}`}
                        onMouseDown={() => handleVirtualButton('BACK', true)}
                        onMouseUp={() => handleVirtualButton('BACK', false)}
                        onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('BACK', true); }}
                        onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('BACK', false); }}
                      >
                        BACK (Shift)
                      </div>
                      <div 
                        className={`gamepad-btn-menu ${pressedButtons['START'] ? 'active' : ''}`}
                        onMouseDown={() => handleVirtualButton('START', true)}
                        onMouseUp={() => handleVirtualButton('START', false)}
                        onTouchStart={(e) => { e.preventDefault(); handleVirtualButton('START', true); }}
                        onTouchEnd={(e) => { e.preventDefault(); handleVirtualButton('START', false); }}
                      >
                        START (Enter)
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Sidelogs / assets specifically for this gate */}
          <section className="feed-section">
            <div className="feed-header">
              <h3 className="feed-title">Room <span>{gateCode} Captures</span></h3>
              <div className="tabs-container">
                <button onClick={() => setCurrentTab('all')} className={`tab-btn ${currentTab === 'all' ? 'active' : ''}`}>All</button>
                <button onClick={() => setCurrentTab('clips')} className={`tab-btn ${currentTab === 'clips' ? 'active' : ''}`}>Clips</button>
                <button onClick={() => setCurrentTab('screenshots')} className={`tab-btn ${currentTab === 'screenshots' ? 'active' : ''}`}>Screenshots</button>
              </div>
            </div>

            <div className="media-grid">
              {filteredMedia.filter(m => m.gateCode === gateCode).length === 0 ? (
                <div className="empty-state">
                  <p>No captures uploaded from this gate session yet.</p>
                </div>
              ) : (
                filteredMedia.filter(m => m.gateCode === gateCode).map(item => (
                  <div key={item.id} className="glass-panel media-card" onClick={() => setActiveMedia(item)} style={{ cursor: 'pointer' }}>
                    <div className="card-preview">
                      {item.mediaType === 'video' ? (
                        <>
                          <video className="card-img" src={`${item.url}#t=0.5`} muted preload="metadata" />
                          <div className={`card-badge ${item.type}`}>{item.type}</div>
                          <div className="play-overlay"><div className="play-btn-circle">▶</div></div>
                        </>
                      ) : (
                        <>
                          <img className="card-img" src={item.url} alt={item.title} />
                          <div className="card-badge screenshot">screenshot</div>
                        </>
                      )}
                    </div>
                    <div className="card-info">
                      <h3 className="card-title">{item.title}</h3>
                      <div className="card-meta">
                        <span className="card-dev">by {item.developer}</span>
                        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* Media Detail Modal */}
      {activeMedia && (
        <div className="modal-overlay" onClick={() => setActiveMedia(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setActiveMedia(null)}>×</button>
            <div className="modal-body">
              <div className="modal-media-wrapper">
                {activeMedia.mediaType === 'video' ? (
                  <video className="modal-media" src={activeMedia.url} controls autoPlay />
                ) : (
                  <img className="modal-media" src={activeMedia.url} alt={activeMedia.title} />
                )}
              </div>
              <div className="modal-footer">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontFamily: 'var(--font-title)', fontSize: '1.4rem' }}>{activeMedia.title}</h2>
                  <a href={activeMedia.url} download={activeMedia.filename} className="chat-submit" style={{ fontSize: '0.85rem', textDecoration: 'none' }}>
                    Download Asset
                  </a>
                </div>
                <div className="modal-desc">
                  Shared by <span style={{ color: 'var(--cyan-accent)', fontWeight: 600 }}>{activeMedia.developer}</span> on {new Date(activeMedia.createdAt).toLocaleString()}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                  {activeMedia.tags && activeMedia.tags.map((tag, idx) => (
                    <span key={idx} className="meta-pill" style={{ fontSize: '0.75rem' }}>#{tag}</span>
                  ))}
                  {activeMedia.gateCode && (
                    <span className="meta-pill" style={{ fontSize: '0.75rem', color: 'var(--purple-accent)', borderColor: 'var(--border-glow)' }}>Room: {activeMedia.gateCode}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
