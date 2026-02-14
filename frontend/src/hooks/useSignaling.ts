import { useEffect, useRef, useCallback, useState } from 'react';
import { subscribeToSignaling, SignalingSubscription } from '../services/signaling';
import { setPeerContext } from '../services/session';
import { CallStatus, PeerRole } from '../services/types';

export type WSState = 'connecting' | 'reconnecting' | 'ready' | 'disconnected';

interface SignalingOptions {
  callId?: string;
  peerId?: string;
  enabled?: boolean;
  requirePeerId?: boolean;
  onState?: (status: CallStatus, participants: number) => void;
}

export function useSignaling(callId: string, peerId?: string) {
  const [isReady, setIsReady] = useState(false);
  const socketRef = useRef<SignalingSubscription | null>(null);

  const messageQueue = useRef<any[]>([]);

  const handlers = useRef({
    onOffer: (data: any) => {},
    onAnswer: (data: any) => {},
    onCandidate: (data: any) => {},
    onPeerLeft: () => {},
    onPeerJoined: () => {}
  });

  const setHandlers = useCallback((newHandlers: Partial<typeof handlers.current>) => {
    handlers.current = { ...handlers.current, ...newHandlers };
  }, []);

  const send = useCallback((type: string, payload: any) => {
    if (socketRef.current && isReady) {
      socketRef.current.client.send({ type, data: payload });
    } else {
      console.log('Socket not ready, queuing', type);
      messageQueue.current.push({ type, data: payload });
    }
  }, [isReady]);
}

export const useSignaling1 = ({
  callId,
  peerId,
  enabled = true,
  requirePeerId = false,
  onState,
}: SignalingOptions) => {
  const [wsState, setWsState] = useState<WSState>('connecting');
  const subscriptionRef = useRef<SignalingSubscription>();
  const stateCallbackRef = useRef<typeof onState>();

  useEffect(() => {
    stateCallbackRef.current = onState;
  }, [onState]);

  useEffect(() => {
    const shouldConnect = Boolean(enabled && callId && (!requirePeerId || peerId));

    if (!shouldConnect) {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = undefined;
      }
      setWsState(enabled ? 'connecting' : 'disconnected');
      return;
    }

    setWsState('connecting');
    const subscription = subscribeToSignaling(callId as string, peerId, {
      onOpen: () => setWsState('ready'),
      onReconnecting: () => setWsState('reconnecting'),
      onReconnected: () => setWsState('ready'),
      onJoin: (data) => {
        if (data?.peer_id) {
          setPeerContext(data.peer_id, (data.role as PeerRole) ?? 'host');
        }
        setWsState('ready');
      },
      onState: (data) => {
        stateCallbackRef.current?.(data.status, data.participants?.count ?? 1);
      },
        onClose: () => setWsState('disconnected'),
        onError: () => setWsState('reconnecting'),
    });
    subscriptionRef.current = subscription;

    return () => {
      subscription.unsubscribe();
      if (subscriptionRef.current === subscription) {
        subscriptionRef.current = undefined;
      }
    };
  }, [callId, enabled, peerId, requirePeerId]);

  return { wsState };
};
