import { useMemo } from 'react';
import { CallSessionDetails } from '../services/types';
import { getDetailedStatusMessage } from '../utils/callStatusUtils';

interface CallStatusMessages {
  infoMessage: string | null;
  reconnectionLabel: string | null;
}

export function useCallStatusMessage(details: CallSessionDetails): CallStatusMessages {
  return useMemo(() => {
    return getDetailedStatusMessage(details);
  }, [details]);
}

