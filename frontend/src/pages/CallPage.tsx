import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { resetSession } from '../services/session';
import { useVideoElement } from '../hooks/useVideoElement';
import { useCallSession } from '../hooks/useCallSession';
import { useCallStatusMessage } from '../hooks/useCallStatusMessage';
import { CallStatusPanel } from '../components/CallStatusPanel';
import { CallControls } from '../components/CallControls';

const CallPage = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();
  const [showStatusPanel, setShowStatusPanel] = useState(false);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);

  const {
    localStream,
    remoteStream,
    hangup,
    details,
  } = useCallSession(callId);
  const { callStatus, participants, error } = details;

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // Используем хук для привязки видео
  useVideoElement(localVideoRef, localStream, { muted: true, playsInline: true });
  useVideoElement(remoteVideoRef, remoteStream, { playsInline: true });

  const { infoMessage, reconnectionLabel } = useCallStatusMessage(details);

  const handleHangup = () => {
    hangup();
    resetSession();
    navigate('/');
  };

  const remotePlaceholder = participants < 2
    ? 'Ждём подключение собеседника…'
    : 'Ждём видео от собеседника…';
  return (
    <main className="call-page-new">
      <section className="call-top-area">
        <div className="remote-video-container">
          <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline />
          {!remoteStream && <div className="video-placeholder">{remotePlaceholder}</div>}
        </div>

        <div className="local-video-floating">
          <video ref={localVideoRef} className="local-video" autoPlay playsInline muted />
          {!localStream && <div className="video-placeholder">Камера выключена</div>}
        </div>

        <CallStatusPanel
          isOpen={showStatusPanel}
          onClose={() => setShowStatusPanel(false)}
          details={details}
          reconnectionLabel={reconnectionLabel}
          toggleButtonRef={toggleButtonRef}
        />
      </section>

      <CallControls
        ref={toggleButtonRef}
        onHangup={handleHangup}
        onToggleStatus={(e) => {
          e.stopPropagation();
          setShowStatusPanel(!showStatusPanel);
        }}
        showStatusPanel={showStatusPanel}
        infoMessage={infoMessage}
        reconnectionLabel={reconnectionLabel}
        error={error}
        callStatus={callStatus}
      />
    </main>
  );
};

export default CallPage;
