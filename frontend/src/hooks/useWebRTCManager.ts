/**
 * useWebRTCManager Hook
 * =====================
 * 
 * Autonomous WebRTC Manager (Black Box)
 * 
 * Manages the complete WebRTC lifecycle independently:
 * - Subscribes directly to signaling events (offer/answer/candidate)
 * - Sends signaling messages automatically (no parent routing)
 * - Auto-initiates calls based on role and signaling readiness
 * - Self-manages reconnection and ICE restart logic
 * 
 * The parent component simply passes in:
 * - localStream (camera/microphone)
 * - signaling (connection to server)
 * - isHost (role determination)
 * 
 * And receives back:
 * - remoteStream (peer's video/audio)
 * - connectionStatus (simplified state)
 * - restart() (manual reconnection trigger)
 * 
 * All WebRTC complexity is hidden inside this hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTurnConfig } from '../services/api';
import { MediaRouteMode, ReconnectionState, WebRTCTransientStatus } from '../services/types';
import { parseMediaRouteStats } from '../utils/webrtcStats';
import { useLatest } from '../utils/useLatest';
import { createConfiguredPeerConnection } from '../utils/webrtcFactory';
import type { useSignaling } from './useSignaling';

const TIMEOUTS = {
  RECONNECT_DELAY: 3000,
  RECREATE_RETRY: 2000,
  TURN_CONFIG_MIN_FETCH_INTERVAL: 3000,
} as const;

const MEDIA_ROUTE_INTERVAL = 5000;

export interface WebRTCManagerProps {
  /** Local media stream (camera/microphone). Will be added to PC when created. */
  localStream: MediaStream | null;
  /** Signaling connection object from useSignaling hook */
  signaling: ReturnType<typeof useSignaling>;
  /** Role of the current peer (host initiates offer, guest waits) */
  isHost: boolean;
  /** Enable WebRTC lifecycle (skip init/reconnect when false) */
  enabled?: boolean;
}

export interface WebRTCManagerResult {
  /** Remote peer media stream */
  remoteStream: MediaStream | null;
  /** Simplified connection status */
  connectionStatus: 'new' | 'connecting' | 'connected' | 'failed';
  /** Raw peer connection state (debug only) */
  peerConnectionState: RTCPeerConnectionState | 'new';
  /** Raw ICE connection state (debug only) */
  iceConnectionState: RTCIceConnectionState | 'new';
  /** Current error message, if any */
  error: string | null;
  /** Transient status code for UI */
  transientStatus: { code: WebRTCTransientStatus; context?: any } | null;
  /** Reconnection state */
  reconnectionState: ReconnectionState;
  /** Media route info: direct/relay/unknown */
  mediaRoute: { mode: MediaRouteMode; detail?: string };
  /** Manual reconnection trigger */
  restart: () => void;
  /** Function to explicitly destroy the peer connection and cleanup */
  destroyPeerConnection: () => void;
}

/**
 * Manages WebRTC peer connection lifecycle autonomously.
 * 
 * This hook:
 * - Subscribes to signaling events directly (no parent routing)
 * - Sends signals automatically via signaling object
 * - Auto-initiates offers when host + signaling ready
 * - Self-manages all reconnection logic
 * 
 * @param props Configuration including localStream, signaling, and role
 * @returns Simplified interface with remoteStream, status, and restart()
 */
export function useWebRTCManager({
  localStream,
  signaling,
  isHost,
  enabled = true,
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
  const isMountedRef = useRef(true);
  const lastTurnFetchAtRef = useRef(0);
  const turnConfigFetchRef = useRef<Promise<RTCConfiguration> | null>(null);
  const destroyPeerConnectionRef = useRef<(() => void) | null>(null);
  const initPeerConnectionRef = useRef<(() => Promise<RTCPeerConnection | void>) | null>(null);

  const isHostRef = useLatest(isHost);
  const enabledRef = useLatest(enabled);
  const localStreamRef = useLatest(localStream);

  // ============================================================
  // STATE (reactive)
  // ============================================================
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | 'new'>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'new'>('new');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [mediaRoute, setMediaRoute] = useState<{ mode: MediaRouteMode; detail?: string }>({ mode: 'unknown' });

  // UI state (previously callbacks, now internal)
  const [error, setError] = useState<string | null>(null);
  const [transientStatus, setTransientStatus] = useState<
    { code: WebRTCTransientStatus; context?: any } | null
  >(null);
  const [reconnectionState, setReconnectionState] = useState<ReconnectionState>('connected');

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
        signaling.sendAnswer(answer);
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
  }, [flushPendingCandidates, signaling]);

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
      signaling.sendOffer(offer);
      offerSentRef.current = true;
    } catch (err) {
      console.error('[WebRTCManager] Failed to create offer', err);
    }
  }, [isHostRef, signaling]);

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

  const getRtcConfig = useCallback(async (forceRefresh = false): Promise<RTCConfiguration> => {
    if (!enabledRef.current) {
      return rtcConfigRef.current;
    }
    const now = Date.now();
    const hasConfig = Boolean(rtcConfigRef.current?.iceServers?.length);
    const recentlyFetched = now - lastTurnFetchAtRef.current < TIMEOUTS.TURN_CONFIG_MIN_FETCH_INTERVAL;

    if (!forceRefresh && hasConfig) {
      return rtcConfigRef.current;
    }

    if (forceRefresh && hasConfig && recentlyFetched) {
      return rtcConfigRef.current;
    }

    if (turnConfigFetchRef.current) {
      return turnConfigFetchRef.current;
    }

    if (recentlyFetched && !hasConfig) {
      return rtcConfigRef.current;
    }

    turnConfigFetchRef.current = (async () => {
      try {
        lastTurnFetchAtRef.current = now;
        const turnConfig = await fetchTurnConfig();
        if (turnConfig?.iceServers?.length) {
          rtcConfigRef.current = { iceServers: turnConfig.iceServers };
        }
      } catch (err) {
        console.warn('[WebRTCManager] Failed to fetch TURN config', err);
      } finally {
        turnConfigFetchRef.current = null;
      }
      return rtcConfigRef.current;
    })();

    return turnConfigFetchRef.current;
  }, []);

  const attachPeerConnectionHandlers = useCallback(
    (pc: RTCPeerConnection) => {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signaling.sendCandidate(event.candidate.toJSON());
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
          setReconnectionState('connected');
          setError(null);
          setTransientStatus(null);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState ?? 'new';
        setIceConnectionState(state);

        if (state === 'connected' || state === 'completed') {
          handleIceConnectedRef.current?.();
          setReconnectionState('connected');
          setError(null);
          setTransientStatus(null);
        }

        if (state === 'disconnected') {
          stopMediaRouteTimer();
          handleConnectionLossRef.current?.();
        }

        if (state === 'failed') {
          stopMediaRouteTimer();
          setReconnectionState('reconnecting');
          if (enabledRef.current && localStreamRef.current) {
            void recreatePeerConnectionRef.current?.({ fetchNewTurnConfig: true });
          }
        }

        if (state === 'closed') {
          stopMediaRouteTimer();
        }
      };
    },
    [signaling, stopMediaRouteTimer]
  );

  // ============================================================
  // PEER CONNECTION RECREATION
  // Full teardown and rebuild of WebRTC connection
  // ============================================================

  const recreatePeerConnection = useCallback<
    (options?: { fetchNewTurnConfig?: boolean; notifyPeer?: boolean }) => Promise<void>
  >(async (options?: { fetchNewTurnConfig?: boolean; notifyPeer?: boolean }) => {
    if (!isMountedRef.current || !enabledRef.current || !localStreamRef.current) {
      return;
    }

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
    setTransientStatus({
      code: 'recreating-pc',
      context: { attempt: recreateAttemptsRef.current },
    });
    setReconnectionState('reconnecting');
    resetNegotiationState();

    if (!signaling.isReady) {
      setTransientStatus({ code: 'signaling-wait' });
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
      const rtcConfig = options?.fetchNewTurnConfig
        ? await getRtcConfig(true)
        : rtcConfigRef.current;

      if (!isMountedRef.current) {
        isRecreatingRef.current = false;
        return;
      }

      const pc = createConfiguredPeerConnection(rtcConfig, localStreamRef.current);
      pcRef.current = pc;

      attachPeerConnectionHandlers(pc);

      if (options?.notifyPeer !== false) {
        signaling.send('renegotiate-request', {});
      }

      if (isHostRef.current) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        markOfferSent();
        signaling.sendOffer(offer);
        setTransientStatus({ code: 'offer-sent' });
      } else {
        setTransientStatus({ code: 'answer-waiting' });
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
      getRtcConfig,
      isHostRef,
      markOfferSent,
      resetNegotiationState,
      signaling,
    ]
  );

  recreatePeerConnectionRef.current = recreatePeerConnection;

  const scheduleRecreateRetry = useCallback(() => {
    if (recreateRetryTimerRef.current) {
      clearTimeout(recreateRetryTimerRef.current);
    }

    setReconnectionState('reconnecting');
    setTransientStatus({
      code: 'retry-scheduled',
      context: { delay: TIMEOUTS.RECREATE_RETRY },
    });

    recreateRetryTimerRef.current = setTimeout(() => {
      recreateRetryTimerRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      void recreatePeerConnection({ fetchNewTurnConfig: true, notifyPeer: true });
    }, TIMEOUTS.RECREATE_RETRY);
  }, [recreatePeerConnection]);

  scheduleRecreateRetryRef.current = scheduleRecreateRetry;

  const handleConnectionLoss = useCallback<() => void>(() => {
    clearIceTimers();
    stopMediaRouteTimer();
    setReconnectionState('reconnecting');

    recreateRetryTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) {
        return;
      }
      void recreatePeerConnection({ fetchNewTurnConfig: true, notifyPeer: true });
    }, TIMEOUTS.RECONNECT_DELAY);
  }, [clearIceTimers, recreatePeerConnection, stopMediaRouteTimer]);

  handleConnectionLossRef.current = handleConnectionLoss;

  const handleIceConnected = useCallback<() => void>(() => {
    clearIceTimers();
    recreateAttemptsRef.current = 0;
    isRecreatingRef.current = false;
    startMediaRouteTimer();
  }, [clearIceTimers, startMediaRouteTimer]);

  handleIceConnectedRef.current = handleIceConnected;

  // ============================================================
  // SIGNALING INTEGRATION (STEP_3)
  // Subscribe to signaling events directly
  // ============================================================

  useEffect(() => {
    signaling.setHandlers({
      onOffer: async (data) => {
        await processSignal('offer', data);
      },
      onAnswer: async (data) => {
        await processSignal('answer', data);
      },
      onCandidate: async (data) => {
        await processSignal('ice-candidate', data);
      },
      onPeerDisconnected: () => {
        setReconnectionState('peer-disconnected');
        setTransientStatus({ code: 'peer-disconnected' });
      },
      onPeerReconnected: () => {
        if (!enabledRef.current || !localStreamRef.current) {
          return;
        }
        // Check if WebRTC is already connected
        const isConnected =
          iceConnectionState === 'connected' ||
          iceConnectionState === 'completed';

        if (isConnected) {
          console.log('[WebRTCManager] Peer reconnected, WebRTC already connected');
          setReconnectionState('connected');
          setTransientStatus(null);
          return;
        }
        setTransientStatus({ code: 'peer-reconnected' });
        if (isHostRef.current) {
          console.log('[WebRTCManager] Peer reconnected, restarting connection');
          void recreatePeerConnection({ fetchNewTurnConfig: true, notifyPeer: true });
        } else {
          setTransientStatus({ code: 'peer-reconnected-waiting' });
        }
      },
      onRenegotiateRequest: () => {
        console.log('[WebRTCManager] Received renegotiate-request');
        if (!enabledRef.current || !localStreamRef.current) {
          return;
        }
        if (isHostRef.current) {
          void recreatePeerConnection({ fetchNewTurnConfig: false, notifyPeer: false });
        } else {
          setTransientStatus({ code: 'renegotiate-request' });
        }
      },
    });
  }, [signaling, processSignal, iceConnectionState, isHostRef, recreatePeerConnection]);

  // ============================================================
  // AUTO-OFFER LOGIC
  // Automatically initiate call when host + signaling ready
  // ============================================================

  useEffect(() => {
    if (isHost && signaling.isReady && pcRef.current && !offerSentRef.current) {
      void initiateCall();
    }
  }, [isHost, signaling.isReady, initiateCall]);

  // ============================================================
  // INITIALIZATION
  // Create RTCPeerConnection with TURN config
  // ============================================================

  const initPeerConnection = useCallback(async () => {
    if (!enabledRef.current || !localStreamRef.current) {
      return;
    }
    // Guard: already initialized
    if (pcRef.current) {
      return;
    }

    await getRtcConfig(true);

    if (!isMountedRef.current) {
      return;
    }

    // Step 2: Create RTCPeerConnection with ICE servers
    const pc = createConfiguredPeerConnection(rtcConfigRef.current, localStreamRef.current);
    pcRef.current = pc;

    attachPeerConnectionHandlers(pc);

    return pc;
  }, [attachPeerConnectionHandlers, getRtcConfig]);

  initPeerConnectionRef.current = initPeerConnection;

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
    setRemoteStream(null);
  }, [clearIceTimers, resetNegotiationState, stopMediaRouteTimer]);

  destroyPeerConnectionRef.current = destroyPeerConnection;

  // ============================================================
  // LIFECYCLE EFFECT
  // Initialize on mount, cleanup on unmount
  // ============================================================

  useEffect(() => {
    if (!enabled || !localStream) {
      destroyPeerConnectionRef.current?.();
      return;
    }

    isMountedRef.current = true;

    // Initialize peer connection when enabled and media ready
    void initPeerConnectionRef.current?.();

    // Cleanup on disable/unmount
    return () => {
      isMountedRef.current = false;
      destroyPeerConnectionRef.current?.();
    };
  }, [enabled, localStream]);

  // ============================================================
  // DERIVED STATE
  // Compute simplified connection status from internal states
  // ============================================================

  const connectionStatus: 'new' | 'connecting' | 'connected' | 'failed' = (() => {
    if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
      return 'connected';
    }
    if (iceConnectionState === 'failed' || connectionState === 'failed') {
      return 'failed';
    }
    if (
      iceConnectionState === 'checking' ||
      iceConnectionState === 'disconnected' ||
      connectionState === 'connecting'
    ) {
      return 'connecting';
    }
    return 'new';
  })();

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    remoteStream,
    connectionStatus,
    peerConnectionState: connectionState,
    iceConnectionState,
    error,
    transientStatus,
    reconnectionState,
    mediaRoute,
    restart: () => void recreatePeerConnection({ fetchNewTurnConfig: true, notifyPeer: true }),
    destroyPeerConnection,
  };
}
