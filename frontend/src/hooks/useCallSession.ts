/**
 * useCallSession Hook
 * ====================
 * 
 * This hook encapsulates all WebRTC call logic for a video call session.
 * It manages:
 * - WebSocket signaling connection lifecycle
 * - RTCPeerConnection setup and state
 * - ICE candidate exchange and connectivity
 * - Media stream acquisition and attachment
 * - Reconnection handling (both WebSocket and WebRTC)
 * - Peer disconnection detection and recovery
 * 
 * Architecture Overview:
 * ----------------------
 * 1. Session initialization (triggered by callId)
 * 2. Local media acquisition (camera/microphone)
 * 3. TURN server configuration fetch
 * 4. RTCPeerConnection creation with ICE servers
 * 5. WebSocket signaling subscription
 * 6. SDP offer/answer exchange (host creates offer, guest answers)
 * 7. ICE candidate trickle exchange
 * 8. Connection established -> media flows
 * 
 * Reconnection Flow:
 * ------------------
 * - On ICE disconnected: wait 3s, then ICE restart (host-initiated)
 * - On ICE failed: immediate ICE restart
 * - On peer WebSocket disconnect: show warning, wait 30s for reconnect
 * - On WebSocket reconnect: renegotiate WebRTC session
 * 
 * Role-based behavior:
 * --------------------
 * - Host: Creates SDP offer, initiates ICE restarts
 * - Guest: Waits for offer, responds with answer
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTurnConfig } from '../services/api';
import { acquireLocalMedia, getLocalStream, releaseLocalStream } from '../services/media';
import { getSessionState, setCallContext, setPeerContext, SessionState } from '../services/session';
import { CallStatus, PeerRole, ReconnectionState } from '../services/types';
import { SignalingClient, SignalingSubscription, subscribeToSignaling } from '../services/signaling';
import type { WSState } from './useSignaling';
import { MediaRouteMode } from './uiConsts';

/**
 * Formats an ICE candidate into a human-readable string for debugging.
 * Extracts candidate type (host/srflx/relay), network type, relay protocol,
 * and address:port information.
 */
const describeCandidate = (candidate: any) => {
  if (!candidate) {
    return '';
  }
  const segments: string[] = [];
  if (candidate.candidateType) {
    segments.push(candidate.candidateType);
  }
  if (candidate.networkType) {
    segments.push(candidate.networkType);
  }
  if (candidate.relayProtocol) {
    segments.push(candidate.relayProtocol);
  }
  const host = candidate.address ?? candidate.ip;
  if (host) {
    segments.push(candidate.port ? `${host}:${candidate.port}` : host);
  }
  return segments.join(' · ');
};

/**
 * Exported state from useCallSession hook.
 * All reactive state that the UI needs to render the call page.
 */
export interface UseCallSessionState {
  /** Current session metadata (callId, peerId, role) */
  sessionInfo: SessionState;
  /** WebSocket signaling connection state */
  wsState: WSState;
  /** High-level call status: waiting/active/ended */
  callStatus: CallStatus;
  /** Number of participants in the call (1 or 2) */
  participants: number;
  /** Error message to display, if any */
  error: string | null;
  /** Remote peer's MediaStream (video/audio) */
  remoteStream: MediaStream | null;
  /** Local MediaStream (camera/mic) */
  localStreamState: MediaStream | null;
  /** RTCPeerConnection state: new/connecting/connected/disconnected/failed/closed */
  peerConnectionState: RTCPeerConnectionState | 'new';
  /** ICE connection state: new/checking/connected/completed/disconnected/failed/closed */
  iceConnectionState: RTCIceConnectionState | 'new';
  /** Media route info: direct P2P or via TURN relay */
  mediaRoute: { mode: MediaRouteMode; detail?: string };
  /** Temporary status message (cleared automatically when connection established) */
  transientMessage: string | null;
  /** Reconnection state: connected/reconnecting/peer-disconnected/failed */
  reconnectionState: ReconnectionState;
  /** True when the remote peer has disconnected (WebSocket level) */
  peerDisconnected: boolean;
}

export interface UseCallSessionActions {
  setTransientMessage: (message: string | null) => void;
  hangup: () => void;
}

export interface UseCallSessionResult {
  state: UseCallSessionState;
  actions: UseCallSessionActions;
}

export function useCallSession(callId: string | undefined): UseCallSessionResult {
  // ============================================================
  // REACTIVE STATE
  // These trigger re-renders and are exposed to the UI
  // ============================================================
  const [sessionInfo, setSessionInfo] = useState<SessionState>(() => getSessionState());
  
  // Ref to hold connection params without triggering re-renders.
  // Used inside callbacks to get current role/peerId without stale closures.
  const connectionParamsRef = useRef<{ peerId?: string; role: PeerRole }>({
    peerId: sessionInfo.peerId,
    role: sessionInfo.role ?? 'host',
  });

  const [wsState, setWsState] = useState<WSState>('connecting');
  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const [participants, setParticipants] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(getLocalStream());
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState | 'new'>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'new'>('new');
  const [mediaRoute, setMediaRoute] = useState<{ mode: MediaRouteMode; detail?: string }>({ mode: 'unknown' });
  const [transientMessage, setTransientMessage] = useState<string | null>(null);
  const [reconnectionState, setReconnectionState] = useState<ReconnectionState>('connected');
  const [peerDisconnected, setPeerDisconnected] = useState(false);

  // ============================================================
  // REFS (mutable, non-reactive)
  // Used for WebRTC objects and timers that shouldn't trigger renders
  // ============================================================
  const signalingRef = useRef<SignalingClient | null>(null);           // WebSocket client
  const signalingSubscriptionRef = useRef<SignalingSubscription | null>(null); // Subscription handle
  const pcRef = useRef<RTCPeerConnection | null>(null);                // RTCPeerConnection instance
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);      // ICE candidates received before remote description set
  const offerSentRef = useRef(false);                                  // Guard to prevent duplicate offers
  const iceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);  // Timer for delayed ICE restart
  const iceRestartFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Timer for fallback to full recreate
  const peerDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Timer for peer disconnect timeout (30s)
  const recreateAttemptsRef = useRef(0);                               // Counter for peer connection recreate attempts
  const isRecreatingRef = useRef(false);                               // Guard to prevent concurrent recreations
  const lastRtcConfigRef = useRef<RTCConfiguration>({});               // Cached RTC config for recreations
  
  // ============================================================
  // SYNC EFFECTS
  // Keep refs in sync with reactive state for use in callbacks
  // ============================================================
  
  // Keep connectionParamsRef synchronized with sessionInfo changes.
  // This allows callbacks to access current role/peerId without stale closures.
  useEffect(() => {
    connectionParamsRef.current = {
      peerId: sessionInfo.peerId,
      role: sessionInfo.role ?? connectionParamsRef.current.role ?? 'host',
    };
  }, [sessionInfo.peerId, sessionInfo.role]);

  // When callId changes (from URL), update the session context.
  // This persists the callId to sessionStorage for potential recovery.
  useEffect(() => {
    if (!callId) {
      return;
    }
    setCallContext(callId);
    setSessionInfo((prev) => ({ ...prev, callId }));
  }, [callId]);

  // ============================================================
  // UTILITY CALLBACKS
  // Small helper functions for state resets
  // ============================================================
  
  /** Reset media route detection to unknown state */
  const resetMediaRoute = useCallback(() => {
    setMediaRoute({ mode: 'unknown' });
  }, []);

  /** Reset peer reconnection state and clear any pending disconnect timer */
  const resetPeerReconnection = useCallback(() => {
    setPeerDisconnected(false);
    setReconnectionState('connected');
    if (peerDisconnectTimerRef.current) {
      clearTimeout(peerDisconnectTimerRef.current);
      peerDisconnectTimerRef.current = null;
    }
  }, []);

  // ============================================================
  // MEDIA ROUTE DETECTION
  // Inspects RTCPeerConnection stats to determine if media flows
  // directly (P2P) or via TURN relay server
  // ============================================================
  
  /**
   * Queries RTCPeerConnection stats to determine the active ICE candidate pair.
   * Updates mediaRoute state with:
   * - mode: 'direct' (P2P) or 'relay' (via TURN)
   * - detail: human-readable info about local/remote candidates
   */
  const updateMediaRoute = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }
    try {
      const stats = await pc.getStats();
      let selectedPair: any;
      let selectedPairId: string | undefined;

      stats.forEach((report: any) => {
        if (!selectedPairId && report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId as string;
        }
      });

      if (selectedPairId) {
        selectedPair = stats.get(selectedPairId);
      }

      if (!selectedPair) {
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
            if (!selectedPair) {
              selectedPair = report;
            }
          }
        });
      }

      if (!selectedPair) {
        setMediaRoute({ mode: 'unknown' });
        return;
      }

      const localCandidate = selectedPair.localCandidateId ? stats.get(selectedPair.localCandidateId) : undefined;
      const remoteCandidate = selectedPair.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) : undefined;

      const usesRelay =
        (localCandidate && localCandidate.candidateType === 'relay') ||
        (remoteCandidate && remoteCandidate.candidateType === 'relay');

      const detailParts: string[] = [];
      if (localCandidate) {
        const summary = describeCandidate(localCandidate);
        if (summary) {
          detailParts.push(`локальный: ${summary}`);
        }
      }
      if (remoteCandidate) {
        const summary = describeCandidate(remoteCandidate);
        if (summary) {
          detailParts.push(`удалённый: ${summary}`);
        }
      }

      setMediaRoute({
        mode: usesRelay ? 'relay' : 'direct',
        detail: detailParts.join(' | ') || undefined,
      });
    } catch (err) {
      console.warn('[CALL] Failed to inspect media route', err);
    }
  }, []);

  // ============================================================
  // SESSION TEARDOWN
  // Cleanup function for all WebRTC and signaling resources
  // ============================================================
  
  /**
   * Tears down the entire call session:
   * - Unsubscribes from signaling WebSocket
   * - Clears all pending timers
   * - Closes RTCPeerConnection
   * - Releases local media tracks
   * - Optionally preserves state (for component unmount without full reset)
   */
  const teardownSession = useCallback((options?: { preserveState?: boolean }) => {
    if (signalingSubscriptionRef.current) {
      signalingSubscriptionRef.current.unsubscribe();
      signalingSubscriptionRef.current = null;
    }
    if (signalingRef.current) {
      if (options?.preserveState) {
        signalingRef.current = null;
      } else {
        signalingRef.current.close();
        signalingRef.current = null;
      }
    }
    if (iceRestartTimerRef.current) {
      clearTimeout(iceRestartTimerRef.current);
      iceRestartTimerRef.current = null;
    }
    if (iceRestartFallbackTimerRef.current) {
      clearTimeout(iceRestartFallbackTimerRef.current);
      iceRestartFallbackTimerRef.current = null;
    }
    if (peerDisconnectTimerRef.current) {
      clearTimeout(peerDisconnectTimerRef.current);
      peerDisconnectTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pendingCandidatesRef.current = [];
    offerSentRef.current = false;
    isRecreatingRef.current = false;
    releaseLocalStream();
    if (!options?.preserveState) {
      recreateAttemptsRef.current = 0;
      setRemoteStream(null);
      setLocalStreamState(null);
      setPeerConnectionState('new');
      setIceConnectionState('new');
      setWsState('disconnected');
      setReconnectionState('connected');
      setPeerDisconnected(false);
      resetMediaRoute();
    }
  }, [resetMediaRoute]);

  // ============================================================
  // SIGNALING HELPERS
  // Functions for sending messages via WebSocket
  // ============================================================
  
  /** Send a signaling message via WebSocket (offer, answer, ice-candidate, etc.) */
  const sendSignal = useCallback((type: string, data?: unknown) => {
    if (!signalingRef.current) {
      console.warn('[CALL] Signaling is not ready, unable to send', type);
      return;
    }
    signalingRef.current.send({ type, data });
  }, []);

  // ============================================================
  // ICE RESTART
  // Handles WebRTC reconnection when ICE connectivity is lost
  // ============================================================
  
  /**
   * Performs an ICE restart to recover from connectivity issues.
   * Only the host initiates the restart (creates new offer with iceRestart: true).
   * The guest waits for the new offer from the host.
   */
  const performIceRestart = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }

    // Инициируем ICE restart со стороны хоста, гость ожидает новое предложение
    if (connectionParamsRef.current.role !== 'host') {
      setTransientMessage('Ожидаем переподключение собеседника...');
      setReconnectionState('reconnecting');
      return;
    }

    try {
      setTransientMessage('Переподключаем медиасессию...');
      setReconnectionState('reconnecting');
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      offerSentRef.current = true;
      sendSignal('offer', offer);
    } catch (err) {
      console.error('[CALL] ICE restart failed', err);
      setError('Не удалось переподключить медиасессию. Попробуйте создать новую ссылку.');
      setReconnectionState('failed');
    }
  }, [sendSignal]);

  /**
   * Completely recreates the RTCPeerConnection with fresh ICE candidates.
   * Used when ICE restart fails (e.g., after network change where IP changed).
   * 
   * This function:
   * 1. Closes the existing RTCPeerConnection
   * 2. Optionally fetches fresh TURN credentials
   * 3. Creates a new RTCPeerConnection
   * 4. Re-adds local media tracks
   * 5. Sets up event handlers
   * 6. Host initiates new offer, guest waits
   * 
   * @param options.fetchNewTurnConfig - if true, fetches fresh TURN credentials
   */
  const recreatePeerConnection = useCallback(async (options?: { fetchNewTurnConfig?: boolean }) => {
    // Guard against concurrent recreations
    if (isRecreatingRef.current) {
      console.log('[CALL] Recreation already in progress, skipping');
      return;
    }

    const maxAttempts = 3;
    if (recreateAttemptsRef.current >= maxAttempts) {
      console.error('[CALL] Max recreate attempts reached');
      setError('Не удалось восстановить соединение после нескольких попыток. Попробуйте создать новую ссылку.');
      setReconnectionState('failed');
      return;
    }

    isRecreatingRef.current = true;
    recreateAttemptsRef.current += 1;
    console.log(`[CALL] Recreating peer connection (attempt ${recreateAttemptsRef.current}/${maxAttempts})`);

    // Clear any pending timers
    if (iceRestartTimerRef.current) {
      clearTimeout(iceRestartTimerRef.current);
      iceRestartTimerRef.current = null;
    }
    if (iceRestartFallbackTimerRef.current) {
      clearTimeout(iceRestartFallbackTimerRef.current);
      iceRestartFallbackTimerRef.current = null;
    }

    setTransientMessage('Пересоздаём медиасоединение...');
    setReconnectionState('reconnecting');
    resetMediaRoute();

    // Close existing peer connection
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    // Reset state for new connection
    pendingCandidatesRef.current = [];
    offerSentRef.current = false;
    setRemoteStream(null);
    setPeerConnectionState('new');
    setIceConnectionState('new');

    try {
      // Optionally fetch fresh TURN config
      let rtcConfig = lastRtcConfigRef.current;
      if (options?.fetchNewTurnConfig) {
        try {
          const turnConfig = await fetchTurnConfig();
          if (turnConfig?.iceServers?.length) {
            rtcConfig = { iceServers: turnConfig.iceServers };
            lastRtcConfigRef.current = rtcConfig;
          }
        } catch (err) {
          console.warn('[CALL] Failed to fetch fresh TURN config, using cached', err);
        }
      }

      // Create new RTCPeerConnection
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      // Re-add local tracks
      const mediaStream = getLocalStream();
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => {
          pc.addTrack(track, mediaStream);
        });
      }

      // Set up event handlers
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal('ice-candidate', event.candidate.toJSON());
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        setPeerConnectionState(pc.connectionState ?? 'new');
        if (pc.connectionState === 'connected') {
          // Success! Reset attempt counter
          recreateAttemptsRef.current = 0;
          isRecreatingRef.current = false;
          setReconnectionState('connected');
        }
        if (pc.connectionState === 'failed') {
          // Will be handled by oniceconnectionstatechange
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState ?? 'new';
        setIceConnectionState(state);

        if (state === 'connected' || state === 'completed') {
          if (iceRestartTimerRef.current) {
            clearTimeout(iceRestartTimerRef.current);
            iceRestartTimerRef.current = null;
          }
          if (iceRestartFallbackTimerRef.current) {
            clearTimeout(iceRestartFallbackTimerRef.current);
            iceRestartFallbackTimerRef.current = null;
          }
          recreateAttemptsRef.current = 0;
          isRecreatingRef.current = false;
          setReconnectionState('connected');
          void updateMediaRoute();
        }

        if (state === 'failed') {
          // If recreation itself failed, try again with fresh TURN config
          isRecreatingRef.current = false;
          void recreatePeerConnection({ fetchNewTurnConfig: true });
        }
      };

      // Send renegotiate-request to peer so they know we're ready
      sendSignal('renegotiate-request', {});

      // Host creates offer, guest waits for offer
      if (connectionParamsRef.current.role === 'host') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        offerSentRef.current = true;
        sendSignal('offer', offer);
        setTransientMessage('Отправили новое предложение...');
      } else {
        setTransientMessage('Ожидаем предложение от собеседника...');
        isRecreatingRef.current = false;
      }
    } catch (err) {
      console.error('[CALL] Failed to recreate peer connection', err);
      isRecreatingRef.current = false;
      // Try again
      void recreatePeerConnection({ fetchNewTurnConfig: true });
    }
  }, [resetMediaRoute, sendSignal, updateMediaRoute]);

  /**
   * Handles peer reconnection event (when the other participant reconnects).
   * Resets state and initiates renegotiation:
   * - If WebRTC is still connected/completed: just do ICE restart
   * - If WebRTC is disconnected/failed: recreate the connection
   * - Host initiates, guest waits
   * 
   * @param options.fromJoin - true if called during initial join (skip waiting message for guest)
   */
  const handlePeerReconnected = useCallback(
    (options?: { fromJoin?: boolean }) => {
      resetPeerReconnection();
      pendingCandidatesRef.current = [];
      offerSentRef.current = false;
      setTransientMessage('Собеседник восстановил соединение.');

      // Check current WebRTC state to decide recovery strategy
      const currentIceState = pcRef.current?.iceConnectionState;
      const needsRecreate = !currentIceState || 
        currentIceState === 'failed' || 
        currentIceState === 'closed' ||
        currentIceState === 'disconnected';

      // Хост инициирует восстановление, гость ожидает
      if (connectionParamsRef.current.role === 'host') {
        if (needsRecreate) {
          console.log('[CALL] Peer reconnected, WebRTC needs recreate, state:', currentIceState);
          void recreatePeerConnection({ fetchNewTurnConfig: true });
        } else {
          console.log('[CALL] Peer reconnected, WebRTC still ok, doing ICE restart');
          void performIceRestart();
        }
      } else if (!options?.fromJoin) {
        // Гость ожидает новое предложение
        setTransientMessage('Ожидаем новое предложение после переподключения...');
      }
    },
    [performIceRestart, recreatePeerConnection, resetPeerReconnection]
  );

  // ============================================================
  // SDP & ICE CANDIDATE HANDLERS
  // Process signaling messages from the remote peer
  // ============================================================
  
  /**
   * Flushes ICE candidates that arrived before the remote description was set.
   * Called after setRemoteDescription to apply buffered candidates.
   */
  const flushPendingCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      return;
    }
    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift();
      if (!candidate) {
        continue;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[CALL] Failed to add ICE candidate', err);
      }
    }
  }, []);

  /**
   * Handles an incoming SDP offer from the remote peer (guest receives this).
   * Sets remote description, creates answer, and sends it back.
   */
  const handleRemoteOffer = useCallback(async (description: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(description));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await flushPendingCandidates();
      sendSignal('answer', answer);
      setTransientMessage('Отправили ответ. Ждём подключение...');
    } catch (err) {
      console.error('[CALL] Failed to handle offer', err);
      setError('Не удалось обработать предложение от собеседника. Попробуйте создать новую ссылку.');
    }
  }, [flushPendingCandidates, sendSignal]);

  /**
   * Handles an incoming SDP answer from the remote peer (host receives this).
   * Completes the offer/answer exchange by setting the remote description.
   */
  const handleRemoteAnswer = useCallback(async (description: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(description));
      await flushPendingCandidates();
      setTransientMessage('Ответ получен. Устанавливаем соединение...');
    } catch (err) {
      console.error('[CALL] Failed to handle answer', err);
      setError('Не удалось применить ответ собеседника. Попробуйте создать новую ссылку.');
    }
  }, [flushPendingCandidates]);

  /**
   * Handles an incoming ICE candidate from the remote peer.
   * If remote description isn't set yet, buffers the candidate for later.
   */
  const handleRemoteCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[CALL] Failed to apply remote ICE candidate', err);
    }
  }, []);

  // ============================================================
  // OFFER CREATION
  // Host creates and sends SDP offer to initiate WebRTC connection
  // ============================================================
  
  // Ref-based function to create offer (allows calling from effects without deps issues)
  const createOfferRef = useRef<() => Promise<void>>();
  createOfferRef.current = async () => {
    const pc = pcRef.current;
    if (!pc || offerSentRef.current) {
      return;
    }
    try {
      setTransientMessage('Формируем предложение...');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal('offer', offer);
      offerSentRef.current = true;
    } catch (err) {
      console.error('[CALL] Failed to create offer', err);
      setError('Не удалось создать предложение для звонка. Попробуйте создать новую ссылку.');
    }
  };

  // ============================================================
  // AUTO-OFFER EFFECT
  // Automatically creates offer when conditions are met (host only)
  // ============================================================
  
  /**
   * Auto-offer for host: triggers offer creation when:
   * 1. RTCPeerConnection is initialized
   * 2. Current role is 'host'
   * 3. Both participants are connected (participants >= 2)
   * 4. WebSocket is ready
   * 5. Offer hasn't been sent yet
   * 
   * Using useEffect ensures reliable reaction to state changes.
   */
  useEffect(() => {
    // Guard: ensure initialization is complete
    if (!pcRef.current) {
      return;
    }
    
    // Only host creates offers
    if (connectionParamsRef.current.role !== 'host') {
      return;
    }
    // Need both participants and ready signaling
    if (participants < 2 || wsState !== 'ready') {
      return;
    }
    // Prevent duplicate offers
    if (offerSentRef.current) {
      return;
    }
    
    // All conditions met - create offer
    createOfferRef.current?.();
  }, [participants, wsState]);

  // ============================================================
  // TRANSIENT MESSAGE CLEANUP
  // Auto-clears status messages when connection is established
  // ============================================================
  
  /**
   * Clears transient status messages when the connection is fully established.
   * This prevents stale messages like "Waiting for response..." from showing
   * after the call is already working.
   * 
   * Clears when:
   * - Call is active AND WebRTC connected AND ICE connected/completed
   * - OR when remoteStream is received (media is flowing)
   */
  useEffect(() => {
    if (!transientMessage) {
      return;
    }
    
    // Clear if connection is fully established
    const isConnected = 
      callStatus === 'active' &&
      peerConnectionState === 'connected' &&
      (iceConnectionState === 'connected' || iceConnectionState === 'completed');
    
    // Also clear if remoteStream is received (media is flowing)
    if (isConnected || remoteStream) {
      setTransientMessage(null);
    }
  }, [transientMessage, callStatus, peerConnectionState, iceConnectionState, remoteStream]);

  // ============================================================
  // MAIN INITIALIZATION EFFECT
  // Sets up the entire call session when callId is available
  // ============================================================
  
  /**
   * Main effect that initializes the call session.
   * Runs when callId changes (typically once on mount).
   * 
   * Initialization sequence:
   * 1. Validate callId and session state
   * 2. Acquire local media (camera/microphone)
   * 3. Fetch TURN server configuration
   * 4. Create RTCPeerConnection with ICE servers
   * 5. Add local tracks to peer connection
   * 6. Set up RTCPeerConnection event handlers
   * 7. Subscribe to signaling WebSocket
   * 8. Process incoming signaling messages
   * 
   * Cleanup on unmount tears down the session (preserving state for potential recovery).
   */
  useEffect(() => {
    if (!callId) {
      setError('Не указан идентификатор звонка. Вернитесь на главный экран.');
      return;
    }

    // Guard against re-initialization if session is already active
    if (pcRef.current || signalingRef.current) {
      return;
    }

    const { peerId, role } = connectionParamsRef.current;
    if (role === 'guest' && !peerId) {
      setError('Сессия гостя не найдена. Пройдите заново по приглашению.');
      return;
    }

    // Flag to prevent state updates after unmount
    let isActive = true;

    const init = async () => {
      // Reset state for fresh initialization
      setError(null);
      setTransientMessage(null);
      setCallStatus('waiting');
      setParticipants(1);
      setWsState('connecting');

      // ----- STEP 1: Acquire local media (camera/microphone) -----
      let mediaStream: MediaStream | null = null;
      try {
        mediaStream = await acquireLocalMedia();
        if (!isActive) {
          return;
        }
        setLocalStreamState(mediaStream);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось получить доступ к устройствам.');
        return;
      }

      // ----- STEP 2: Fetch TURN server configuration -----
      let rtcConfig: RTCConfiguration = {};
      try {
        const turnConfig = await fetchTurnConfig();
        if (!isActive) {
          return;
        }
        if (turnConfig?.iceServers?.length) {
          rtcConfig = { iceServers: turnConfig.iceServers };
        }
      } catch (err) {
        console.warn('[CALL] Failed to load TURN config', err);
      }
      // Cache for potential recreation
      lastRtcConfigRef.current = rtcConfig;

      // ----- STEP 3: Create RTCPeerConnection -----
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      // ----- STEP 4: Add local tracks to peer connection -----
      if (mediaStream) {
        const streamForTracks = mediaStream;
        streamForTracks.getTracks().forEach((track) => {
          pc.addTrack(track, streamForTracks);
        });
      }

      // ----- STEP 5: Set up RTCPeerConnection event handlers -----
      
      // Send ICE candidates to remote peer via signaling
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal('ice-candidate', event.candidate.toJSON());
        }
      };

      // Receive remote media tracks
      pc.ontrack = (event) => {
        if (!isActive) {
          return;
        }
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
        }
      };

      // Track overall peer connection state changes
      pc.onconnectionstatechange = () => {
        if (!isActive) {
          return;
        }
        setPeerConnectionState(pc.connectionState ?? 'new');
        // Don't show error immediately on 'failed' - let ICE restart/recreate handle it
        // Error will be shown after max recreate attempts
      };

      // Handle ICE connectivity state changes (for reconnection logic)
      pc.oniceconnectionstatechange = () => {
        if (!isActive) {
          return;
        }
        const state = pc.iceConnectionState ?? 'new';
        setIceConnectionState(state);
        
        // ICE connected: clear any pending restart timer, update media route
        if (state === 'connected' || state === 'completed') {
          if (iceRestartTimerRef.current) {
            clearTimeout(iceRestartTimerRef.current);
            iceRestartTimerRef.current = null;
          }
          if (iceRestartFallbackTimerRef.current) {
            clearTimeout(iceRestartFallbackTimerRef.current);
            iceRestartFallbackTimerRef.current = null;
          }
          recreateAttemptsRef.current = 0;
          setReconnectionState('connected');
          void updateMediaRoute();
        }
        
        // ICE disconnected: wait 3s then attempt ICE restart, with fallback to full recreate
        if (state === 'disconnected') {
          if (iceRestartTimerRef.current) {
            clearTimeout(iceRestartTimerRef.current);
          }
          if (iceRestartFallbackTimerRef.current) {
            clearTimeout(iceRestartFallbackTimerRef.current);
          }
          setReconnectionState('reconnecting');
          
          // First try ICE restart after 3 seconds
          iceRestartTimerRef.current = setTimeout(() => {
            if (pcRef.current?.iceConnectionState === 'disconnected') {
              void performIceRestart();
              
              // If ICE restart doesn't help within 5 more seconds, recreate the connection
              iceRestartFallbackTimerRef.current = setTimeout(() => {
                const currentState = pcRef.current?.iceConnectionState;
                if (currentState && currentState !== 'connected' && currentState !== 'completed') {
                  console.log('[CALL] ICE restart did not help, recreating peer connection');
                  void recreatePeerConnection({ fetchNewTurnConfig: true });
                }
              }, 5000);
            }
          }, 3000);
        }
        
        // ICE failed: immediately try to recreate the connection
        if (state === 'failed') {
          if (iceRestartTimerRef.current) {
            clearTimeout(iceRestartTimerRef.current);
            iceRestartTimerRef.current = null;
          }
          if (iceRestartFallbackTimerRef.current) {
            clearTimeout(iceRestartFallbackTimerRef.current);
            iceRestartFallbackTimerRef.current = null;
          }
          resetMediaRoute();
          setReconnectionState('reconnecting');
          // ICE restart won't help if it already failed - recreate the connection
          void recreatePeerConnection({ fetchNewTurnConfig: true });
        }
        
        if (state === 'closed') {
          resetMediaRoute();
        }
      };

      // ----- STEP 6: Subscribe to WebSocket signaling -----
      // This sets up handlers for all signaling messages from the server
      const subscription = subscribeToSignaling(callId, peerId, {
        // Called when successfully joined the call room
        onJoin: (data) => {
          if (!isActive) {
            return;
          }
          setWsState('ready');
          if (data?.peer_id) {
            const resolvedRole = (data.role as PeerRole) ?? connectionParamsRef.current.role ?? 'host';
            setPeerContext(data.peer_id, resolvedRole);
            setSessionInfo((prev) => ({ ...prev, peerId: data.peer_id, role: resolvedRole }));
          }
          const isReconnect = (data as any)?.is_reconnect === true;
          const peerOnline = (data as any)?.peer_online === true;
          if (isReconnect) {
            setReconnectionState('reconnecting');
            setTransientMessage('Восстанавливаем соединение...');
            handlePeerReconnected({ fromJoin: true });
          }
          if (peerOnline) {
            resetPeerReconnection();
          }
          // Проверка условий для auto-offer выполнится автоматически через useEffect
          // при обновлении wsState
        },
        onState: (data) => {
          if (!isActive) {
            return;
          }
          const newParticipants = data.participants?.count ?? 1;
          setCallStatus(data.status);
          setParticipants(newParticipants);
          if (newParticipants >= 2 && peerDisconnectTimerRef.current) {
            clearTimeout(peerDisconnectTimerRef.current);
            peerDisconnectTimerRef.current = null;
          }
          if (data.status === 'ended') {
            teardownSession();
          }
          // Проверка условий для auto-offer выполнится автоматически через useEffect
          // при обновлении participants
        },
        onReconnected: () => {
          if (!isActive) {
            return;
          }
          handlePeerReconnected();
        },
        onOffer: (message) => {
          if (!isActive || connectionParamsRef.current.role === 'host') {
            return;
          }
          const description = message.data as RTCSessionDescriptionInit | undefined;
          if (description) {
            handleRemoteOffer(description);
          }
        },
        onAnswer: (message) => {
          if (!isActive) {
            return;
          }
          const description = message.data as RTCSessionDescriptionInit | undefined;
          if (description) {
            handleRemoteAnswer(description);
          }
        },
        onIceCandidate: (message) => {
          if (!isActive) {
            return;
          }
          const candidate = message.data as RTCIceCandidateInit | undefined;
          if (candidate) {
            handleRemoteCandidate(candidate);
          }
        },
        onLeave: () => {
          if (!isActive) {
            return;
          }
          setTransientMessage('Собеседник отключился. Ждём переподключения...');
          setPeerDisconnected(true);
          setReconnectionState('peer-disconnected');
          if (peerDisconnectTimerRef.current) {
            clearTimeout(peerDisconnectTimerRef.current);
          }
          peerDisconnectTimerRef.current = setTimeout(() => {
            setCallStatus('ended');
            teardownSession();
          }, 30000);
        },
        onMessage: (envelope) => {
          if (!isActive || !envelope?.type) {
            return;
          }
          if (envelope.type === 'peer-disconnected') {
            setPeerDisconnected(true);
            setReconnectionState('peer-disconnected');
            setTransientMessage('Собеседник отключился. Ждём переподключения...');
            if (peerDisconnectTimerRef.current) {
              clearTimeout(peerDisconnectTimerRef.current);
            }
            peerDisconnectTimerRef.current = setTimeout(() => {
              setCallStatus('ended');
              teardownSession();
            }, 30000);
          }
          if (envelope.type === 'peer-reconnected') {
            handlePeerReconnected();
          }
          // Handle renegotiation request from peer (they recreated their connection)
          if (envelope.type === 'renegotiate-request') {
            console.log('[CALL] Received renegotiate-request from peer');
            // Reset offer state and prepare for new negotiation
            pendingCandidatesRef.current = [];
            offerSentRef.current = false;
            
            // Host creates new offer, guest just waits
            if (connectionParamsRef.current.role === 'host') {
              // Check if we need to recreate our connection too
              const currentIceState = pcRef.current?.iceConnectionState;
              if (!currentIceState || currentIceState === 'failed' || currentIceState === 'closed') {
                void recreatePeerConnection({ fetchNewTurnConfig: false });
              } else {
                // Our connection is fine, just create new offer
                void performIceRestart();
              }
            } else {
              setTransientMessage('Собеседник пересоздаёт соединение, ожидаем...');
            }
          }
        },
        onClose: () => {
          if (!isActive) {
            return;
          }
          setWsState('disconnected');
        },
        onError: () => {
          if (!isActive) {
            return;
          }
          setWsState('disconnected');
        },
      });
      signalingRef.current = subscription.client;
      signalingSubscriptionRef.current = subscription;
    };

    init();

    return () => {
      isActive = false;
      teardownSession({ preserveState: true });
    };
  }, [callId, handlePeerReconnected, handleRemoteAnswer, handleRemoteCandidate, handleRemoteOffer, performIceRestart, recreatePeerConnection, resetMediaRoute, resetPeerReconnection, sendSignal, teardownSession, updateMediaRoute]);

  // ============================================================
  // PUBLIC ACTIONS
  // Actions exposed to the UI for user interactions
  // ============================================================
  
  /** End the call and cleanup all resources */
  const hangup = useCallback(() => {
    setCallStatus('ended');
    teardownSession();
  }, [teardownSession]);

  // Return state and actions for the UI
  return {
    state: {
      sessionInfo,
      wsState,
      callStatus,
      participants,
      error,
      remoteStream,
      localStreamState,
      peerConnectionState,
      iceConnectionState,
      mediaRoute,
      transientMessage,
      reconnectionState,
      peerDisconnected,
    },
    actions: {
      setTransientMessage,
      hangup,
    },
  };
}
