import { useEffect, useRef, useState } from 'react';
import { subscribeToSignaling, SignalingSubscription } from '../services/signaling';
import { setPeerContext } from '../services/session';
import { CallStatus, PeerRole } from '../services/types';

export type WSState = 'connecting' | 'ready' | 'disconnected';

interface SignalingOptions {
  callId?: string;
  peerId?: string;
  enabled?: boolean;
  requirePeerId?: boolean;
  onState?: (status: CallStatus, participants: number) => void;
}

export const useSignaling = ({
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
      onError: () => setWsState('disconnected'),
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
