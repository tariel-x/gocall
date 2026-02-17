/**
 * useCallSession Hook (Orchestrator)
 * ============================================
 * 
 * Clean orchestrator hook that coordinates specialized hooks:
 * - useLocalMedia: Camera/microphone acquisition
 * - useSignaling: WebSocket signaling lifecycle and session state
 * - useWebRTCManager: RTCPeerConnection management
 * 
 * All complexity delegated to specialized hooks - this hook only:
 * 1. Calls the 3 specialized hooks
 * 2. Derives unified AppCallState from their states
 * 3. Provides hangup action and call details
 */

import { useCallback, useEffect, useMemo } from 'react';
import { leaveCall } from '../services/api';
import { getSessionState, setCallContext } from '../services/session';
import { AppCallState, CallSessionDetails, WSState } from '../services/types';
import { useSignaling } from './useSignaling';
import { useLocalMedia } from './useLocalMedia';
import { useWebRTCManager } from './useWebRTCManager';

/**
 * Pure function that derives unified AppCallState from specialized hook states.
 * Maps individual states to high-level call state for UI consumption.
 */
function deriveAppState({
  mediaError,
  localStream,
  signalingReady,
  callStatus,
  connectionStatus,
  reconnectionState,
}: {
  mediaError: string | null;
  localStream: MediaStream | null;
  signalingReady: boolean;
  callStatus: 'waiting' | 'active' | 'ended';
  connectionStatus: 'new' | 'connecting' | 'connected' | 'failed';
  reconnectionState: 'connected' | 'reconnecting' | 'peer-disconnected' | 'failed';
}): AppCallState {
  if (mediaError) return 'FAILED';
  if (!localStream) return 'MEDIA_LOADING';
  if (!signalingReady) return 'SIGNALING_CONNECT';
  if (callStatus === 'ended') return 'COMPLETED';
  if (reconnectionState === 'reconnecting' || reconnectionState === 'peer-disconnected') {
    return 'RECONNECTING';
  }
  if (connectionStatus === 'connected') return 'ACTIVE';
  if (connectionStatus === 'failed') return 'FAILED';
  if (connectionStatus === 'connecting') return 'NEGOTIATING';
  return 'WAITING_FOR_PEER';
}

/**
 * Minimal result interface for useCallSession (STEP_4 simplified API).
 * Only exposes what UI components actually need.
 */
export interface UseCallSessionResult {
  appState: AppCallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  hangup: () => void;
  details: CallSessionDetails;
}

/**
 * Main call session orchestrator.
 * Coordinates useLocalMedia, useSignaling, and useWebRTCManager hooks.
 */
export function useCallSession(callId: string | undefined): UseCallSessionResult {
  // Persist callId to session context when it changes
  useEffect(() => {
    if (callId) {
      setCallContext(callId);
    }
  }, [callId]);

  // 1. Acquire local media (camera/microphone)
  const { stream: localStream, error: mediaError, initMedia } = useLocalMedia();

  useEffect(() => {
    void initMedia();
  }, [initMedia]);

  const sessionState = useMemo(() => getSessionState(), [callId]);

  // 2. Manage WebSocket signaling and session state
  const signaling = useSignaling({
    callId,
    peerId: sessionState.peerId,
    enabled: !!callId,
    requirePeerId: Boolean(sessionState.peerId),
  });

  // 3. Manage WebRTC peer connection
  const {
    remoteStream,
    connectionStatus,
    error: webrtcError,
    transientStatus,
    reconnectionState,
    mediaRoute,
    peerConnectionState,
    iceConnectionState,
  } = useWebRTCManager({
    localStream,
    signaling,
    isHost: signaling.role === 'host',
    enabled: Boolean(callId) && signaling.callStatus !== 'ended',
  });

  const appState = useMemo(() => {
    return deriveAppState({
      mediaError,
      localStream,
      signalingReady: signaling.isReady,
      callStatus: signaling.callStatus,
      connectionStatus,
      reconnectionState,
    });
  }, [
    mediaError,
    localStream,
    signaling.isReady,
    signaling.callStatus,
    connectionStatus,
    reconnectionState,
  ]);

  // End call: send leave message
  const hangup = useCallback(() => {
    signaling.send('leave', {});
      if (callId) {
        void leaveCall(callId).catch((err) => {
          console.warn('[CallSession] Failed to end call', err);
        });
      }
    }, [callId, signaling]);

  // Derive peer disconnected flag from reconnection state
  const peerDisconnected = reconnectionState === 'peer-disconnected';

  // Map signaling.isReady to wsState
  const wsState: WSState = signaling.isReady ? 'ready' : 'connecting';

  const details: CallSessionDetails = useMemo(() => ({
    wsState,
    callStatus: signaling.callStatus,
    participants: signaling.participants,
    peerConnectionState,
    iceConnectionState,
    mediaRoute,
    reconnectionState,
    peerDisconnected,
    transientStatus,
    error: mediaError || webrtcError,
    remoteStream,
  }), [
    wsState,
    signaling.callStatus,
    signaling.participants,
    peerConnectionState,
    iceConnectionState,
    mediaRoute,
    reconnectionState,
    peerDisconnected,
    transientStatus,
    mediaError,
    webrtcError,
    remoteStream,
  ]);

  return {
    appState,
    localStream,
    remoteStream,
    hangup,
    details,
  };
}
