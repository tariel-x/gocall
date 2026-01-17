import axios from 'axios';
import { CallDetailsResponse, CallResponse, JoinResponse, TurnConfig } from './types';

const resolveBaseURL = (): string => {
  const value = window.API_ADDRESS;
  if (value === undefined || value === null) {
    return '';
  }
  return value;
};

export const apiClient = axios.create({
  baseURL: resolveBaseURL(),
  withCredentials: true
});

export const fetchTurnConfig = async (): Promise<TurnConfig> => {
  const { data } = await apiClient.get<TurnConfig>('/api/turn-config');
  return data;
};

export const createCall = async (): Promise<CallResponse> => {
  const { data } = await apiClient.post<CallResponse>('/api/calls');
  return data;
};

export const getCall = async (callId: string): Promise<CallDetailsResponse> => {
  const { data } = await apiClient.get<CallDetailsResponse>(`/api/calls/${callId}`);
  return data;
};

export const joinCall = async (callId: string): Promise<JoinResponse> => {
  const { data } = await apiClient.post<JoinResponse>(`/api/calls/${callId}/join`);
  return data;
};
