const { createClient } = window.supabase;

    // Configuration
    const VIEWER_CONFIG_QUERY_PARAMETER = 'c';
    const DEFAULT_SUPABASE_URL = 'https://gmixkbtchejugaayltkb.supabase.co';
    const DEFAULT_SUPABASE_ANON_KEY = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtaXhrYnRjaGVqdWdhYXlsdGtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NDU4ODcsImV4cCI6MjA4OTQyMTg4N30',
      '_7rSJmhfLFN8dX7RqQ4LH8xhqPJaxiGrcQwbOKhuxqg',
    ].join('.');
    const DEFAULT_ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'stun:stun.relay.metered.ca:443' },
      { urls: 'stun:stun.nextcloud.com:443' }
    ];

    // DOM elements
    const viewerRoot = document.querySelector('.viewer');
    const video = document.getElementById('video');
    const audio = document.getElementById('audio');
    const statusPill = document.getElementById('statusPill');
    const overlay = document.getElementById('overlay');
    const overlayTitle = document.getElementById('overlayTitle');
    const overlayText = document.getElementById('overlayText');
    const overlayPlayBtn = document.getElementById('overlayPlayBtn');
    const controls = document.getElementById('controls');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const playPauseIcon = document.getElementById('playPauseIcon');
    const muteBtn = document.getElementById('muteBtn');
    const muteIcon = document.getElementById('muteIcon');
    const volumePanel = document.getElementById('volumePanel');
    const volumeSlider = document.getElementById('volumeSlider');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsMenu = document.getElementById('settingsMenu');
    const qualityOptions = document.getElementById('qualityOptions');
    const bitrateOptions = document.getElementById('bitrateOptions');
    // State
    let peerConnection = null;
    let supabaseClient = null;
    let supabaseChannel = null;
    let streamId = null;
    let currentConnectionId = null;
    const viewerPeerId = `viewer-${Math.random().toString(36).slice(2, 10)}`;
    const viewerSessionId = `vs-${Math.random().toString(36).slice(2, 10)}`;
    const viewerDeviceId = resolveViewerDeviceId();
    let isPlaying = false;
    let isMuted = false;
    let currentVolume = 0.8;
    let reconnectAttempts = 0;
    let reconnectTimeout = null;
    let streamInfo = null;
    let currentQuality = 'auto';
    let currentBitrate = 'auto';
    let viewerStatus = 'waiting';
    let hasUserInteracted = false;
    let autoMutedForAutoplay = false;
    let playbackKickTimers = [];
    let autoplayGateActive = false;
    let autoplayGateShown = false;
    let obsBrowserSourceMode = false;
    let audioStatsInterval = null;
    let playbackStateInterval = null;
    let pendingRemoteCandidates = [];
    let remoteDescriptionApplied = false;
    let attachedRemoteStream = null;
    const viewerConfig = resolveViewerConfig();

    // Initialize
    function init() {
      applyObsBrowserSourceMode();
      setupEventListeners();
      updateVolumeSliderVisual();
      updateVideoViewportBounds();
      updateMuteButton();
      updatePlayPauseButton();
      parseStreamId();
    }

    function applyObsBrowserSourceMode() {
      const params = new URLSearchParams(window.location.search);
      const forceHideControls =
        params.get('controls') === '0' ||
        params.get('embed') === '1' ||
        params.get('obs') === '1';
      const ua = navigator.userAgent || '';
      const looksLikeObs = /\bobs\b/i.test(ua) || /QtWebEngine/i.test(ua);
      obsBrowserSourceMode = forceHideControls || looksLikeObs;
      viewerRoot.classList.toggle('obs-browser-source', obsBrowserSourceMode);
    }

    function updateVolumeSliderVisual() {
      const value = Math.max(0, Math.min(100, Number(volumeSlider.value) || 0));
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim() || '#4f8fff';
      volumeSlider.style.background =
        `linear-gradient(to right, ${accent} 0%, ${accent} ${value}%, rgba(255,255,255,0.9) ${value}%, rgba(255,255,255,0.9) 100%)`;
    }

    function setAutoplayGateVisible(visible) {
      autoplayGateActive = visible;
      viewerRoot.classList.toggle('autoplay-gate', visible);
      overlay.classList.toggle('autoplay-prompt', visible);
      overlayPlayBtn.classList.toggle('hidden', !visible);
      syncViewerBlurState();
    }

    function syncViewerBlurState() {
      const blurForStatus =
        viewerStatus === 'connecting' ||
        viewerStatus === 'reconnecting' ||
        viewerStatus === 'paused';
      viewerRoot.classList.toggle('state-blurred', autoplayGateActive || blurForStatus);
    }

    function updateVideoViewportBounds() {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const sourceWidth = video.videoWidth || streamInfo?.width || 16;
      const sourceHeight = video.videoHeight || streamInfo?.height || 9;
      const sourceAspect = sourceWidth / sourceHeight;
      const viewportAspect = viewportWidth / viewportHeight;

      let renderedWidth = viewportWidth;
      let renderedHeight = viewportHeight;

      if (sourceAspect > viewportAspect) {
        renderedHeight = viewportWidth / sourceAspect;
      } else {
        renderedWidth = viewportHeight * sourceAspect;
      }

      const left = Math.max(0, (viewportWidth - renderedWidth) / 2);
      const right = Math.max(0, viewportWidth - renderedWidth - left);
      const top = Math.max(0, (viewportHeight - renderedHeight) / 2);
      const bottom = Math.max(0, viewportHeight - renderedHeight - top);

      viewerRoot.style.setProperty('--video-left', `${left}px`);
      viewerRoot.style.setProperty('--video-right', `${right}px`);
      viewerRoot.style.setProperty('--video-top', `${top}px`);
      viewerRoot.style.setProperty('--video-bottom', `${bottom}px`);
    }

    // Parse stream ID from URL path
    function parseStreamId() {
      const pathParts = window.location.pathname.split('/').filter(p => p);
      streamId = pathParts[pathParts.length - 1];
      
      if (streamId && /^[a-z][a-z0-9]{4}$/i.test(streamId)) {
        startConnection();
      } else {
        setStatus('waiting', 'Invalid stream ID');
        setOverlay('Invalid Stream', `The stream ID "${streamId}" is not valid. Expected format: letter + 4 alphanumeric characters.`);
      }
    }

    function resolveViewerConfig() {
      const params = new URLSearchParams(window.location.search);
      const encodedConfig = params.get(VIEWER_CONFIG_QUERY_PARAMETER);
      if (encodedConfig && encodedConfig.trim()) {
        try {
          const decoded = JSON.parse(decodeBase64Url(encodedConfig.trim()));
          const url = typeof decoded.url === 'string'
            ? normalizeSupabaseUrl(decoded.url)
            : '';
          const key = typeof decoded.key === 'string' ? decoded.key.trim() : '';
          const iceServers = normalizeIceServers(decoded.iceServers);
          if (url && key) {
            return { url, key, iceServers };
          }
        } catch (_) {}
      }

      return {
        url: DEFAULT_SUPABASE_URL,
        key: DEFAULT_SUPABASE_ANON_KEY,
        iceServers: normalizeIceServers(DEFAULT_ICE_SERVERS),
      };
    }

    function normalizeSupabaseUrl(value) {
      if (typeof value !== 'string') {
        return '';
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }

      try {
        const parsed = new URL(trimmed);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
      } catch (_) {
        return trimmed.replace(/[?#]+$/, '');
      }

    }

    function decodeBase64Url(value) {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padding = (4 - (normalized.length % 4)) % 4;
      try {
        return atob(`${normalized}${'='.repeat(padding)}`);
      } catch (_) {
        return '';
      }
    }

    function normalizeIceServerUrls(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
      }

      if (!Array.isArray(value)) {
        return [];
      }

      return value
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter((entry) => entry);
    }

    function normalizeIceServer(server) {
      if (!server || typeof server !== 'object') {
        return null;
      }

      const urls = normalizeIceServerUrls(server.urls);
      if (urls.length === 0) {
        return null;
      }

      const normalized = { urls: urls.length === 1 ? urls[0] : urls };
      if (typeof server.username === 'string' && server.username.trim()) {
        normalized.username = server.username.trim();
      }
      if (typeof server.credential === 'string' && server.credential.trim()) {
        normalized.credential = server.credential.trim();
      }
      return normalized;
    }

    function normalizeIceServers(value) {
      const source = Array.isArray(value) ? value : DEFAULT_ICE_SERVERS;
      const normalized = source
        .map((server) => normalizeIceServer(server))
        .filter((server) => server);
      return normalized.length > 0
        ? normalized
        : DEFAULT_ICE_SERVERS.map((server) => ({ ...server }));
    }

    // Setup event listeners
    function setupEventListeners() {
      // Video events
      video.addEventListener('play', () => {
        isPlaying = true;
        setAutoplayGateVisible(false);
        updateVideoViewportBounds();
        setStatus('live', 'Live');
        setOverlay('Live', 'Connected to stream', true);
        ensureAudioPlayback('video-play');
        updatePlayPauseButton();
      });

      video.addEventListener('pause', () => {
        audio.pause();
        isPlaying = false;
        updatePlayPauseButton();
      });

      video.addEventListener('loadedmetadata', () => {
        console.log('[Viewer] video metadata', {
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
        });
        schedulePlaybackKick('loadedmetadata');
        updateVideoViewportBounds();
      });

      video.addEventListener('canplay', () => {
        schedulePlaybackKick('canplay');
        updateVideoViewportBounds();
      });

      video.addEventListener('loadeddata', () => {
        schedulePlaybackKick('loadeddata');
      });

      video.addEventListener('volumechange', () => {
        updateMuteButton();
      });

      audio.addEventListener('volumechange', () => {
        currentVolume = audio.volume;
        isMuted = audio.muted;
        volumeSlider.value = Math.round(currentVolume * 100);
        updateMuteButton();
        updateVolumeSliderVisual();
      });

      audio.addEventListener('play', () => {
        console.log('[Viewer] audio element play', {
          muted: audio.muted,
          volume: audio.volume,
          readyState: audio.readyState,
        });
      });

      audio.addEventListener('pause', () => {
        console.log('[Viewer] audio element pause');
      });

      audio.addEventListener('waiting', () => {
        console.log('[Viewer] audio element waiting');
      });

      audio.addEventListener('stalled', () => {
        console.log('[Viewer] audio element stalled');
      });

      audio.addEventListener('canplay', () => {
        console.log('[Viewer] audio element canplay');
        ensureAudioPlayback('audio-canplay');
      });

      audio.addEventListener('error', (event) => {
        console.error('[Viewer] audio element error', event);
      });

      video.addEventListener('error', (e) => {
        console.error('Video error:', e);
        setStatus('error', 'Video error');
        setOverlay('Video Error', 'Failed to play the video stream.');
      });

      // Control buttons
      playPauseBtn.addEventListener('click', togglePlayPause);
      muteBtn.addEventListener('click', handleMuteButtonClick);
      volumeSlider.addEventListener('input', handleVolumeChange);
      volumeSlider.addEventListener('input', updateVolumeSliderVisual);
      settingsBtn.addEventListener('click', toggleSettingsMenu);
      overlayPlayBtn.addEventListener('click', () => {
        hasUserInteracted = true;
        setAutoplayGateVisible(false);
        attemptPlay(true);
      });
      window.addEventListener('resize', updateVideoViewportBounds);

      // Menu options
      qualityOptions.addEventListener('click', handleQualitySelect);
      bitrateOptions.addEventListener('click', handleBitrateSelect);

      // Close menus when clicking outside
      document.addEventListener('click', (e) => {
        if (!muteBtn.contains(e.target) && !volumePanel.contains(e.target)) {
          volumePanel.classList.add('hidden');
          muteBtn.classList.remove('active');
        }
        if (!settingsBtn.contains(e.target) && !settingsMenu.contains(e.target)) {
          settingsMenu.classList.add('hidden');
          settingsBtn.classList.remove('active');
        }
      });

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
          e.preventDefault();
          togglePlayPause();
        } else if (e.code === 'KeyM') {
          toggleMute();
        }
      });

      const markInteracted = () => {
        if (hasUserInteracted) return;
        hasUserInteracted = true;
        if (autoMutedForAutoplay) {
          autoMutedForAutoplay = false;
          isMuted = false;
          setAutoplayGateVisible(false);
          schedulePlaybackKick('user-interaction');
          updateMuteButton();
        }
      };

      document.addEventListener('pointerdown', markInteracted, { passive: true });
      document.addEventListener('touchstart', markInteracted, { passive: true });
      document.addEventListener('keydown', markInteracted);
    }

    // Start WebRTC connection
    async function startConnection() {
      try {
        setStatus('connecting', 'Connecting');
        setOverlay('Connecting', 'Establishing connection to stream...');
        clearPlaybackKickTimers();
        stopAudioStatsLogging();
        stopPlaybackStateLogging();
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        currentConnectionId = null;
        streamInfo = null;
        isPlaying = false;
        pendingRemoteCandidates = [];
        remoteDescriptionApplied = false;
        attachedRemoteStream = null;
        
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }

        console.log('[Viewer] stream start', {
          streamId,
          iceServers: viewerConfig.iceServers.map((server) => server.urls),
          supabaseUrl: viewerConfig.url,
        });

        // Create peer connection
        peerConnection = new RTCPeerConnection({
          iceServers: viewerConfig.iceServers
        });

        // Add transceivers
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        // Handle incoming tracks
        peerConnection.ontrack = (event) => {
          console.log('Received track:', event.track.kind);
          event.track.onmute = () => console.log('[Viewer] remote track muted', event.track.kind);
          event.track.onunmute = () => {
            console.log('[Viewer] remote track unmuted', event.track.kind);
            schedulePlaybackKick(`track-unmute-${event.track.kind}`);
          };
          event.track.onended = () =
> console.log('[Viewer] remote track ended', event.track.kind);
          handleIncomingTrack(event.track, event.streams || []);
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            console.log('[Viewer] local ICE candidate', {
              type: candidateType(event.candidate.candidate),
              candidate: event.candidate.candidate,
            });
            sendCandidate({
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            });
          }
        };

        peerConnection.onicecandidateerror = (event) => {
          console.error('[Viewer] ICE candidate error', event);
        };

        peerConnection.oniceconnectionstatechange = () => {
          console.log('[Viewer] ICE connection state:', peerConnection.iceConnectionState);
        };

        peerConnection.onicegatheringstatechange = () => {
          console.log('[Viewer] ICE gathering state:', peerConnection.iceGatheringState);
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
          console.log('Connection state:', peerConnection.connectionState);
          handleConnectionStateChange();
        };

        // Connect to Supabase
        await connectToSupabase();
        
      } catch (error) {
        console.error('Connection error:', error);
        setStatus('error', 'Connection failed');
        setOverlay('Connection Failed', 'Unable to connect to the stream.');
      }
    }

    // Connect to Supabase realtime
    async function connectToSupabase() {
      try {
        if (!supabaseClient) {
          supabaseClient = createClient(viewerConfig.url, viewerConfig.key, {
            realtime: {
              params: {
                eventsPerSecond: 10,
              },
            },
          });
        }

        if (supabaseChannel) {
          await supabaseClient.removeChannel(supabaseChannel);
          supabaseChannel = null;
        }

        supabaseChannel = supabaseClient.channel(`net:${streamId}`, {
          config: {
            broadcast: { self: true },
          },
        });

        supabaseChannel.on('broadcast', { event: 'signal' }, async ({ payload }) => {
          console.log('Supabase message:', payload);

          const body = payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object'
            ? payload.payload
            : payload;
          const destination = payload?.dst || body?.dst || null;

          const envelopeType = (payload?.type || '').toString().toUpperCase();
          const bodyType = (body?.type || '').toString().toUpperCase();
          let msgType = ['OFFER', 'ANSWER', 'CANDIDATE', 'INFO'].includes(envelopeType)
            ? envelopeType
            : bodyType;

          // Some messages from publisher arrive as nested media payloads
          // without explicit ANSWER/CANDIDATE/INFO envelope type.
          if (!['OFFER', 'ANSWER', 'CANDIDATE', 'INFO'].includes(msgType)) {
            if (body?.sdp) {
              msgType = 'ANSWER';
            } else if (body?.candidate) {
              msgType = 'CANDIDATE';
            } else if (body?.stream) {
              msgType = 'INFO';
            }
          }

          if (payload?.src && payload.src === viewerPeerId) {
            return;
          }

          if (destination && destination !== viewerPeerId) {
            return;
          }

          const messageConnectionId = body?.connectionId || null;
          if (['ANSWER', 'CANDIDATE', 'INFO'].includes(msgType)) {
            if (!currentConnectionId || !messageConnectionId || messageConnectionId !== currentConnectionId) {
              return;
            }
          }

          if (msgType === 'ANSWER') {
            await handleAnswer(body);
          } else if (msgType === 'CANDIDATE') {
            await handleCandidate(body);
          } else if (msgType === 'INFO') {
            handleInfo(body);
          }
        });

        await new Promise((resolve, reject) => {
          supabaseChannel.subscribe((status, error) => {
            console.log('Supabase subscribe status:', status, error);
            if (status === 'SUBSCRIBED') {
              resolve();
              return;
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              reject(error || new Error(`Supabase subscribe failed: ${status}`));
            }
          });
        });

        await sendInitialOffer();

      } catch (error) {
        console.error('Supabase connection error:', error);
        throw error;
      }
    }

    function sendSignal(type, payload) {
      if (!supabaseChannel) return;
      supabaseChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          type,
          src: viewerPeerId,
          dst: streamId,
          payload,
        },
      });
    }

    function buildViewerConstraints() {
      return {
        maxHeight: currentQuality === 'auto' ? null : parseInt(currentQuality, 10),
        maxBitrateKbps: currentBitrate === 'auto' ? null : parseInt(currentBitrate, 10),
      };
    }

    function resolveViewerDeviceId() {
      const storageKey = 'localcamera.viewer.deviceId';
      try {
        const existing = window.localStorage.getItem(storageKey);
        if (existing && existing.trim()) {
          return existing.trim();
        }
      } catch (_) {}

      const generated = `vd-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      try {
        window.localStorage.setItem(storageKey, generated);
      } catch (_) {}
      return generated;
    }

    function candidateType(candidateText) {
      const match = / typ ([a-z]+)/i.exec(candidateText || '');
      return match ? match[1].toLowerCase() : 'unknown';
    }

    function clearPlaybackKickTimers() {
      playbackKickTimers.forEach((timerId) => clearTimeout(timerId));
      playbackKickTimers = [];
    }

    function isAutoplayPolicyError(error) {
      if (!error) {
        return false;
      }
      if (error.name === 'NotAllowedError') {
        return true;
      }
      const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
      return message.includes('notallowed') || message.includes('user gesture');
    }

    async function tryMutedAudioBootstrap(reason) {
      if (!audio.srcObject || audio.readyState < 2) {
        return false;
      }

      const targetMuted = isMuted;
      const targetVolume = currentVolume;
      try {
        audio.muted = true;
        audio.volume = Math.max(targetVolume, 0.001);
        await audio.play();
        audio.volume = targetVolume;
        audio.muted = targetMuted;

        let audiblePlaybackStarted = targetMuted || targetVolume <= 0;
        if (!audiblePlaybackStarted) {
          try {
            await audio.play();
            audiblePlaybackStarted = !audio.paused && !audio.muted;
          } catch (error) {
            console.log('[Viewer] audio unmute after muted bootstrap still needs user gesture', {
              reason,
              error: error?.message || String(error),
            });
          }
        }

        autoMutedForAutoplay = !audiblePlaybackStarted;
        if (autoMutedForAutoplay) {
          audio.muted = true;
          setAutoplayGateVisible(true);
        } else {
          setAutoplayGateVisible(false);
        }
        updateMuteButton();
        console.log('[Viewer] audio muted bootstrap completed', {
          reason,
          audiblePlaybackStarted,
          autoMutedForAutoplay,
        });
        return true;
      } catch (error) {
        audio.volume = targetVolume;
        audio.muted = targetMuted;
        console.log('[Viewer] audio muted bootstrap failed',
 {
          reason,
          error: error?.message || String(error),
        });
        return false;
      }
    }

    function ensureAudioPlayback(reason, fromUserGesture = false) {
      if (!audio.srcObject || audio.muted || currentVolume <= 0) {
        return;
      }
      if (!audio.paused) {
        return;
      }
      const playPromise = fromUserGesture || hasUserInteracted
        ? audio.play()
        : audio.play();
      Promise.resolve(playPromise)
        .then(() => {
          console.log('[Viewer] audio resume succeeded', {
            reason,
            muted: audio.muted,
            volume: audio.volume,
            paused: audio.paused,
          });
        })
        .catch((error) => {
          if (isAutoplayPolicyError(error) && !fromUserGesture) {
            tryMutedAudioBootstrap(`ensure-${reason}`).then((bootstrapped) => {
              if (!bootstrapped) {
                console.log('[Viewer] audio resume blocked', {
                  reason,
                  error: error?.message || String(error),
                });
              }
            });
            return;
          }
          console.log('[Viewer] audio resume blocked', {
            reason,
            error: error?.message || String(error),
          });
        });
    }

    function schedulePlaybackKick(reason) {
      if (!video.srcObject) {
        return;
      }
      clearPlaybackKickTimers();
      [0, 120, 360, 900, 1800].forEach((delay) => {
        const timerId = window.setTimeout(() => {
          if (isPlaying) {
            ensureAudioPlayback(`kick-${reason}`, reason === 'user-interaction');
            return;
          }
          attemptPlay(reason === 'user-interaction');
        }, delay);
        playbackKickTimers.push(timerId);
      });
    }

    function stopAudioStatsLogging() {
      if (audioStatsInterval != null) {
        window.clearInterval(audioStatsInterval);
        audioStatsInterval = null;
      }
    }

    function stopPlaybackStateLogging() {
      if (playbackStateInterval != null) {
        window.clearInterval(playbackStateInterval);
        playbackStateInterval = null;
      }
    }

    function logPlaybackState(reason) {
      const stream = audio.srcObject || video.srcObject;
      const audioTracks = stream?.getAudioTracks?.() || [];
      const videoTracks = stream?.getVideoTracks?.() || [];
      const activeAudioTrack = audioTracks[0] || null;

      console.log('[Viewer] playback state', {
        reason,
        connectionId: currentConnectionId,
        isPlaying,
        hasUserInteracted,
        autoMutedForAutoplay,
        audioElement: {
          muted: audio.muted,
          volume: audio.volume,
          paused: audio.paused,
          readyState: audio.readyState,
          currentTime: audio.currentTime,
          srcObject: !!audio.srcObject,
        },
        videoElement: {
          muted: video.muted,
          volume: video.volume,
          paused: video.paused,
          readyState: video.readyState,
          currentTime: video.currentTime,
          width: video.videoWidth,
          height: video.videoHeight,
          srcObject: !!video.srcObject,
        },
        streamTracks: {
          audioCount: audioTracks.length,
          videoCount: videoTracks.length,
          activeAudioTrack: activeAudioTrack
            ? {
                id: activeAudioTrack.id,
                enabled: activeAudioTrack.enabled,
                muted: activeAudioTrack.muted,
                readyState: activeAudioTrack.readyState,
              }
            : null,
        },
      });
    }

    function startPlaybackStateLogging() {
      stopPlaybackStateLogging();
      logPlaybackState('stream-attached');
      playbackStateInterval = window.setInterval(() => {
        logPlaybackState('interval');
      }, 3000);
    }

    function startAudioStatsLogging() {
      stopAudioStatsLogging();
      if (!peerConnection) {
        return;
      }
      audioStatsInterval = window.setInterval(async () => {
        if (!peerConnection) {
          return;
        }
        try {
          const stats = await peerConnection.getStats();
          let inboundAudio = null;
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              inboundAudio = {
                reportId: report.id,
                connectionId: currentConnectionId,
                codecId: report.codecId,
                trackIdentifier: report.trackIdentifier || report.trackId || null,
                bytesReceived: report.bytesReceived,
                packetsReceived: report.packetsReceived,
                packetsLost: report.packetsLost,
                jitter: report.jitter,
                packetsDiscarded: report.packetsDiscarded,
                totalAudioEnergy: report.totalAudioEnergy,
                totalSamplesDuration: report.totalSamplesDuration,
                audioLevel: report.audioLevel,
              };
            }
          });
          if (inboundAudio) {
            console.log('[Viewer] inbound audio RTP', inboundAudio);
          }
        } catch (error) {
          console.warn('[Viewer] getStats audio failed', error);
        }
      }, 3000);
    }

    async function sendInitialOffer({ reuseConnection = false } = {}) {
      if (!reuseConnection || !currentConnectionId) {
        currentConnectionId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      }
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await peerConnection.setLocalDescription(offer);

      sendSignal('OFFER', {
        type: 'media',
        connectionId: currentConnectionId,
        sdp: {
          type: offer.type,
          sdp: offer.sdp || '',
        },
        metadata: {
          viewerSessionId,
          viewerDeviceId,
          constraints: buildViewerConstraints(),
        },
      });
    }

    // Handle WebRTC offer
    async function handleOffer(offer) {
      try {
        console.log('Received offer:', offer);

        const offerSdp = typeof offer?.sdp === 'string'
          ? offer.sdp
          : offer?.sdp?.sdp;
        const offerType = typeof offer?.sdp === 'object' && offer?.sdp?.type
          ? offer.sdp.type
          : 'offer';
        const remoteOffer = offerSdp
          ? { type: offerType, sdp: offerSdp }
          : offer;

        await peerConnection.setRemoteDescription(remoteOffer);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // Send answer back
        sendAnswer(answer);

      } catch (error) {
        console.error('Offer handling error:', error);
        setStatus('error', 'Stream error');
        setOverlay('Stream Error', 'Failed to process stream signal.');
      }
    }

    function sendAnswer(answer, connectionId = currentConnectionId) {
      sendSignal('ANSWER', {
        type: 'media',
        connectionId,
        sdp: {
          type: answer.type,
          sdp: answer.sdp || '',
        },
      });
    }

    async function flushPendingRemoteCandidates() {
      if (!pendingRemoteCandidates.length || !peerConnection || !remoteDescriptionApplied) {
        return;
      }

      const pending = pendingRemoteCandidates.slice();
      pendingRemoteCandidates = [];
      console.log('[Viewer] flushing queued remote ICE candidates', {
        connectionId: currentConnectionId,
        queuedCount: pending.length,
      });
      for (const candidateMessage of pending) {
        await handleCandidate(candidateMessage);
      }
    }

    function sendCandidate(candidate) {
      sendSignal('CANDIDATE', {
        type: 'media',
        connectionId: currentConnectionId,
        candidate,
      });
    }

    // Handle WebRTC answer (from publisher)
    async function handleAnswer(message) {
     
 try {
        const answerSdp = typeof message?.sdp === 'string'
          ? message.sdp
          : message?.sdp?.sdp;
        const answerType = typeof message?.sdp === 'object' && message?.sdp?.type
          ? message.sdp.type
          : 'answer';
        const answer = answerSdp
          ? { type: answerType, sdp: answerSdp }
          : message;
        await peerConnection.setRemoteDescription(answer);
        remoteDescriptionApplied = true;
        console.log('[Viewer] answer applied');
        await flushPendingRemoteCandidates();
      } catch (error) {
        console.error('Answer handling error:', error);
      }
    }

    // Handle ICE candidate
    async function handleCandidate(message) {
      try {
        const candidate = message.payload?.candidate || message.candidate;
        if (candidate) {
          const normalized = typeof candidate === 'string'
            ? { candidate, sdpMid: null, sdpMLineIndex: null }
            : {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null,
              };
          if (!peerConnection || !remoteDescriptionApplied) {
            pendingRemoteCandidates.push(message);
            console.log('[Viewer] queued remote ICE candidate until answer is applied', {
              connectionId: currentConnectionId,
              queuedCount: pendingRemoteCandidates.length,
              type: candidateType(normalized.candidate),
            });
            return;
          }
          console.log('[Viewer] remote ICE candidate', {
            type: candidateType(normalized.candidate),
            candidate: normalized.candidate,
          });
          await peerConnection.addIceCandidate(normalized);
        }
      } catch (error) {
        console.error('Candidate handling error:', error);
      }
    }

    function handleInfo(message) {
      const infoPayload = message.payload || message;
      const stream = infoPayload.stream;
      if (!stream) return;

      const preset = stream.preset || {};
      const width = Number(preset.width) || streamInfo?.width || 0;
      const height = Number(preset.height) || streamInfo?.height || 0;
      const frameRate = Number(preset.fps) || streamInfo?.frameRate || 30;
      const maxBitrate = Number(stream.bitrateKbps) || streamInfo?.maxBitrate || 0;
      const videoCodec = stream.videoCodec || streamInfo?.videoCodec || null;
      const audioCodec = stream.audioCodec || streamInfo?.audioCodec || null;

      streamInfo = {
        width,
        height,
        frameRate,
        maxBitrate,
        videoCodec,
        audioCodec,
      };
      console.log('[Viewer] stream info', streamInfo);
      updateQualityOptions();
      updateBitrateOptions();
    }

    function ensureAttachedRemoteStream() {
      if (!attachedRemoteStream) {
        attachedRemoteStream = new MediaStream();
      }
      return attachedRemoteStream;
    }

    function syncAttachedRemoteStream(track, sourceStreams) {
      const mergedStream = ensureAttachedRemoteStream();
      const existingTracks = mergedStream.getTracks();
      existingTracks
        .filter((candidate) => candidate.kind === track.kind && candidate.id !== track.id)
        .forEach((candidate) => mergedStream.removeTrack(candidate));
      if (!existingTracks.some((candidate) => candidate.id === track.id)) {
        mergedStream.addTrack(track);
      }
      console.log('[Viewer] merged remote track', {
        kind: track.kind,
        trackId: track.id,
        sourceStreamIds: sourceStreams.map((stream) => stream?.id).filter(Boolean),
        mergedAudioTracks: mergedStream.getAudioTracks().map((candidate) => candidate.id),
        mergedVideoTracks: mergedStream.getVideoTracks().map((candidate) => candidate.id),
      });
      return mergedStream;
    }

    function handleIncomingTrack(track, sourceStreams) {
      const mergedStream = syncAttachedRemoteStream(track, sourceStreams);
      handleIncomingStream(mergedStream);
    }

    // Handle incoming media stream
    function handleIncomingStream(stream) {
      console.log('Received stream:', stream);
      console.log('Audio tracks:', stream.getAudioTracks().length);
      console.log('Video tracks:', stream.getVideoTracks().length);

      // Fallback stream info from track settings if INFO has not arrived yet
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        console.log('[Viewer] audio track state', {
          enabled: audioTrack.enabled,
          muted: audioTrack.muted,
          readyState: audioTrack.readyState,
          settings: audioTrack.getSettings?.(),
        });
      } else {
        console.warn('[Viewer] no remote audio tracks in stream');
      }
      if (videoTrack && !streamInfo) {
        const settings = videoTrack.getSettings();
        streamInfo = {
          width: settings.width || 1920,
          height: settings.height || 1080,
          frameRate: settings.frameRate || 30,
          maxBitrate: 3000,
        };
        updateQualityOptions();
        updateBitrateOptions();
      }

      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      video.srcObject = hasVideo ? stream : null;
      audio.srcObject = hasAudio ? stream : null;
      updateVideoViewportBounds();

      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      audio.autoplay = true;
      audio.muted = isMuted;
      audio.volume = currentVolume;
      console.log('[Viewer] attached media stream', {
        connectionId: currentConnectionId,
        videoPlaybackTracks: (video.srcObject?.getVideoTracks?.() || []).map((track) => ({
          id: track.id,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
        audioPlaybackTracks: (audio.srcObject?.getAudioTracks?.() || []).map((track) => ({
          id: track.id,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
        audioTracks: stream.getAudioTracks().map((track) => ({
          id: track.id,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
        videoTracks: stream.getVideoTracks().map((track) => ({
          id: track.id,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
      });
      startAudioStatsLogging();
      startPlaybackStateLogging();
      ensureAudioPlayback('stream-attached');

      schedulePlaybackKick('stream-attached');
      
      setStatus('connecting', 'Connecting media');
      setOverlay('Connecting media', 'Receiving video and audio...');
      
      reconnectAttempts = 0;
    }

    // Update quality options based on stream info and screen resolution
    function updateQualityOptions() {
      if (!streamInfo) return;

      const sourceMaxHeight = Number(streamInfo.height) || 0;
      if (sourceMaxHeight <= 0) {
        return;
      }
      
      const baseHeights = [360, 480, 720, 1080, 1440, 2160];
      const heights = baseHeights.filter(h => h <= sourceMaxHeight);
      if (!heights.includes(sourceMaxHeight)) {
        heights.push(sourceMaxHeight);
      }

      heights.sort((a, b) => a - b);

      const qualities = [
        { label: 'Auto', value: 'auto', height: null },
        ...heights.map(h => ({ label: `${h}p`, value: h, height: h })),
      ];

      // Filter out duplicates and options higher than stream
      const filteredQualities = qualities.filter((q, index, arr) => 
        arr.findIndex(x => x.value === q.value) === index && 
        (q.value === 'auto' || q.height <= 
streamInfo.height)
      );

      qualityOptions.innerHTML = '';
      filteredQualities.forEach(quality => {
        const button = document.createElement('button');
        const qualityValue = quality.value === 'auto' ? 'auto' : String(quality.value);
        button.className = 'menu-option';
        button.setAttribute('data-quality', qualityValue);
        button.textContent = quality.label;
        if (qualityValue === currentQuality) {
          button.classList.add('active');
        }
        qualityOptions.appendChild(button);
      });
    }

    // Update bitrate options based on stream info
    function updateBitrateOptions() {
      if (!streamInfo) return;

      const maxBitrate = Number(streamInfo.maxBitrate) || 0;
      const steps = [500, 1000, 2000, 3000, 5000, 8000, 10000];
      const numeric = steps.filter(v => v <= maxBitrate);
      if (maxBitrate > 0 && !numeric.includes(maxBitrate)) {
        numeric.push(maxBitrate);
      }

      const bitrates = [
        { label: 'Auto', value: 'auto' },
        ...numeric.sort((a, b) => a - b).map(v => ({
          label: v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} Mbps` : `${v} Kbps`,
          value: v,
        })),
      ];

      // Filter out options higher than stream max bitrate
      const filteredBitrates = bitrates.filter(bitrate => 
        bitrate.value === 'auto' || bitrate.value <= streamInfo.maxBitrate
      );

      bitrateOptions.innerHTML = '';
      filteredBitrates.forEach(bitrate => {
        const button = document.createElement('button');
        const bitrateValue = bitrate.value === 'auto' ? 'auto' : String(bitrate.value);
        button.className = 'menu-option';
        button.setAttribute('data-bitrate', bitrateValue);
        button.textContent = bitrate.label;
        if (bitrateValue === currentBitrate) {
          button.classList.add('active');
        }
        bitrateOptions.appendChild(button);
      });
    }

    // Attempt to play video
    async function attemptPlay(fromUserGesture = false) {
      if (!video.srcObject) {
        return;
      }
      try {
        if (fromUserGesture && autoMutedForAutoplay) {
          isMuted = false;
          autoMutedForAutoplay = false;
        }
        await video.play();
        audio.muted = isMuted;
        audio.volume = currentVolume;
        try {
          if (fromUserGesture || hasUserInteracted) {
            await audio.play();
          } else {
            try {
              await audio.play();
            } catch (_) {}
          }
          console.log('Media started playing successfully', {
            route: 'hidden-audio-element',
            videoMuted: video.muted,
            videoVolume: video.volume,
            audioMuted: audio.muted,
            audioVolume: audio.volume,
          });
          logPlaybackState('play-success');
          setStatus('live', 'Live');
          setOverlay('Live', 'Connected to stream', true);
          clearPlaybackKickTimers();
        } catch (error) {
          const blockedByPolicy = isAutoplayPolicyError(error);
          if (blockedByPolicy) {
            const bootstrapped = await tryMutedAudioBootstrap('attempt-play');
            if (bootstrapped) {
              if (autoMutedForAutoplay) {
                video.pause();
                audio.pause();
                isPlaying = false;
                autoplayGateShown = true;
                setStatus('connecting', 'Tap to unmute');
                setOverlay('', '', false);
              } else {
                setStatus('live', 'Live');
                setOverlay('Live', 'Connected to stream', true);
              }
              clearPlaybackKickTimers();
              updatePlayPauseButton();
              return;
            }
            console.log('Audio autoplay blocked by policy, waiting for explicit user play:', error);
            autoMutedForAutoplay = true;
            audio.muted = true;
            updateMuteButton();
            autoplayGateShown = true;
            video.pause();
            audio.pause();
            isPlaying = false;
            updatePlayPauseButton();
            setAutoplayGateVisible(true);
            setStatus('connecting', 'Tap to play');
            setOverlay('', '', false);
          } else {
            console.log('Audio play deferred, scheduling retry:', error);
            autoMutedForAutoplay = false;
            schedulePlaybackKick('audio-retry');
            setStatus('live', 'Live');
            setOverlay('Live', 'Connected to stream', true);
          }
        }
        updatePlayPauseButton();
      } catch (error) {
        console.log('Playback attempt failed:', error);
        logPlaybackState('play-failed');
        if (fromUserGesture) {
          setStatus('connecting', 'Waiting for playback');
          setOverlay('Play', 'Tap play again to start the stream', false);
          updatePlayPauseButton();
          return;
        }
        setStatus('connecting', 'Loading');
        setOverlay('Loading stream', 'Waiting for the first frame...', false);
      }
    }

    // Handle connection state changes
    function handleConnectionStateChange() {
      const state = peerConnection.connectionState;
      console.log('Connection state changed to:', state);
      
      switch (state) {
        case 'connected':
          setStatus('live', 'Live');
          break;
        case 'disconnected':
        case 'failed':
          handleDisconnection();
          break;
        case 'closed':
          cleanup();
          break;
      }
    }

    // Handle disconnection
    function handleDisconnection() {
      if (reconnectTimeout) {
        return;
      }
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 8)), 10000);
      setStatus('connecting', 'Reconnecting');
      setOverlay('Reconnecting', `Attempt ${reconnectAttempts}. Restoring stream...`);

      reconnectTimeout = setTimeout(() => {
        console.log(`Reconnection attempt ${reconnectAttempts}`);
        startConnection();
      }, delay);
    }

    // UI Controls
    function togglePlayPause() {
      if (isPlaying) {
        video.pause();
        audio.pause();
        setStatus('connecting', 'Paused');
        setOverlay('Paused', 'Press play to start', false);
      } else {
        attemptPlay(true);
      }
    }

    function toggleVolumePanel(event) {
      event?.stopPropagation?.();
      const nextVisible = volumePanel.classList.contains('hidden');
      volumePanel.classList.toggle('hidden');
      muteBtn.classList.toggle('active', nextVisible);
      settingsMenu.classList.add('hidden');
      settingsBtn.classList.remove('active');
    }

    function handleMuteButtonClick(event) {
      event?.stopPropagation?.();
      const shouldUnmute = autoMutedForAutoplay || audio.muted || currentVolume <= 0;
      if (!shouldUnmute) {
        toggleVolumePanel(event);
        return;
      }

      if (currentVolume <= 0) {
        currentVolume = 0.8;
        volumeSlider.value = Math.round(currentVolume * 100);
      }

      hasUserInteracted = true;
      autoMutedForAutoplay = false;
      isMuted = false;
      audio.muted = false;
      audio.volume = currentVolume;
      audio.play().catch(() => {});
      schedulePlaybackKick('mute-button-unmute');
      volumePanel.classList.remove('hidden');
      muteBtn.classList.add('active');
      updateMuteButton();
      logPlaybackState('mute-button-unmute');
    }

    function toggleMute() {
      const nextMuted = !audio.muted && currentVolume > 0;
      isMuted = nextMuted;
      audio.muted = nextMuted;
      if (!isMuted) {
        autoMutedForAutoplay = false;
        audio.play().catch(() => {});
      }
      volumePanel.classList.remove('hidden');
      muteBtn.classList.add('active');
      updateMuteButton();
    }

    function handleVolumeChange(event) {
      currentVolume = Number(event.target.value) / 100;
      a
udio.volume = currentVolume;
      
      // Unmute if volume is set above 0
      if (currentVolume > 0) {
        isMuted = false;
        audio.muted = false;
        autoMutedForAutoplay = false;
        audio.play().catch(() => {});
      } else {
        isMuted = true;
        audio.muted = true;
      }
      
      updateMuteButton();
      updateVolumeSliderVisual();
    }

    function toggleSettingsMenu(event) {
      event?.stopPropagation?.();
      const nextVisible = settingsMenu.classList.contains('hidden');
      settingsMenu.classList.toggle('hidden');
      settingsBtn.classList.toggle('active', nextVisible);
      volumePanel.classList.add('hidden');
      muteBtn.classList.remove('active');
    }

    function handleQualitySelect(e) {
      if (e.target.classList.contains('menu-option')) {
        const quality = e.target.getAttribute('data-quality');
        currentQuality = quality;
        
        // Update active state
        qualityOptions.querySelectorAll('.menu-option').forEach(btn => {
          btn.classList.remove('active');
        });
        e.target.classList.add('active');
        
        // Re-negotiate so publisher applies new constraint limits
        applyQualityConstraint(quality);
        
        settingsMenu.classList.add('hidden');
        settingsBtn.classList.remove('active');
      }
    }

    function handleBitrateSelect(e) {
      if (e.target.classList.contains('menu-option')) {
        const bitrate = e.target.getAttribute('data-bitrate');
        currentBitrate = bitrate;
        
        // Update active state
        bitrateOptions.querySelectorAll('.menu-option').forEach(btn => {
          btn.classList.remove('active');
        });
        e.target.classList.add('active');
        
        // Re-negotiate so publisher applies new constraint limits
        applyBitrateConstraint(bitrate);
        
        settingsMenu.classList.add('hidden');
        settingsBtn.classList.remove('active');
      }
    }

    function applyQualityConstraint(quality) {
      if (!peerConnection) return;
      sendInitialOffer({ reuseConnection: true }).catch(console.error);
    }

    function applyBitrateConstraint(bitrate) {
      if (!peerConnection) return;
      sendInitialOffer({ reuseConnection: true }).catch(console.error);
    }

    // UI Updates
    function setStatus(status, text) {
      viewerStatus = status;
      statusPill.className = `status-pill ${status}`;
      statusPill.textContent = text;
      syncViewerBlurState();
    }

    function setOverlay(title, text, hidden = false) {
      overlayTitle.textContent = title;
      overlayText.textContent = text;
      overlay.classList.toggle('hidden', hidden);
    }

    function updatePlayPauseButton() {
      if (isPlaying) {
        playPauseIcon.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'); // Pause icon
        playPauseBtn.setAttribute('title', 'Pause');
        playPauseBtn.classList.add('active');
      } else {
        playPauseIcon.setAttribute('d', 'M8 5v14l11-7z'); // Play icon
        playPauseBtn.setAttribute('title', 'Play');
        playPauseBtn.classList.remove('active');
      }
    }

    function updateMuteButton() {
      if (audio.muted || currentVolume <= 0) {
        muteIcon.setAttribute('d', 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z'); // Muted icon
        muteBtn.setAttribute('title', 'Volume');
        muteBtn.classList.remove('active');
      } else {
        muteIcon.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'); // Unmuted icon
        muteBtn.setAttribute('title', 'Volume');
      }
    }

    // Cleanup
    function cleanup() {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      stopAudioStatsLogging();
      stopPlaybackStateLogging();
      currentConnectionId = null;
      streamInfo = null;
      isPlaying = false;
      
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      
      if (supabaseClient && supabaseChannel) {
        supabaseClient.removeChannel(supabaseChannel);
        supabaseChannel = null;
      }
      
      if (video.srcObject) {
        video.srcObject = null;
      }

      clearPlaybackKickTimers();
      audio.pause();
      audio.srcObject = null;
      attachedRemoteStream = null;
    }

    // Start the viewer
    init();

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);

