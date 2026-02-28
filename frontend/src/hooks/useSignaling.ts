import { useEffect, useRef, useCallback, useState } from 'react';
import { subscribeToSignaling, SignalingSubscription, SignalingEnvelope } from '../services/signaling';
import { setPeerContext } from '../services/session';
import { CallStatus, PeerRole } from '../services/types';
import { debugLog, debugWarn } from '../utils/debug';

interface SignalingOptions {
  callId?: string;
  peerId?: string;
  enabled?: boolean;
  requirePeerId?: boolean;
  onState?: (status: CallStatus, participants: number) => void;
  onJoin?: (peerId: string, role: PeerRole) => void;
  onLeave?: () => void;
}

/**
 * Smart signaling hook that manages WebSocket connection and message routing.
 * Encapsulates connection lifecycle and event handling.
 * 
 * This hook acts as a comprehensive manager for server communication,
 * hiding WebSocket complexity from the rest of the application.
 */
export function useSignaling({
  callId,
  peerId,
  enabled = true,
  requirePeerId = false,
  onState,
  onJoin,
  onLeave,
}: SignalingOptions) {
  const [isReady, setIsReady] = useState(false);
  const [role, setRole] = useState<PeerRole | null>(null);
  const [participants, setParticipants] = useState(1);
  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const subscriptionRef = useRef<SignalingSubscription | null>(null);

  // Event handlers that can be set by consumers (e.g., WebRTC manager)
  // Using Ref to avoid recreating subscriptions on every render
  const handlers = useRef({
    onOffer: (_data: any) => { },
    onAnswer: (_data: any) => { },
    onCandidate: (_data: any) => { },
    onPeerLeft: () => { },
    onPeerJoined: () => { },
    onPeerDisconnected: () => { },
    onPeerReconnected: () => { },
    onRenegotiateRequest: () => { },
  });

  // Store onState callback in ref to avoid dependency issues
  const stateCallbackRef = useRef<typeof onState>();
  const joinCallbackRef = useRef<typeof onJoin>();
  const leaveCallbackRef = useRef<typeof onLeave>();

  useEffect(() => {
    stateCallbackRef.current = onState;
    joinCallbackRef.current = onJoin;
    leaveCallbackRef.current = onLeave;
  }, [onState, onJoin, onLeave]);

  // Function to update event handlers (called by WebRTC manager in STEP_3)
  const setHandlers = useCallback((newHandlers: Partial<typeof handlers.current>) => {
    handlers.current = { ...handlers.current, ...newHandlers };
  }, []);

  // Generic send function
  const send = useCallback((type: string, payload: any) => {
    const message: SignalingEnvelope = { type, data: payload };

    if (subscriptionRef.current && isReady) {
      debugLog('[Signaling] send', { type, callId, peerId });
      subscriptionRef.current.client.send(message);
    } else {
      debugLog('[Signaling] drop (socket not ready)', { type, callId, peerId });
    }
  }, [callId, isReady, peerId]);

  // Typed helper functions for common signaling messages
  const sendOffer = useCallback((offer: RTCSessionDescriptionInit) => {
    send('offer', offer);
  }, [send]);

  const sendAnswer = useCallback((answer: RTCSessionDescriptionInit) => {
    send('answer', answer);
  }, [send]);

  const sendCandidate = useCallback((candidate: RTCIceCandidateInit) => {
    send('ice-candidate', candidate);
  }, [send]);

  // Main connection effect
  useEffect(() => {
    const shouldConnect = Boolean(enabled && callId && (!requirePeerId || peerId));

    debugLog('[Signaling] effect', { shouldConnect, enabled, callId, peerId, requirePeerId });

    if (!shouldConnect) {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
      setIsReady(false);
      return;
    }

    const subscription = subscribeToSignaling(callId as string, peerId, {
      onOpen: () => {
        setIsReady(true);
        debugLog('[Signaling] ws open', { callId, peerId });
      },
      onReconnecting: () => {
        setIsReady(false);
        debugLog('[Signaling] ws reconnecting', { callId, peerId });
      },
      onReconnected: () => {
        setIsReady(true);
        debugLog('[Signaling] ws reconnected', { callId, peerId });
      },
      onJoin: (data) => {
        debugLog('[Signaling] join', { callId, peerId, data });
        if (data?.peer_id) {
          const peerRole = (data.role as PeerRole) ?? 'host';
          setRole(peerRole);
          setPeerContext(data.peer_id, peerRole);
          joinCallbackRef.current?.(data.peer_id, peerRole);
        }
        setIsReady(true);
        handlers.current.onPeerJoined();
      },
      onState: (data) => {
        debugLog('[Signaling] state', { callId, peerId, status: data.status, participants: data.participants?.count });
        setCallStatus(data.status);
        setParticipants(data.participants?.count ?? 1);
        stateCallbackRef.current?.(data.status, data.participants?.count ?? 1);
      },
      onOffer: (message) => {
        debugLog('[Signaling] recv offer', { callId, peerId, from: message.from });
        handlers.current.onOffer(message.data);
      },
      onAnswer: (message) => {
        debugLog('[Signaling] recv answer', { callId, peerId, from: message.from });
        handlers.current.onAnswer(message.data);
      },
      onIceCandidate: (message) => {
        debugLog('[Signaling] recv candidate', { callId, peerId, from: message.from });
        handlers.current.onCandidate(message.data);
      },
      onLeave: () => {
        debugLog('[Signaling] leave', { callId, peerId });
        setCallStatus('ended');
        setParticipants(1);
        handlers.current.onPeerLeft();
        leaveCallbackRef.current?.();
      },
      onMessage: (message) => {
        debugLog('[Signaling] recv message', { callId, peerId, type: message.type, from: message.from });
        // Handle extended signaling messages
        if (message.type === 'peer-disconnected') {
          handlers.current.onPeerDisconnected();
        } else if (message.type === 'peer-reconnected') {
          handlers.current.onPeerReconnected();
        } else if (message.type === 'renegotiate-request') {
          handlers.current.onRenegotiateRequest();
        }
      },
      onClose: () => {
        setIsReady(false);
        debugLog('[Signaling] ws close', { callId, peerId });
      },
      onError: () => {
        setIsReady(false);
        debugWarn('[Signaling] ws error', { callId, peerId });
      },
    });

    subscriptionRef.current = subscription;

    return () => {
      subscription.unsubscribe();
      if (subscriptionRef.current === subscription) {
        subscriptionRef.current = null;
      }
      setIsReady(false);
    };
  }, [callId, enabled, peerId, requirePeerId]);

  return {
    isReady,
    role,
    participants,
    callStatus,
    sendOffer,
    sendAnswer,
    sendCandidate,
    send,
    setHandlers,
  };
}
