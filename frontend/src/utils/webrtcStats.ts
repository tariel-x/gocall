import { MediaRouteMode } from '../services/types';

interface MediaRouteInfo {
  mode: MediaRouteMode;
  detail?: string;
}

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

export function parseMediaRouteStats(stats: RTCStatsReport): MediaRouteInfo {
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
    return { mode: 'unknown' };
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

  return {
    mode: usesRelay ? 'relay' : 'direct',
    detail: detailParts.join(' | ') || undefined,
  };
}
