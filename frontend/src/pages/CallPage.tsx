import { useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { resetSession } from '../services/session';
import { useVideoElement } from '../hooks/useVideoElement';
import { useCallSession } from '../hooks/useCallSession';

import {
  getPeerStateMeta, 
  getIceStateMeta, 
  getBadgeClass,
  CALL_STATUS_TONE,
  CALL_STATUS_TEXT,
  WS_STATE_META, 
  MEDIA_ROUTE_META, 
} from '../hooks/uiConsts';

const CallPage = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();

  const { state, actions } = useCallSession(callId);
  const {
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
  } = state;

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // Используем хук для привязки видео
  useVideoElement(localVideoRef, localStreamState, { muted: true, playsInline: true });
  useVideoElement(remoteVideoRef, remoteStream, { playsInline: true });

  // Вычисляем infoMessage на основе состояния
  const getInfoMessage = (): string | null => {
    // Приоритет 1: transientMessage (одноразовые сообщения)
    if (transientMessage) {
      return transientMessage;
    }
    
    // Приоритет 2: callStatus === 'ended'
    if (callStatus === 'ended') {
      return 'Звонок завершён.';
    }
    
    // Приоритет 3: remoteStream подключен
    if (remoteStream && !error) {
      return 'Видео собеседника подключено.';
    }

    // Приоритет 4: соединение установлено
    if (
      !error &&
      callStatus === 'active' &&
      peerConnectionState === 'connected' &&
      (iceConnectionState === 'connected' || iceConnectionState === 'completed')
    ) {
      return 'Соединение установлено.';
    }
    
    // Приоритет 5: активный звонок, но соединение ещё устанавливается
    if (callStatus === 'active' && participants >= 2) {
      return 'Собеседник подключился. Устанавливаем медиасоединение...';
    }
    
    // Приоритет 6: по умолчанию
    return 'Готовим звонок…';
  };
  
  const infoMessage = getInfoMessage();

  const handleHangup = () => {
    actions.hangup();
    resetSession();
    navigate('/');
  };

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
