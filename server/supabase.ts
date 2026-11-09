import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { ProjectData, RenderJob, VideoMetadata } from '../src/types/index.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LOCAL_DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory + local file backup storage
interface LocalDatabase {
  projects: ProjectData[];
  renderedClips: RenderJob[];
}

function loadLocalDb(): LocalDatabase {
  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading local db:', err);
  }
  return { projects: [], renderedClips: [] };
}

function saveLocalDb(db: LocalDatabase) {
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing local db:', err);
  }
}

let supabaseClient: SupabaseClient | null = null;

// Initialize Supabase if environment variables are provided
export function initSupabase(): { isConnected: boolean; url?: string } {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  // Use Service Role Key if available on server, or fall back to Anon key
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (url && key && !url.includes('xyzcompany') && !key.includes('eyJhbGciOi...')) {
    try {
      supabaseClient = createClient(url, key, {
        auth: {
          persistSession: false,
        },
        global: {
          // Supported fetch implementation: use native fetch wrapper without mutating global properties
          fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        },
      });
      console.log('Supabase client initialized with endpoint:', url);
      return { isConnected: true, url };
    } catch (err) {
      console.error('Failed to initialize Supabase client:', err);
      supabaseClient = null;
      return { isConnected: false };
    }
  }

  return { isConnected: false };
}

// Initialize on module load
initSupabase();

export function getSupabaseStatus(): {
  isConfigured: boolean;
  url: string;
  hasServiceKey: boolean;
} {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const isReal = Boolean(url && key && !url.includes('xyzcompany') && !key.includes('...'));

  return {
    isConfigured: isReal,
    url: isReal ? url : '',
    hasServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

/**
 * SQL Schema script to create Supabase tables
 */
export const SUPABASE_SCHEMA_SQL = `
-- ClipGenius AI Schema for Supabase PostgreSQL
CREATE TABLE IF NOT EXISTS clipgenius_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_video JSONB,
  clips JSONB DEFAULT '[]'::jsonb,
  render_jobs JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clipgenius_rendered_clips (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  clip_id TEXT,
  title TEXT NOT NULL,
  source_video_id TEXT,
  start_time NUMERIC,
  end_time NUMERIC,
  aspect_ratio TEXT,
  status TEXT,
  progress INTEGER DEFAULT 0,
  output_filename TEXT,
  download_url TEXT,
  file_size BIGINT,
  duration NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
`;

/**
 * Save project data to Supabase (with fallback to local storage)
 */
export async function saveProject(project: ProjectData): Promise<ProjectData> {
  const localDb = loadLocalDb();
  const existingIdx = localDb.projects.findIndex((p) => p.id === project.id);
  if (existingIdx >= 0) {
    localDb.projects[existingIdx] = project;
  } else {
    localDb.projects.unshift(project);
  }
  saveLocalDb(localDb);

  // If Supabase is active, persist to remote PostgreSQL
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from('clipgenius_projects')
        .upsert({
          id: project.id,
          title: project.title,
          source_video: project.sourceVideo,
          clips: project.clips,
          render_jobs: project.renderJobs,
          updated_at: new Date().toISOString(),
        });
      if (error) {
        console.warn('Supabase upsert warning (stored locally):', error.message);
      }
    } catch (err) {
      console.warn('Supabase sync error (using local fallback):', err);
    }
  }

  return project;
}

/**
 * Retrieve all projects
 */
export async function getProjects(): Promise<ProjectData[]> {
  const localDb = loadLocalDb();

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('clipgenius_projects')
        .select('*')
        .order('updated_at', { ascending: false });

      if (!error && data && data.length > 0) {
        return data.map((row) => ({
          id: row.id,
          title: row.title,
          sourceVideo: row.source_video,
          clips: row.clips || [],
          renderJobs: row.render_jobs || [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      }
    } catch (err) {
      console.warn('Failed to query Supabase projects, using local cache:', err);
    }
  }

  return localDb.projects;
}

/**
 * Save a rendered clip job record
 */
export async function saveRenderJobRecord(job: RenderJob): Promise<void> {
  const localDb = loadLocalDb();
  const existingIdx = localDb.renderedClips.findIndex((r) => r.id === job.id);
  if (existingIdx >= 0) {
    localDb.renderedClips[existingIdx] = job;
  } else {
    localDb.renderedClips.unshift(job);
  }
  saveLocalDb(localDb);

  if (supabaseClient) {
    try {
      await supabaseClient.from('clipgenius_rendered_clips').upsert({
        id: job.id,
        clip_id: job.clipId,
        title: job.title,
        source_video_id: job.sourceVideoId,
        start_time: job.startTime,
        end_time: job.endTime,
        aspect_ratio: job.aspectRatio,
        status: job.status,
        progress: job.progress,
        output_filename: job.outputFilename,
        download_url: job.downloadUrl,
        file_size: job.fileSize,
        duration: job.duration,
        completed_at: job.completedAt,
      });
    } catch (err) {
      console.warn('Failed to save render job in Supabase:', err);
    }
  }
}
