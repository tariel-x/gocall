import React, { useEffect, useRef } from 'react';
import { CallSessionDetails } from '../services/types';
import {
  getPeerStateMeta,
  getIceStateMeta,
  getBadgeClass,
  CALL_STATUS_TONE,
  CALL_STATUS_TEXT,
  WS_STATE_META,
  MEDIA_ROUTE_META,
} from '../utils/callStatusUtils';

interface CallStatusPanelProps {
  isOpen: boolean;
  onClose: () => void;
  details: CallSessionDetails;
  reconnectionLabel: string | null;
  toggleButtonRef?: React.RefObject<HTMLElement>;
}

export const CallStatusPanel: React.FC<CallStatusPanelProps> = ({
  isOpen,
  onClose,
  details,
  reconnectionLabel,
  toggleButtonRef,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const {
    wsState,
    callStatus,
    participants,
    peerConnectionState,
    iceConnectionState,
    mediaRoute,
  } = details;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedPanel = panelRef.current && panelRef.current.contains(target);
      const clickedButton = toggleButtonRef?.current && toggleButtonRef.current.contains(target);

      if (!clickedPanel && !clickedButton) {
        onClose();
      }
    };

    document.addEventListener('click', handleClickOutside, true);
    return () => document.removeEventListener('click', handleClickOutside, true);
  }, [isOpen, onClose, toggleButtonRef]);

  if (!isOpen) {
    return null;
  }

  const peerStateMeta = getPeerStateMeta(peerConnectionState);
  const iceStateMeta = getIceStateMeta(iceConnectionState);
  const wsStateMeta = WS_STATE_META[wsState];
  const mediaRouteMeta = MEDIA_ROUTE_META[mediaRoute.mode];

  return (
    <div className="status-overlay" ref={panelRef} onClick={(e) => e.stopPropagation()}>
      <div className="status-overlay-content">
        <div className="call-status-grid">
          <div className="call-stat">
            <span className="status-label">Статус звонка</span>
            <span className={getBadgeClass(CALL_STATUS_TONE[callStatus])}>
              {CALL_STATUS_TEXT[callStatus]}
            </span>
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
          {reconnectionLabel && (
            <div className="call-stat">
              <span className="status-label">Переподключение</span>
              <span className={getBadgeClass('connecting')}>{reconnectionLabel}</span>
            </div>
          )}
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
      </div>
    </div>
  );
};
