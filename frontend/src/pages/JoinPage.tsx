import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getCall, joinCall } from '../services/api';
import { useMediaPermissions } from '../hooks/useMedia';
import { useSignaling } from '../hooks/useSignaling';
import { getSessionState, resetSession, setCallContext, setPeerContext, SessionState } from '../services/session';
import type { CallStatus } from '../services/types';

const JoinPage = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();

  const [sessionState, setSessionState] = useState<SessionState>(() => getSessionState());
  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isCallLoaded, setIsCallLoaded] = useState(false);

  const { mediaState, mediaError, requestMedia } = useMediaPermissions();
  const { isReady } = useSignaling({
    callId,
    peerId: sessionState.peerId,
    enabled: Boolean(sessionState.peerId),
    requirePeerId: true,
    onState: (status, count) => {
      setCallStatus(status);
      setParticipants(count);
    },
  });

  useEffect(() => {
    if (!callId) {
      setError('Не указан ID звонка.');
      return;
    }
    let cancelled = false;
    resetSession();
    setCallContext(callId);
    setSessionState({ callId });
    setIsCallLoaded(false);
    getCall(callId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setCallStatus(response.status);
        setParticipants(response.participants?.count ?? 0);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const statusCode = (err as { response?: { status?: number } })?.response?.status;
        if (statusCode === 404) {
          setError('Звонок не найден или уже завершён.');
          return;
        }
        if (err instanceof Error) {
          setError(err.message);
          return;
        }
        setError('Не удалось получить информацию о звонке.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsCallLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [callId]);

  const handleJoin = async () => {
    if (!callId || isJoining) {
      return;
    }
    setIsJoining(true);
    setError(null);
    try {
      await requestMedia();
      const response = await joinCall(callId);
      setCallContext(callId);
      setPeerContext(response.peer_id, 'guest');
      setSessionState({ callId, peerId: response.peer_id, role: 'guest' });
      navigate(`/call/${callId}`);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Не удалось присоединиться к звонку.');
      }
    } finally {
      setIsJoining(false);
    }
  };

  const signalingBadgeClass = isReady ? 'status-badge status-ready' : 'status-badge status-connecting';

  if (!callId) {
    return (
      <main className="page">
        <h1>Подключение к звонку</h1>
        <p className="page-error">Не указан ID звонка.</p>
        <button className="primary-button" onClick={() => navigate('/')}>Создать новый звонок</button>
      </main>
    );
  }

  if (error) {
    return (
      <main className="page">
        <h1>Подключение к звонку</h1>
        <p className="page-error">{error}</p>
        <button className="primary-button" onClick={() => navigate('/')}>Создать новый звонок</button>
      </main>
    );
  }

  return (
    <main className="page wait-page">
      <h1>Подключиться к звонку</h1>
      {!isCallLoaded && <p className="page-meta">Ищем звонок…</p>}
      {sessionState.peerId === undefined && (
        <p className="page-meta">Сигналинг подключится после нажатия кнопки «Подключиться».</p>
      )}
      <div className="status-card">
        <div className="status-row">
          <span className="status-label">Статус:</span>
          <span className={`status-badge status-${callStatus}`}>
            {callStatus === 'waiting' && 'Ждём инициатора'}
            {callStatus === 'active' && 'Звонок в процессе'}
            {callStatus === 'ended' && 'Звонок завершён'}
          </span>
        </div>
        <div className="status-row">
          <span className="status-label">Подключено:</span>
          <span>{participants}/2</span>
        </div>
        <div className="status-row">
          <span className="status-label">Сигналинг:</span>
          {sessionState.peerId ? (
            <span className={signalingBadgeClass}>
              {isReady ? 'Соединение установлено' : 'Подключаемся...'}
            </span>
          ) : (
            <span className="status-badge status-waiting">Подключится после входа</span>
          )}
        </div>
      </div>

      <section className="media-block">
        <h2>Камера и микрофон</h2>
        <p>Перед подключением разрешите использование устройств, чтобы ускорить начало звонка.</p>
        <button className="secondary-button" onClick={requestMedia} disabled={mediaState === 'pending' || mediaState === 'granted'}>
          {mediaState === 'granted' ? 'Доступ предоставлен' : mediaState === 'pending' ? 'Запрашиваем...' : 'Разрешить устройства'}
        </button>
        {mediaError && <p className="page-error">{mediaError}</p>}
      </section>

      <button className="primary-button" onClick={handleJoin} disabled={isJoining || !isCallLoaded}>
        {isJoining ? 'Подключаемся…' : 'Подключиться'}
      </button>
    </main>
  );
};

export default JoinPage;
