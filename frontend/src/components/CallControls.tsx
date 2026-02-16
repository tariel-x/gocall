import React, { forwardRef } from 'react';
import { CallStatus } from '../services/types';

interface CallControlsProps {
  onHangup: () => void;
  onToggleStatus: (e: React.MouseEvent) => void;
  infoMessage: string | null;
  reconnectionLabel: string | null;
  error: string | null;
  callStatus: CallStatus;
  showStatusPanel: boolean;
}

export const CallControls = forwardRef<HTMLButtonElement, CallControlsProps>(
  ({
    onHangup,
    onToggleStatus,
    infoMessage,
    reconnectionLabel,
    error,
    callStatus,
    showStatusPanel,
  }, ref) => {
    const hangupLabel = callStatus === 'ended' ? 'На главную' : 'Завершить звонок';

    return (
      <section className="call-bottom-bar">
        <div className="bottom-left-section">
          <button className="danger-button" onClick={onHangup}>
            {hangupLabel}
          </button>
          <div className="status-text-container">
            {reconnectionLabel && (
              <span className="status-badge status-connecting">{reconnectionLabel}</span>
            )}
            {infoMessage && <p className="call-status-text">{infoMessage}</p>}
            {error && <p className="call-error-text">{error}</p>}
          </div>
        </div>

        <button ref={ref} className="status-toggle-button" onClick={onToggleStatus}>
          {showStatusPanel ? 'Скрыть статус' : 'Показать статус'}
        </button>
      </section>
    );
  }
);
