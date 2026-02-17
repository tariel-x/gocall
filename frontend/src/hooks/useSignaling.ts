import { useEffect, useRef, useCallback, useState } from 'react';
import { subscribeToSignaling, SignalingSubscription, SignalingEnvelope } from '../services/signaling';
import { setPeerContext } from '../services/session';
import { CallStatus, PeerRole, WSState } from '../services/types';

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
 * Encapsulates connection lifecycle, message queueing, and event handling.
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
  const messageQueue = useRef<SignalingEnvelope[]>([]);

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

  // Generic send function with message queueing
  const send = useCallback((type: string, payload: any) => {
    const message: SignalingEnvelope = { type, data: payload };

    if (subscriptionRef.current && isReady) {
      subscriptionRef.current.client.send(message);
    } else {
      console.log('Socket not ready, queuing', type);
      messageQueue.current.push(message);
    }
  }, [isReady]);

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
        // Flush message queue when socket becomes ready
        if (messageQueue.current.length > 0) {
          console.log('Flushing message queue:', messageQueue.current.length);
          messageQueue.current.forEach(msg => subscription.client.send(msg));
          messageQueue.current = [];
        }
      },
      onReconnecting: () => {
        setIsReady(false);
      },
      onReconnected: () => {
        setIsReady(true);
      },
      onJoin: (data) => {
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
        setCallStatus(data.status);
        setParticipants(data.participants?.count ?? 1);
        stateCallbackRef.current?.(data.status, data.participants?.count ?? 1);
      },
      onOffer: (message) => {
        handlers.current.onOffer(message.data);
      },
      onAnswer: (message) => {
        handlers.current.onAnswer(message.data);
      },
      onIceCandidate: (message) => {
        handlers.current.onCandidate(message.data);
      },
      onLeave: () => {
        setCallStatus('ended');
        setParticipants(1);
        handlers.current.onPeerLeft();
        leaveCallbackRef.current?.();
      },
      onMessage: (message) => {
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
      },
      onError: () => {
        setIsReady(false);
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
