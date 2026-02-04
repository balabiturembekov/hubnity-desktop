import axios, { AxiosInstance } from 'axios';
import { logger } from './logger';

const API_BASE_URL = 'https://app.automatonsoft.de/api';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    avatar: string;
    hourlyRate: number;
    companyId: string;
    company: {
      id: string;
      name: string;
    };
  };
  access_token: string;
  refresh_token: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  clientName: string;
  budget: number;
  status: string;
  companyId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntry {
  id: string;
  userId: string;
  projectId: string;
  startTime: string;
  endTime: string | null;
  duration: number;
  description: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar: string;
  };
  project?: {
    id: string;
    name: string;
    color: string;
  };
}

export interface StartTimeEntryRequest {
  projectId: string;
  userId: string;
  startTime?: string; // ISO date string, optional - server will use current time if not provided
  description?: string;
}

export interface HeartbeatRequest {
  isActive: boolean;
}

export interface HeartbeatResponse {
  success: boolean;
  timestamp: string;
}

export interface Screenshot {
  id: string;
  timeEntryId: string;
  imageUrl: string;
  thumbnailUrl: string;
  timestamp: string;
  createdAt: string;
}

export interface UrlActivity {
  timeEntryId: string;
  url: string;
  domain: string;
  title: string;
  timeSpent: number; // in seconds
}

export interface UrlActivityRequest {
  activities: UrlActivity[];
}

export interface UrlActivityResponse {
  id: string;
  timeEntryId: string;
  userId: string;
  url: string;
  domain: string;
  title: string;
  timeSpent: number;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchUrlActivityResponse {
  count: number;
  skipped: number;
  activities: UrlActivityResponse[];
}

class ApiClient {
  private client: AxiosInstance;
  private accessToken: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 second timeout for all requests (can be overridden per request)
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // Load token from storage
    this.loadToken();

    // Add request interceptor to include token
    this.client.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      // For FormData requests, don't override Content-Type - let browser set it with boundary
      if (config.data instanceof FormData) {
        delete config.headers['Content-Type'];
      }
      return config;
    });

    // Add response interceptor to handle 401 errors and refresh token
    let isRefreshing = false;
    let failedQueue: Array<{
      resolve: (value?: any) => void;
      reject: (error?: any) => void;
    }> = [];

    const processQueue = (error: any, token: string | null = null) => {
      failedQueue.forEach((prom) => {
        if (error) {
          prom.reject(error);
        } else {
          prom.resolve(token);
        }
      });
      failedQueue = [];
    };

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        
        // If we get a 401 and haven't tried to refresh yet
        if (error.response?.status === 401 && !originalRequest._retry) {
          if (isRefreshing) {
            // If already refreshing, queue this request
            return new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            })
              .then((token) => {
                originalRequest.headers.Authorization = `Bearer ${token}`;
                return this.client(originalRequest);
              })
              .catch((err) => {
                return Promise.reject(err);
              });
          }

          originalRequest._retry = true;
          isRefreshing = true;
          
          try {
            const refreshToken = localStorage.getItem('refresh_token');
            if (!refreshToken) {
              throw new Error('No refresh token available');
            }
            
            // Try to refresh the token
            const response = await axios.post<LoginResponse>(
              `${API_BASE_URL}/auth/refresh`,
              { refresh_token: refreshToken },
              { timeout: 10000 } // 10 second timeout
            );
            
            const { access_token, refresh_token: newRefreshToken } = response.data;
            this.setToken(access_token);
            // Always update refresh_token if provided, or clear it if not (token rotation)
            if (newRefreshToken) {
              localStorage.setItem('refresh_token', newRefreshToken);
            } else {
              // If server doesn't return new refresh token, keep the old one
              // Some servers only return new refresh token on rotation
              // But if server explicitly returns null/empty, we should clear it
              // For now, we keep the old one to avoid breaking the flow
            }
            
            // PRODUCTION: Обновляем токены в Rust AuthManager после refresh
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('set_auth_tokens', {
              access_token: access_token,
              refresh_token: newRefreshToken || localStorage.getItem('refresh_token'),
            }).catch((e) => {
              logger.error('API', 'Failed to update tokens in Rust AuthManager after refresh', e);
              // Не блокируем refresh, но логируем ошибку
            });
            
            isRefreshing = false;
            processQueue(null, access_token);
            
            // Retry the original request with new token
            originalRequest.headers.Authorization = `Bearer ${access_token}`;
            return this.client(originalRequest);
          } catch (refreshError: any) {
            isRefreshing = false;
            // Refresh failed, clear tokens immediately
            this.clearToken();
            processQueue(refreshError, null);
            
            // If refresh token is invalid or expired, trigger logout
            // This will be handled by the app if it listens to auth errors
            if (
              refreshError?.response?.status === 401 || 
              refreshError?.response?.status === 403 ||
              refreshError?.message?.includes('No refresh token')
            ) {
              // Token is invalid, user needs to login again
              // Emit event to trigger logout in the app
              window.dispatchEvent(new CustomEvent('auth:logout'));
            }
            
            return Promise.reject(refreshError);
          }
        }
        
        return Promise.reject(error);
      }
    );
  }

  private loadToken() {
    const token = localStorage.getItem('access_token');
    if (token) {
      this.accessToken = token;
    }
  }

  setToken(token: string) {
    this.accessToken = token;
    localStorage.setItem('access_token', token);
  }

  clearToken() {
    this.accessToken = null;
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
  }

  // Get current access token (for use in Rust uploads, etc.)
  getAccessToken(): string | null {
    return this.accessToken || localStorage.getItem('access_token');
  }

  // Auth
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const response = await this.client.post<LoginResponse>('/auth/login', credentials);
    // FIX: Не сохраняем токены здесь - они будут сохранены в useAuthStore.login()
    // после успешного обновления состояния, чтобы избежать рассинхронизации
    return response.data;
  }

  // Projects
  async getProjects(): Promise<Project[]> {
    const response = await this.client.get<Project[]>('/projects');
    return response.data;
  }

  // Time Entries
  async getActiveTimeEntries(): Promise<TimeEntry[]> {
    const response = await this.client.get<TimeEntry[]>('/time-entries/active');
    return response.data;
  }

  async getTimeEntry(id: string): Promise<TimeEntry> {
    const response = await this.client.get<TimeEntry>(`/time-entries/${id}`);
    return response.data;
  }

  async startTimeEntry(data: StartTimeEntryRequest): Promise<TimeEntry> {
    try {
      const response = await this.client.post<TimeEntry>('/time-entries', data);
      // API returns full TimeEntry object, so we can return it directly
      return response.data;
    } catch (error: any) {
      // Log detailed error information
      if (error.response) {
        // Try to extract error message from response
        const errorMessage = error.response.data?.message 
          || error.response.data?.error 
          || (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
          || `Request failed with status ${error.response.status}`;
        
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  async pauseTimeEntry(id: string): Promise<TimeEntry> {
    try {
      const response = await this.client.put<TimeEntry>(`/time-entries/${id}/pause`);
      // Validate response
      if (!response.data || !response.data.id) {
        throw new Error('Invalid pause response from server');
      }
      return response.data;
    } catch (error: any) {
      if (error.response) {
        const errorMessage = error.response.data?.message 
          || error.response.data?.error 
          || (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
          || `Request failed with status ${error.response.status}`;
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  async resumeTimeEntry(id: string): Promise<TimeEntry> {
    try {
      const response = await this.client.put<TimeEntry>(`/time-entries/${id}/resume`);
      // Validate response
      if (!response.data || !response.data.id) {
        throw new Error('Invalid resume response from server');
      }
      return response.data;
    } catch (error: any) {
      if (error.response) {
        const errorMessage = error.response.data?.message 
          || error.response.data?.error 
          || (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
          || `Request failed with status ${error.response.status}`;
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  async stopTimeEntry(id: string): Promise<TimeEntry> {
    try {
      const response = await this.client.put<TimeEntry>(`/time-entries/${id}/stop`);
      // Validate response
      if (!response.data || !response.data.id) {
        throw new Error('Invalid stop response from server');
      }
      return response.data;
    } catch (error: any) {
      if (error.response) {
        const errorMessage = error.response.data?.message 
          || error.response.data?.error 
          || (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
          || `Request failed with status ${error.response.status}`;
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  // Screenshots
  async uploadScreenshot(file: File, timeEntryId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    
    try {
      await logger.safeLogToRust(`[API] Starting screenshot upload: file size=${file.size} bytes, timeEntryId=${timeEntryId}`).catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      
      // Convert file to base64
      await logger.safeLogToRust('[API] Converting file to base64...').catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      const base64String = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data:image/png;base64, prefix if present
          const base64 = result.includes(',') ? result.split(',')[1] : result;
          resolve(base64);
        };
        reader.onerror = (error) => {
          logger.error('API', 'FileReader error', error);
          logger.safeLogToRust(`[API] FileReader error: ${error}`).catch((e) => {
            logger.debug('API', 'Failed to log (non-critical)', e);
          });
          reject(error);
        };
        reader.readAsDataURL(file);
      });
      
      await logger.safeLogToRust(`[API] Base64 conversion complete: ${base64String.length} chars`).catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      
      // API expects data:image/jpeg;base64,{base64} format (JPEG for smaller size)
      const imageData = `data:image/jpeg;base64,${base64String}`;
      const payloadSize = imageData.length;
      
      await logger.safeLogToRust(`[API] Payload size: ${payloadSize} chars (${(payloadSize / 1024 / 1024).toFixed(2)} MB)`).catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      
      // Send as JSON
      await logger.safeLogToRust('[API] Sending POST request to /screenshots...').catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      
      const requestStartTime = Date.now();
      await this.client.post('/screenshots', {
        imageData: imageData,
        timeEntryId: timeEntryId,
      }, {
        timeout: 120000, // 120 seconds for very large file uploads
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      
      const requestDuration = Date.now() - requestStartTime;
      await logger.safeLogToRust(`[API] Screenshot uploaded successfully in ${requestDuration}ms`).catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
    } catch (error: any) {
      // Log detailed error information
      const errorDetails = error.response 
        ? `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message || 'Unknown error';
      
      logger.error('API', 'Screenshot upload failed', error);
      await logger.safeLogToRust(`[API] Screenshot upload failed: ${errorDetails}`).catch((e) => {
        logger.debug('API', 'Failed to log (non-critical)', e);
      });
      
      if (error.request) {
        await invoke('log_message', { 
          message: `[API] Request was made but no response received. Request config: ${JSON.stringify({
            url: error.config?.url,
            method: error.config?.method,
            timeout: error.config?.timeout,
          })}` 
        }).catch((e) => {
          logger.debug('API', 'Failed to log (non-critical)', e);
        });
      }
      
      if (error.code) {
        await logger.safeLogToRust(`[API] Error code: ${error.code}`).catch((e) => {
          logger.debug('API', 'Failed to log (non-critical)', e);
        });
      }
      
      throw error;
    }
  }

  async getScreenshots(timeEntryId: string): Promise<Screenshot[]> {
    const response = await this.client.get<Screenshot[]>(`/screenshots/time-entry/${timeEntryId}`);
    return response.data;
  }

  // Heartbeat
  async sendHeartbeat(isActive: boolean): Promise<HeartbeatResponse> {
    const response = await this.client.post<HeartbeatResponse>('/idle/heartbeat', {
      isActive,
    });
    return response.data;
  }

  // URL Activities
  async batchUploadUrlActivities(data: UrlActivityRequest): Promise<BatchUrlActivityResponse> {
    // Validate that we don't exceed the maximum of 100 activities per request
    if (data.activities.length > 100) {
      throw new Error('Maximum 100 activities allowed per batch request');
    }

    if (data.activities.length === 0) {
      throw new Error('At least one activity is required');
    }

    const response = await this.client.post<BatchUrlActivityResponse>('/url-activity/batch', data);
    return response.data;
  }
}

export const api = new ApiClient();

