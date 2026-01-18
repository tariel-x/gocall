import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTurnConfig } from '../services/api';
import { acquireLocalMedia, getLocalStream, releaseLocalStream } from '../services/media';
import {
  getSessionState,
  resetSession,
  setCallContext,
  setPeerContext,
  SessionState,
} from '../services/session';
import { CallStatus, PeerRole } from '../services/types';
import { SignalingClient, SignalingSubscription, subscribeToSignaling } from '../services/signaling';
import type { WSState } from '../hooks/useSignaling';

import {
  MediaRouteMode, 
  getPeerStateMeta, 
  getIceStateMeta, 
  getBadgeClass,
  CALL_STATUS_TONE,
  CALL_STATUS_TEXT,
  WS_STATE_META, 
  MEDIA_ROUTE_META, 
} from '../hooks/uiConsts';

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


const CallPage = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();

  const [sessionInfo, setSessionInfo] = useState<SessionState>(() => getSessionState());
  const connectionParamsRef = useRef<{ peerId?: string; role: PeerRole }>({
    peerId: sessionInfo.peerId,
    role: sessionInfo.role ?? 'host',
  });

  const [wsState, setWsState] = useState<WSState>('connecting');
  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const [participants, setParticipants] = useState(1);
  const [infoMessage, setInfoMessage] = useState('Готовим звонок…');
  const [error, setError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(getLocalStream());
  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState | 'new'>('new');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'new'>('new');
  const [mediaRoute, setMediaRoute] = useState<{ mode: MediaRouteMode; detail?: string }>({ mode: 'unknown' });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const signalingSubscriptionRef = useRef<SignalingSubscription | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const offerSentRef = useRef(false);
  const remoteStreamRef = useRef<MediaStream | null>(remoteStream);

  useEffect(() => {
    remoteStreamRef.current = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    connectionParamsRef.current = {
      peerId: sessionInfo.peerId,
      role: sessionInfo.role ?? connectionParamsRef.current.role ?? 'host',
    };
  }, [sessionInfo.peerId, sessionInfo.role]);

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
      setInfoMessage('Отправили ответ. Ждём подключение...');
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
      setInfoMessage('Ответ получен. Устанавливаем соединение...');
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
      setInfoMessage('Формируем предложение...');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal('offer', offer);
      offerSentRef.current = true;
    } catch (err) {
      console.error('[CALL] Failed to create offer', err);
      setError('Не удалось создать предложение для звонка. Попробуйте перезагрузить страницу.');
    }
  }, [sendSignal]);

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
      setInfoMessage('Готовим звонок…');
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
        },
        onState: (data) => {
          if (!isActive) {
            return;
          }
          setCallStatus(data.status);
          setParticipants(data.participants?.count ?? 1);
          if (data.status === 'ended') {
            setInfoMessage('Звонок завершён.');
            teardownSession();
          } else if (data.status === 'active' && !remoteStreamRef.current) {
            setInfoMessage('Собеседник подключился. Устанавливаем медиасоединение...');
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
          setInfoMessage('Собеседник покинул звонок.');
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
  }, [callId, handleRemoteAnswer, handleRemoteCandidate, handleRemoteOffer, resetMediaRoute, sendSignal, teardownSession, updateMediaRoute]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) {
      return;
    }
    video.muted = true;
    video.playsInline = true;
    video.srcObject = localStreamState ?? null;
    if (localStreamState) {
      void video.play().catch(() => undefined);
    }
  }, [localStreamState]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) {
      return;
    }
    video.playsInline = true;
    video.srcObject = remoteStream ?? null;
    if (remoteStream) {
      void video.play().catch(() => undefined);
    }
  }, [remoteStream]);

  useEffect(() => {
    if (remoteStream && !error) {
      setInfoMessage('Видео собеседника подключено.');
    }
  }, [remoteStream, error]);

  useEffect(() => {
    if (
      !error &&
      callStatus === 'active' &&
      peerConnectionState === 'connected' &&
      (iceConnectionState === 'connected' || iceConnectionState === 'completed')
    ) {
      setInfoMessage('Соединение установлено.');
    }
  }, [callStatus, error, iceConnectionState, peerConnectionState]);

  useEffect(() => {
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

  const handleHangup = useCallback(() => {
    setInfoMessage('Завершаем звонок...');
    setCallStatus('ended');
    teardownSession();
    resetSession();
    navigate('/');
  }, [navigate, teardownSession]);

  const safeCallId = callId ?? '—';

  const remotePlaceholder = participants < 2
    ? 'Ждём подключение собеседника…'
    : 'Ждём видео от собеседника…';
  const roleLabel = (sessionInfo.role ?? 'host') === 'host' ? 'Инициатор' : 'Гость';
  const hangupLabel = callStatus === 'ended' ? 'На главную' : 'Завершить звонок';

  const peerStateMeta = getPeerStateMeta(peerConnectionState);
  const iceStateMeta = getIceStateMeta(iceConnectionState);
  const wsStateMeta = WS_STATE_META[wsState];
  const mediaRouteMeta = MEDIA_ROUTE_META[mediaRoute.mode];

  return (
    <main className="call-page">
      <header className="call-header">
        <div>
          <p className="call-title">Звонок</p>
          <p className="call-meta">ID: {safeCallId}</p>
          <p className="call-meta">Роль: {roleLabel}</p>
        </div>
        <button className="danger-button" onClick={handleHangup}>
          {hangupLabel}
        </button>
      </header>

      <section className="video-stage">
        <div className="remote-video-shell video-shell">
          <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline />
          {!remoteStream && <div className="video-placeholder">{remotePlaceholder}</div>}
        </div>
        <div className="local-preview">
          <div className="local-preview-header">Вы</div>
          <div className="local-preview-video video-shell">
            <video ref={localVideoRef} className="local-video" autoPlay playsInline muted />
            {!localStreamState && <div className="video-placeholder">Камера выключена</div>}
          </div>
        </div>
      </section>

      <section className="status-card call-status-card">
        <div className="call-status-grid">
          <div className="call-stat">
            <span className="status-label">Статус звонка</span>
            <span className={getBadgeClass(CALL_STATUS_TONE[callStatus])}>{CALL_STATUS_TEXT[callStatus]}</span>
          </div>
          <div className="call-stat">
            <span className="status-label">Сигналинг</span>
            <span className={getBadgeClass(wsStateMeta.tone)}>{wsStateMeta.label}</span>
          </div>
          <div className="call-stat">
            <span className="status-label">WebRTC</span>
            <span className={getBadgeClass(peerStateMeta.tone)}>{peerStateMeta.label}</span>
          </div>
          <div className="call-stat">
            <span className="status-label">ICE</span>
            <span className={getBadgeClass(iceStateMeta.tone)}>{iceStateMeta.label}</span>
          </div>
          <div className="call-stat">
            <span className="status-label">Медиа-канал</span>
            <span className={getBadgeClass(mediaRouteMeta.tone)}>{mediaRouteMeta.label}</span>
            {mediaRoute.detail && <span className="call-stat-detail">{mediaRoute.detail}</span>}
          </div>
          <div className="call-stat">
            <span className="status-label">Участники</span>
            <span className="call-stat-value">{participants}/2</span>
          </div>
        </div>
      </section>

      {infoMessage && <p className="page-meta">{infoMessage}</p>}
      {error && <p className="page-error">{error}</p>}
    </main>
  );
};

export default CallPage;
