import {
  VideoMetadata,
  ClipSuggestion,
  RenderJob,
  ProjectData,
  SystemStatus,
} from '../types/index.ts';
import { getSupabaseClient } from './supabaseClient.ts';

const TOKEN_KEY = 'clipgenius_owner_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getAuthHeaders(): HeadersInit {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Safe native fetch wrapper: invokes native browser fetch without overriding global properties
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchFn = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : globalThis.fetch;
  return fetchFn(input, init);
}

export const api = {
  // System Health
  async getSystemStatus(): Promise<SystemStatus> {
    const token = getStoredToken();
    const res = await safeFetch('/api/system/status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Failed to fetch system status');
    return res.json();
  },

  // Owner Auth
  async loginOwner(passcode: string): Promise<{ success: boolean; token: string }> {
    const res = await safeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setStoredToken(data.token);
    return data;
  },

  async logoutOwner(): Promise<void> {
    const token = getStoredToken();
    if (token) {
      await safeFetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearStoredToken();
  },

  async checkAuth(): Promise<boolean> {
    const token = getStoredToken();
    if (!token) return false;
    try {
      const res = await safeFetch('/api/auth/check', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      return Boolean(data.authenticated);
    } catch {
      return false;
    }
  },

  async changePasscode(oldPasscode: string, newPasscode: string): Promise<void> {
    const res = await safeFetch('/api/auth/passcode', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ oldPasscode, newPasscode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update passcode');
  },

  // Video Upload
  async uploadVideo(file: File): Promise<{ video: VideoMetadata; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('video', file);

    const token = getStoredToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await safeFetch('/api/videos/upload', {
      method: 'POST',
      headers,
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to upload video');
    return data;
  },

  // Load Demonstration Sample Video
  async loadSampleVideo(sampleType: 'podcast' | 'keynote' | 'gaming' = 'podcast'): Promise<{
    video: VideoMetadata;
    thumbnailUrl: string;
  }> {
    const res = await safeFetch('/api/videos/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleType }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load sample video');
    return data;
  },

  // AI Clip Analysis
  async analyzeVideo(params: {
    videoId: string;
    clipCount?: number;
    clipStyle?: string;
    customPrompt?: string;
    transcript?: string;
  }): Promise<{ clips: ClipSuggestion[]; sourceVideo: VideoMetadata }> {
    const res = await safeFetch('/api/ai/analyze', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI analysis failed');
    return data;
  },

  // FFmpeg Clip Rendering
  async renderClip(params: {
    sourceVideoId: string;
    clipId: string;
    title: string;
    startTime: number;
    endTime: number;
    aspectRatio: '9:16' | '1:1' | '16:9';
  }): Promise<RenderJob> {
    const res = await safeFetch('/api/clips/render', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start render');
    return data.job;
  },

  // Check Render Job Status
  async getRenderJobStatus(jobId: string): Promise<RenderJob> {
    const res = await safeFetch(`/api/clips/status/${jobId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Job not found');
    return data.job;
  },

  // Projects & Supabase
  async getProjects(): Promise<ProjectData[]> {
    const res = await safeFetch('/api/projects');
    const data = await res.json();
    return data.projects || [];
  },

  async saveProject(project: ProjectData): Promise<ProjectData> {
    const res = await safeFetch('/api/projects', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(project),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save project');
    return data.project;
  },

  async getDatabaseStatus(): Promise<{
    isConfigured: boolean;
    url: string;
    hasServiceKey: boolean;
    schemaSql: string;
  }> {
    const res = await safeFetch('/api/database/status');
    return res.json();
  },

  // Resource Management & Storage
  async getSystemResources(): Promise<import('../types/index.ts').SystemResourceInfo> {
    const res = await safeFetch('/api/system/resources');
    if (!res.ok) throw new Error('Failed to fetch system resources');
    return res.json();
  },

  async getStorageInfo(): Promise<import('../types/index.ts').StorageArchitectureInfo> {
    const res = await safeFetch('/api/storage/info');
    if (!res.ok) throw new Error('Failed to fetch storage info');
    return res.json();
  },

  async getUploadStatus(uploadId: string): Promise<import('../types/index.ts').ResumableUploadSession> {
    const res = await safeFetch(`/api/upload/status/${uploadId}`);
    if (!res.ok) throw new Error('Failed to fetch upload status');
    return res.json();
  },

  async cancelUpload(uploadId: string): Promise<void> {
    await safeFetch(`/api/upload/cancel/${uploadId}`, { method: 'DELETE' });
  },

  // Client-side Supabase instance (configured with non-mutating native fetch wrapper)
  getClientSupabase() {
    return getSupabaseClient();
  },
};


