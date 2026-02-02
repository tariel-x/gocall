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
import { getSessionState, setCallContext, setPeerContext, SessionState } from '../services/session';
import { CallStatus, PeerRole, ReconnectionState } from '../services/types';
import { SignalingClient, SignalingSubscription, subscribeToSignaling } from '../services/signaling';
import type { WSState } from './useSignaling';
import { MediaRouteMode } from './uiConsts';
import { useLocalMedia } from './useLocalMedia';
import { useLatest } from '../utils/useLatest';
import { useWebRTCManager } from './useWebRTCManager';

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
  /** Local MediaStream (camera/mic) - from useLocalMedia hook */
  localStream: MediaStream | null;
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
  // LOCAL MEDIA
  // Manage camera/microphone stream acquisition and cleanup
  // ============================================================
  const { stream: localStream, error: mediaError, initMedia } = useLocalMedia();

  const [sessionInfo, setSessionInfo] = useState<SessionState>(() => getSessionState());
  const sessionInfoRef = useLatest(sessionInfo);

  // ============================================================
  // REACTIVE STATE
  // These trigger re-renders and are exposed to the UI
  // ============================================================

  const [wsState, setWsState] = useState<WSState>('connecting');
  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const [participants, setParticipants] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [transientMessage, setTransientMessage] = useState<string | null>(null);
  const [reconnectionState, setReconnectionState] = useState<ReconnectionState>('connected');
  const [peerDisconnected, setPeerDisconnected] = useState(false);

  // ============================================================
  // REFS (mutable, non-reactive)
  // Used for WebRTC objects and timers that shouldn't trigger renders
  // ============================================================
  const signalingRef = useRef<SignalingClient | null>(null);           // WebSocket client
  const signalingSubscriptionRef = useRef<SignalingSubscription | null>(null); // Subscription handle
  
  // ============================================================
  // SYNC EFFECTS
  // Update session state when callId changes
  // ============================================================

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
  
  /** Reset peer reconnection state */
  const resetPeerReconnection = useCallback(() => {
    setPeerDisconnected(false);
    setReconnectionState('connected');
  }, []);

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
  // WEBRTC MANAGER
  // Manage RTCPeerConnection lifecycle and signaling handshake
  // ============================================================

  const {
    pcRef,
    processSignal,
    initiateCall,
    resetNegotiationState,
    performIceRestart,
    recreatePeerConnection,
    connectionState: peerConnectionState,
    iceConnectionState,
    remoteStream,
    mediaRoute,
    destroyPeerConnection,
  } = useWebRTCManager({
    localStream,
    isHost: sessionInfo.role === 'host',
    isWsConnected: wsState === 'ready',
    sendSignal,
    onStatusMessage: setTransientMessage,
    onError: setError,
    onReconnectionState: setReconnectionState,
  });

  // ============================================================
  // SESSION TEARDOWN
  // Cleanup function for all WebRTC and signaling resources
  // ============================================================
  
  /**
   * Tears down the entire call session:
   * - Unsubscribes from signaling WebSocket
   * - Clears all pending timers
   * - Destroys the RTCPeerConnection (owned by useWebRTCManager)
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
    // Note: releaseLocalStream is now handled by useLocalMedia hook cleanup
    if (!options?.preserveState) {
      destroyPeerConnection();
      setWsState('disconnected');
      setReconnectionState('connected');
      setPeerDisconnected(false);
    }
  }, [destroyPeerConnection]);

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
      resetNegotiationState();

      // Check current WebRTC state
      const currentIceState = pcRef.current?.iceConnectionState;
      const isConnected = currentIceState === 'connected' || currentIceState === 'completed';

      // Если соединение уже работает — ничего не делаем (для обеих сторон)
      if (isConnected) {
        console.log('[CALL] Peer reconnected, WebRTC already connected, no action needed');
        setTransientMessage(null);
        return;
      }

      setTransientMessage('Собеседник восстановил соединение.');

      // Только хост инициирует offer (чтобы избежать glare condition)
      // Гость ожидает offer от хоста
      if (sessionInfoRef.current.role === 'host') {
        console.log('[CALL] Peer reconnected, recreating WebRTC connection, state:', currentIceState);
        void recreatePeerConnection({ fetchNewTurnConfig: true });
      } else if (!options?.fromJoin) {
        // Гость ожидает новое предложение от хоста
        setTransientMessage('Ожидаем восстановление соединения...');
      }
    },
    [recreatePeerConnection, resetNegotiationState, resetPeerReconnection]
  );

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
    if (sessionInfoRef.current.role !== 'host') {
      return;
    }
    // Need both participants and ready signaling
    if (participants < 2 || wsState !== 'ready') {
      return;
    }
    // All conditions met - create offer
    void initiateCall();
  }, [initiateCall, participants, wsState]);

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

    const { peerId, role } = sessionInfoRef.current;
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
      try {
        await initMedia();
        if (!isActive) {
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось получить доступ к устройствам.');
        return;
      }

      // Check if media acquisition was successful via the hook state
      if (mediaError) {
        setError(mediaError);
        return;
      }

      // ----- STEP 2: Wait for RTCPeerConnection to be initialized by useWebRTCManager -----
      // The manager hook initializes the PC asynchronously, so we may need to wait a bit
      // or ensure the PC is ready before attaching handlers
      const maxWaitTime = 5000;
      const startTime = Date.now();
      while (!pcRef.current && Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!isActive) {
          return;
        }
      }

      const pc = pcRef.current;
      if (!pc) {
        setError('Не удалось инициализировать WebRTC соединение. Попробуйте перезагрузить страницу.');
        return;
      }

      // ----- STEP 4: Subscribe to WebSocket signaling -----
      // This sets up handlers for all signaling messages from the server
      const subscription = subscribeToSignaling(callId, peerId, {
        // Called when successfully joined the call room
        onJoin: (data) => {
          if (!isActive) {
            return;
          }
          setWsState('ready');
          if (data?.peer_id) {
            const resolvedRole = (data.role as PeerRole) ?? sessionInfoRef.current.role ?? 'host';
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
          if (!isActive || sessionInfoRef.current.role === 'host') {
            return;
          }
          const description = message.data as RTCSessionDescriptionInit | undefined;
          if (description) {
            void processSignal('offer', description);
          }
        },
        onAnswer: (message) => {
          if (!isActive) {
            return;
          }
          const description = message.data as RTCSessionDescriptionInit | undefined;
          if (description) {
            void processSignal('answer', description);
          }
        },
        onIceCandidate: (message) => {
          if (!isActive) {
            return;
          }
          const candidate = message.data as RTCIceCandidateInit | undefined;
          if (candidate) {
            void processSignal('ice-candidate', candidate);
          }
        },
        onLeave: () => {
          if (!isActive) {
            return;
          }
          // Intentional leave from peer - end call immediately
          console.log('[CALL] Peer sent leave message, ending call');
          setTransientMessage('Собеседник завершил звонок.');
          setCallStatus('ended');
          teardownSession();
        },
        onMessage: (envelope) => {
          if (!isActive || !envelope?.type) {
            return;
          }
          if (envelope.type === 'peer-disconnected') {
            setPeerDisconnected(true);
            setReconnectionState('peer-disconnected');
            setTransientMessage('Собеседник отключился. Ждём переподключения...');
          }
          if (envelope.type === 'peer-reconnected') {
            handlePeerReconnected();
          }
          // Handle renegotiation request from peer (they recreated their connection)
          if (envelope.type === 'renegotiate-request') {
            console.log('[CALL] Received renegotiate-request from peer');
            // Reset offer state and prepare for new negotiation
            resetNegotiationState();
            
            // Host creates new offer, guest just waits
            if (sessionInfoRef.current.role === 'host') {
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
  }, [callId, handlePeerReconnected, initMedia, mediaError, performIceRestart, processSignal, recreatePeerConnection, resetNegotiationState, resetPeerReconnection, sendSignal, teardownSession]);

  // ============================================================
  // PUBLIC ACTIONS
  // Actions exposed to the UI for user interactions
  // ============================================================
  
  /** End the call and cleanup all resources */
  const hangup = useCallback(() => {
    // Notify peer that we're intentionally leaving
    sendSignal('leave', {});
    setCallStatus('ended');
    teardownSession();
  }, [sendSignal, teardownSession]);

  // Return state and actions for the UI
  return {
    state: {
      sessionInfo,
      wsState,
      callStatus,
      participants,
      error,
      remoteStream,
      localStream,
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
