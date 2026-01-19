import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTurnConfig } from '../services/api';
import { acquireLocalMedia, getLocalStream, releaseLocalStream } from '../services/media';
import { getSessionState, setCallContext, setPeerContext, SessionState } from '../services/session';
import { CallStatus, PeerRole } from '../services/types';
import { SignalingClient, SignalingSubscription, subscribeToSignaling } from '../services/signaling';
import type { WSState } from './useSignaling';
import { MediaRouteMode } from './uiConsts';

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

export interface UseCallSessionState {
  sessionInfo: SessionState;
  wsState: WSState;
  callStatus: CallStatus;
  participants: number;
  error: string | null;
  remoteStream: MediaStream | null;
  localStreamState: MediaStream | null;
  peerConnectionState: RTCPeerConnectionState | 'new';
  iceConnectionState: RTCIceConnectionState | 'new';
  mediaRoute: { mode: MediaRouteMode; detail?: string };
  transientMessage: string | null;
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
  const [sessionInfo, setSessionInfo] = useState<SessionState>(() => getSessionState());
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

  const signalingRef = useRef<SignalingClient | null>(null);
  const signalingSubscriptionRef = useRef<SignalingSubscription | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const offerSentRef = useRef(false);
  
  // Обновляем connectionParamsRef при изменении sessionInfo
  connectionParamsRef.current = {
    peerId: sessionInfo.peerId,
    role: sessionInfo.role ?? connectionParamsRef.current.role ?? 'host',
  };

  useEffect(() => {
    if (!callId) {
      return;
    }
    setCallContext(callId);
    setSessionInfo((prev) => ({ ...prev, callId }));
  }, [callId]);

  const resetMediaRoute = useCallback(() => {
    setMediaRoute({ mode: 'unknown' });
  }, []);

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
    releaseLocalStream();
    if (!options?.preserveState) {
      setRemoteStream(null);
      setLocalStreamState(null);
      setPeerConnectionState('new');
      setIceConnectionState('new');
      setWsState('disconnected');
      resetMediaRoute();
    }
  }, [resetMediaRoute]);

  const sendSignal = useCallback((type: string, data?: unknown) => {
    if (!signalingRef.current) {
      console.warn('[CALL] Signaling is not ready, unable to send', type);
      return;
    }
    signalingRef.current.send({ type, data });
  }, []);

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
      setError('Не удалось обработать предложение от собеседника. Перезагрузите страницу и попробуйте снова.');
    }
  }, [flushPendingCandidates, sendSignal]);

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
      setError('Не удалось применить ответ собеседника. Попробуйте перезапустить звонок.');
    }
  }, [flushPendingCandidates]);

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

  const createOffer = useCallback(async () => {
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
      setError('Не удалось создать предложение для звонка. Попробуйте перезагрузить страницу.');
    }
  }, [sendSignal]);

  // Проверка условий для auto-offer (host должен создать offer когда готов)
  const checkAndCreateOffer = useCallback(() => {
    if (connectionParamsRef.current.role !== 'host') {
      return;
    }
    if (participants < 2 || wsState !== 'ready') {
      return;
    }
    if (!pcRef.current || offerSentRef.current) {
      return;
    }
    createOffer();
  }, [participants, wsState, createOffer]);

  useEffect(() => {
    if (!callId) {
      setError('Не указан идентификатор звонка. Вернитесь на главный экран.');
      return;
    }

    const { peerId, role } = connectionParamsRef.current;
    if (role === 'guest' && !peerId) {
      setError('Сессия гостя не найдена. Пройдите заново по приглашению.');
      return;
    }

    let isActive = true;

    const init = async () => {
      setError(null);
      setTransientMessage(null);
      setCallStatus('waiting');
      setParticipants(1);
      setWsState('connecting');

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

      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      if (mediaStream) {
        const streamForTracks = mediaStream;
        streamForTracks.getTracks().forEach((track) => {
          pc.addTrack(track, streamForTracks);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal('ice-candidate', event.candidate.toJSON());
        }
      };

      pc.ontrack = (event) => {
        if (!isActive) {
          return;
        }
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
        }
      };

      pc.onconnectionstatechange = () => {
        if (!isActive) {
          return;
        }
        setPeerConnectionState(pc.connectionState ?? 'new');
        if (pc.connectionState === 'failed') {
          setError('WebRTC соединение завершилось с ошибкой. Попробуйте перезапустить звонок.');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (!isActive) {
          return;
        }
        const state = pc.iceConnectionState ?? 'new';
        setIceConnectionState(state);
        if (state === 'connected' || state === 'completed') {
          void updateMediaRoute();
        }
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          resetMediaRoute();
        }
      };

      const subscription = subscribeToSignaling(callId, peerId, {
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
          // Проверяем условия для auto-offer после onJoin
          setTimeout(() => checkAndCreateOffer(), 0);
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
          } else {
            // Проверяем условия для auto-offer после обновления participants
            setTimeout(() => checkAndCreateOffer(), 0);
          }
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
          setCallStatus('ended');
          teardownSession();
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
  }, [callId, handleRemoteAnswer, handleRemoteCandidate, handleRemoteOffer, resetMediaRoute, sendSignal, teardownSession, updateMediaRoute, checkAndCreateOffer]);

  const hangup = useCallback(() => {
    setCallStatus('ended');
    teardownSession();
  }, [teardownSession]);

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
    },
    actions: {
      setTransientMessage,
      hangup,
    },
  };
}
