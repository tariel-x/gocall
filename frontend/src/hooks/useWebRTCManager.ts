/**
 * useWebRTCManager Hook
 * =====================
 * 
 * Manages the lifecycle of RTCPeerConnection, TURN server configuration,
 * and basic connectivity state tracking.
 * 
 * This hook isolates WebRTC object ownership from higher-level call logic,
 * making it easier to test and refactor signaling and reconnection strategies.
 * 
 * Currently handles:
 * - TURN server configuration fetch
 * - RTCPeerConnection creation and cleanup
 * - Basic state tracking (connection state, ICE connection state)
 * 
 * Future stages will move:
 * - Signaling logic (offer/answer/candidate handling)
 * - Reconnection logic (ICE restart, full recreate)
 * - Media route detection and remote stream handling
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTurnConfig } from '../services/api';
import { ReconnectionState } from '../services/types';
import { MediaRouteMode } from './uiConsts';
import { parseMediaRouteStats } from '../utils/webrtcStats';
import { useLatest } from '../utils/useLatest';
import { createConfiguredPeerConnection } from '../utils/webrtcFactory';

const TIMEOUTS = {
  RECONNECT_DELAY: 3000,
  RECREATE_RETRY: 2000,
} as const;

const MEDIA_ROUTE_INTERVAL = 5000;

export interface WebRTCManagerProps {
  /** Local media stream (camera/microphone). Will be added to PC when created. */
  localStream: MediaStream | null;
  /** Role of the current peer (host initiates offer, guest waits) */
  isHost: boolean;
  /** WebSocket signaling ready state */
  isWsConnected: boolean;
  /** Signaling sender (offer/answer/ice-candidate) */
  sendSignal: (type: string, data?: unknown) => void;
  /** UI status updates (transient messages) */
  onStatusMessage?: (message: string | null) => void;
  /** UI error updates */
  onError?: (message: string | null) => void;
  /** Reconnection state updates */
  onReconnectionState?: (state: ReconnectionState) => void;
}

export interface WebRTCManagerResult {
  /** Ref to the RTCPeerConnection instance. Null until initialized. */
  pcRef: React.MutableRefObject<RTCPeerConnection | null>;
  /** Current RTCPeerConnection state */
  connectionState: RTCPeerConnectionState | 'new';
  /** Current ICE connection state */
  iceConnectionState: RTCIceConnectionState | 'new';
  /** Remote peer media stream */
  remoteStream: MediaStream | null;
  /** Media route info: direct/relay/unknown */
  mediaRoute: { mode: MediaRouteMode; detail?: string };
  /** Start periodic media route checks */
  startMediaRouteTimer: () => void;
  /** Stop periodic media route checks */
  stopMediaRouteTimer: () => void;
  /** Process signaling message from remote peer */
  processSignal: (type: string, data?: unknown) => Promise<void>;
  /** Host-initiated call setup (create and send offer) */
  initiateCall: () => Promise<void>;
  /** Reset local signaling state for renegotiation */
  resetNegotiationState: () => void;
  /** Mark offer as sent to prevent duplicate offers */
  markOfferSent: () => void;
  /** Attempt ICE restart (host-only) */
  performIceRestart: () => Promise<void>;
  /** Recreate peer connection when ICE restart fails */
  recreatePeerConnection: (options?: { fetchNewTurnConfig?: boolean }) => Promise<void>;
  /** Handle ICE connection loss (schedule restart/recreate) */
  handleConnectionLoss: () => void;
  /** Clear reconnection timers and reset attempts on successful connect */
  handleIceConnected: () => void;
  /** Function to explicitly destroy the peer connection and cleanup */
  destroyPeerConnection: () => void;
}

/**
 * Manages WebRTC peer connection lifecycle.
 * 
 * Initialization:
 * - Fetches TURN server config from the backend
 * - Creates RTCPeerConnection with ICE servers
 * - Adds local media tracks if available
 * - Sets up basic state listeners (without complex reconnection logic yet)
 * 
 * Cleanup:
 * - Closes peer connection
 * - Nulls the ref
 * 
 * @param props Configuration including localStream and role
 * @returns Object containing pcRef, state, and cleanup functions
 */
export function useWebRTCManager({
  localStream,
  isHost,
  isWsConnected,
  sendSignal,
  onStatusMessage,
  onError,
  onReconnectionState,
}: WebRTCManagerProps): WebRTCManagerResult {
  // ============================================================
  // REFS (mutable, non-reactive)
  // ============================================================
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const rtcConfigRef = useRef<RTCConfiguration>({});
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const offerSentRef = useRef(false);
  const recreateRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recreateAttemptsRef = useRef(0);
  const isRecreatingRef = useRef(false);
  const scheduleRecreateRetryRef = useRef<(() => void) | null>(null);
  const recreatePeerConnectionRef = useRef<((options?: { fetchNewTurnConfig?: boolean }) => Promise<void>) | null>(null);
  const handleConnectionLossRef = useRef<(() => void) | null>(null);
  const handleIceConnectedRef = useRef<(() => void) | null>(null);
  const mediaRouteTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendSignalRef = useLatest(sendSignal);
  const isHostRef = useLatest(isHost);
  const isWsConnectedRef = useLatest(isWsConnected);
  const statusMessageRef = useLatest(onStatusMessage);
  const errorRef = useLatest(onError);
  const reconnectionStateRef = useLatest(onReconnectionState);

  // ============================================================
  // STATE (reactive)
  // ============================================================
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | 'new'>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'new'>('new');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [mediaRoute, setMediaRoute] = useState<{ mode: MediaRouteMode; detail?: string }>({ mode: 'unknown' });

  // ============================================================
  // SIGNALING HELPERS
  // Offer/Answer/Candidate handling
  // ============================================================

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
        console.warn('[WebRTCManager] Failed to add ICE candidate', err);
      }
    }
  }, []);

  const processSignal = useCallback(async (type: string, data?: unknown) => {
    const pc = pcRef.current;
    if (!pc || !type) {
      return;
    }

    switch (type) {
      case 'offer': {
        const description = data as RTCSessionDescriptionInit | undefined;
        if (!description) {
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await flushPendingCandidates();
        sendSignalRef.current('answer', answer);
        break;
      }
      case 'answer': {
        const description = data as RTCSessionDescriptionInit | undefined;
        if (!description) {
          return;
        }
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(description));
          await flushPendingCandidates();
        }
        break;
      }
      case 'ice-candidate': {
        const candidate = data as RTCIceCandidateInit | undefined;
        if (!candidate) {
          return;
        }
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
        break;
      }
      default:
        break;
    }
  }, [flushPendingCandidates, sendSignalRef]);

  const initiateCall = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || offerSentRef.current) {
      return;
    }
    if (!isHostRef.current) {
      return;
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignalRef.current('offer', offer);
      offerSentRef.current = true;
    } catch (err) {
      console.error('[WebRTCManager] Failed to create offer', err);
    }
  }, [isHostRef, sendSignalRef]);

  const resetNegotiationState = useCallback(() => {
    pendingCandidatesRef.current = [];
    offerSentRef.current = false;
  }, []);

  const markOfferSent = useCallback(() => {
    offerSentRef.current = true;
  }, []);

  const checkMediaRoute = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }
    try {
      const stats = await pc.getStats();
      const routeInfo = parseMediaRouteStats(stats);
      setMediaRoute(routeInfo);
    } catch (err) {
      console.warn('[WebRTCManager] Failed to inspect media route', err);
    }
  }, []);

  const stopMediaRouteTimer = useCallback(() => {
    if (mediaRouteTimerRef.current) {
      clearInterval(mediaRouteTimerRef.current);
      mediaRouteTimerRef.current = null;
    }
    setMediaRoute({ mode: 'unknown' });
  }, []);

  const startMediaRouteTimer = useCallback(() => {
    if (mediaRouteTimerRef.current) {
      return;
    }
    void checkMediaRoute();
    mediaRouteTimerRef.current = setInterval(() => {
      void checkMediaRoute();
    }, MEDIA_ROUTE_INTERVAL);
  }, [checkMediaRoute]);

  const clearIceTimers = useCallback(() => {
    if (recreateRetryTimerRef.current) {
      clearTimeout(recreateRetryTimerRef.current);
      recreateRetryTimerRef.current = null;
    }
  }, []);

  const attachPeerConnectionHandlers = useCallback(
    (pc: RTCPeerConnection) => {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignalRef.current('ice-candidate', event.candidate.toJSON());
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        setConnectionState(pc.connectionState ?? 'new');
        if (pc.connectionState === 'connected') {
          reconnectionStateRef.current?.('connected');
          errorRef.current?.(null);
          statusMessageRef.current?.(null);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState ?? 'new';
        setIceConnectionState(state);

        if (state === 'connected' || state === 'completed') {
          handleIceConnectedRef.current?.();
          reconnectionStateRef.current?.('connected');
          errorRef.current?.(null);
          statusMessageRef.current?.(null);
        }

        if (state === 'disconnected') {
          stopMediaRouteTimer();
          handleConnectionLossRef.current?.();
        }

        if (state === 'failed') {
          stopMediaRouteTimer();
          reconnectionStateRef.current?.('reconnecting');
          void recreatePeerConnectionRef.current?.({ fetchNewTurnConfig: true });
        }

        if (state === 'closed') {
          stopMediaRouteTimer();
        }
      };
    },
    [errorRef, reconnectionStateRef, sendSignalRef, statusMessageRef, stopMediaRouteTimer]
  );

  const performIceRestart = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) {
      return;
    }

    if (!isHostRef.current) {
      statusMessageRef.current?.('Ожидаем переподключение собеседника...');
      reconnectionStateRef.current?.('reconnecting');
      return;
    }

    try {
      statusMessageRef.current?.('Переподключаем медиасессию...');
      reconnectionStateRef.current?.('reconnecting');
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      markOfferSent();
      sendSignalRef.current('offer', offer);
    } catch (err) {
      console.error('[WebRTCManager] ICE restart failed', err);
      errorRef.current?.('Не удалось переподключить медиасессию. Попробуйте создать новую ссылку.');
      reconnectionStateRef.current?.('failed');
    }
  }, [errorRef, isHostRef, markOfferSent, reconnectionStateRef, sendSignalRef, statusMessageRef]);

  const recreatePeerConnection = useCallback<
    (options?: { fetchNewTurnConfig?: boolean }) => Promise<void>
  >(async (options?: { fetchNewTurnConfig?: boolean }) => {
      if (isRecreatingRef.current) {
        console.log('[WebRTCManager] Recreation already in progress, skipping');
        return;
      }

      isRecreatingRef.current = true;
      recreateAttemptsRef.current += 1;
      console.log(
        `[WebRTCManager] Recreating peer connection (attempt ${recreateAttemptsRef.current})`
      );

      clearIceTimers();
      statusMessageRef.current?.(
        `Пересоздаём медиасоединение (попытка ${recreateAttemptsRef.current})...`
      );
      reconnectionStateRef.current?.('reconnecting');
      resetNegotiationState();

      if (!isWsConnectedRef.current) {
        statusMessageRef.current?.('Ожидаем восстановление сигналинга перед пересозданием...');
        isRecreatingRef.current = false;
        scheduleRecreateRetryRef.current?.();
        return;
      }

      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
        pcRef.current = null;
      }

      try {
        let rtcConfig: RTCConfiguration = {};
        if (options?.fetchNewTurnConfig) {
          try {
            const turnConfig = await fetchTurnConfig();
            if (turnConfig?.iceServers?.length) {
              rtcConfig = { iceServers: turnConfig.iceServers };
              rtcConfigRef.current = rtcConfig;
            }
          } catch (err) {
            console.warn('[WebRTCManager] Failed to fetch fresh TURN config', err);
          }
        } else {
          rtcConfig = rtcConfigRef.current;
        }

        const pc = createConfiguredPeerConnection(rtcConfig, localStream);
        pcRef.current = pc;

        attachPeerConnectionHandlers(pc);

        sendSignalRef.current('renegotiate-request', {});

        if (isHostRef.current) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          markOfferSent();
          sendSignalRef.current('offer', offer);
          statusMessageRef.current?.('Отправили новое предложение...');
        } else {
          statusMessageRef.current?.('Ожидаем предложение от собеседника...');
          isRecreatingRef.current = false;
        }
      } catch (err) {
        console.error('[WebRTCManager] Failed to recreate peer connection', err);
        isRecreatingRef.current = false;
        scheduleRecreateRetryRef.current?.();
      }
    },
    [
      attachPeerConnectionHandlers,
      clearIceTimers,
      errorRef,
      isHostRef,
      isWsConnectedRef,
      localStream,
      markOfferSent,
      reconnectionStateRef,
      resetNegotiationState,
      sendSignalRef,
      statusMessageRef,
    ]
  );

  recreatePeerConnectionRef.current = recreatePeerConnection;

  const scheduleRecreateRetry = useCallback(() => {
    if (recreateRetryTimerRef.current) {
      clearTimeout(recreateRetryTimerRef.current);
    }

    reconnectionStateRef.current?.('reconnecting');
    statusMessageRef.current?.(
      `Повторная попытка через ${TIMEOUTS.RECREATE_RETRY / 1000} секунды (попытка ${recreateAttemptsRef.current})...`
    );

    recreateRetryTimerRef.current = setTimeout(() => {
      recreateRetryTimerRef.current = null;
      void recreatePeerConnection({ fetchNewTurnConfig: true });
    }, TIMEOUTS.RECREATE_RETRY);
  }, [errorRef, reconnectionStateRef, statusMessageRef, recreatePeerConnection]);

  scheduleRecreateRetryRef.current = scheduleRecreateRetry;

  const handleConnectionLoss = useCallback<() => void>(() => {
    clearIceTimers();
    stopMediaRouteTimer();
    reconnectionStateRef.current?.('reconnecting');

    recreateRetryTimerRef.current = setTimeout(() => {
      void recreatePeerConnection({ fetchNewTurnConfig: true });
    }, TIMEOUTS.RECONNECT_DELAY);
  }, [clearIceTimers, recreatePeerConnection, reconnectionStateRef, stopMediaRouteTimer]);

  handleConnectionLossRef.current = handleConnectionLoss;

  const handleIceConnected = useCallback<() => void>(() => {
    clearIceTimers();
    recreateAttemptsRef.current = 0;
    isRecreatingRef.current = false;
    startMediaRouteTimer();
  }, [clearIceTimers, startMediaRouteTimer]);

  handleIceConnectedRef.current = handleIceConnected;

  // ============================================================
  // INITIALIZATION
  // Create RTCPeerConnection with TURN config
  // ============================================================

  const initPeerConnection = useCallback(async () => {
    // Guard: already initialized
    if (pcRef.current) {
      return;
    }

    // Step 1: Fetch TURN server configuration
    try {
      const turnConfig = await fetchTurnConfig();
      if (turnConfig?.iceServers?.length) {
        rtcConfigRef.current = { iceServers: turnConfig.iceServers };
      }
    } catch (err) {
      console.warn('[WebRTCManager] Failed to fetch TURN config', err);
      // Proceed without TURN servers if fetch fails
    }

    // Step 2: Create RTCPeerConnection with ICE servers
    const pc = createConfiguredPeerConnection(rtcConfigRef.current, localStream);
    pcRef.current = pc;

    attachPeerConnectionHandlers(pc);

    return pc;
  }, [attachPeerConnectionHandlers, localStream]);

  // ============================================================
  // CLEANUP
  // Destroy peer connection and reset state
  // ============================================================

  const destroyPeerConnection = useCallback(() => {
    clearIceTimers();
    stopMediaRouteTimer();
    if (pcRef.current) {
      // Remove all event listeners
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;

      // Close the connection
      pcRef.current.close();
      pcRef.current = null;
    }

    resetNegotiationState();
    recreateAttemptsRef.current = 0;
    isRecreatingRef.current = false;

    // Reset state
    setConnectionState('new');
    setIceConnectionState('new');
  }, [clearIceTimers, resetNegotiationState, stopMediaRouteTimer]);

  // ============================================================
  // LIFECYCLE EFFECT
  // Initialize on mount, cleanup on unmount
  // ============================================================

  useEffect(() => {
    // Initialize peer connection on mount
    void initPeerConnection();

    // Cleanup on unmount
    return () => {
      destroyPeerConnection();
    };
  }, [initPeerConnection, destroyPeerConnection]);

  return {
    pcRef,
    connectionState,
    iceConnectionState,
    remoteStream,
    mediaRoute,
    startMediaRouteTimer,
    stopMediaRouteTimer,
    processSignal,
    initiateCall,
    resetNegotiationState,
    markOfferSent,
    performIceRestart,
    recreatePeerConnection,
    handleConnectionLoss,
    handleIceConnected,
    destroyPeerConnection,
  };
}
