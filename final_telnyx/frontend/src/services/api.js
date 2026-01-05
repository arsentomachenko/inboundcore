import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Users API
export const usersAPI = {
  getAll: (params = {}) => {
    // Support both paginated and non-paginated calls
    // If no params provided, get first 10000 for backwards compatibility
    const defaultParams = { page: 1, limit: 10000, ...params };
    return api.get('/users', { params: defaultParams });
  },
  getPaginated: (page = 1, limit = 50, filters = {}) => {
    return api.get('/users', { 
      params: { page, limit, ...filters } 
    });
  },
  getById: (id) => api.get(`/users/${id}`),
  create: (userData) => api.post('/users', userData),
  update: (id, userData) => api.put(`/users/${id}`, userData),
  delete: (id) => api.delete(`/users/${id}`),
  deleteAll: () => api.delete('/users'),
  import: (formData) => api.post('/users/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }),
  importCSV: (formData) => api.post('/users/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }),
  getPending: () => api.get('/users/pending/list'),
  resetCallStatus: (userId) => api.post(`/users/${userId}/reset`),
  getAnswered: () => api.get('/users/answered/list'),
  getByAnswerType: (answerType) => api.get(`/users/answer-type/${answerType}`),
  getAnswerStats: () => api.get('/users/stats/answer-breakdown'),
};

// Calls API
export const callsAPI = {
  initiate: (userId, fromNumber) => api.post('/calls/initiate', { userId, fromNumber }),
  hangup: (callControlId) => api.post('/calls/hangup', { callControlId }),
  getActive: () => api.get('/calls/active'),
  getStatus: (callControlId) => api.get(`/calls/${callControlId}/status`),
};

// DID API
export const didAPI = {
  getAvailable: (areaCode) => api.get('/did/available', { params: { areaCode } }),
  getPurchased: () => api.get('/did/purchased'),
  purchase: (phoneNumber) => api.post('/did/purchase', { phoneNumber }),
  getRotation: () => api.get('/did/rotation'),
  configureRotation: (numbers, enabled, strategy = 'area_code') => 
    api.post('/did/rotation/configure', { numbers, enabled, strategy }),
  toggleRotation: () => api.post('/did/rotation/toggle'),
  getNext: () => api.get('/did/rotation/next'),
  matchDID: (recipientPhone, recipientState) => 
    api.post('/did/rotation/match', { recipientPhone, recipientState }),
};

// Agent API
export const agentAPI = {
  getStatus: () => api.get('/agent/stats'),  // Changed from /status to /stats to include costs
  start: (userIds, delayBetweenCalls, transferNumber) => 
    api.post('/agent/start', { userIds, delayBetweenCalls, transferNumber }),
  stop: () => api.post('/agent/stop'),
  pause: () => api.post('/agent/pause'),
  resume: () => api.post('/agent/resume'),
  getStats: () => api.get('/agent/stats'),
  getConfig: () => api.get('/agent/config'),
  updateConfig: (config) => api.put('/agent/config', config),
  getTransferredCalls: () => api.get('/agent/transferred-calls'),
  clearTransferredCalls: () => api.delete('/agent/transferred-calls'),
  clearAllCosts: () => api.delete('/agent/costs'),
};

// Conversations API
export const conversationsAPI = {
  getAll: (page = 1, limit = 20, filter = 'all', durationFilter = null) => 
    api.get('/conversations', { params: { page, limit, filter, ...(durationFilter && { durationFilter }) } }),
  getById: (callControlId) => api.get(`/conversations/${callControlId}`),
  getRecording: (callControlId) => api.get(`/conversations/${callControlId}/recording`),
  clearAll: () => api.delete('/conversations'),
};

export default api;

