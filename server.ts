import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  checkFfmpegAvailability,
  probeVideo,
  generateThumbnail,
  renderClip,
} from './server/ffmpeg.ts';
import { analyzeVideoWithGemini, validateClipTimestampsAndQuote } from './server/gemini.ts';
import { dispatchVideoAnalysis } from './server/aiDispatcher.ts';
import { isOpenRouterConfigured, NEMOTRON_MODEL } from './server/nemotron.ts';
import { scanVideoQualityReport } from './server/contentQualityInspector.ts';
import {
  createSessionToken,
  verifyPasscode,
  verifySessionToken,
  revokeSessionToken,
  getOwnerStatus,
  updatePasscode,
  requireOwnerAuth,
} from './server/auth.ts';
import {
  getSupabaseStatus,
  saveProject,
  getProjects,
  saveRenderJobRecord,
  getRenderJobs,
  savePublishedClip,
  getPublishedClips,
  deletePublishedClip,
  saveVideoRecord,
  getVideos,
  getVideo,
  deleteVideoRecord,
  deleteRenderJob,
  SUPABASE_SCHEMA_SQL,
} from './server/supabase.ts';
import {
  initUploadSession,
  saveChunk,
  assembleUpload,
  getUploadSession,
  cancelUpload,
  cleanupStaleUploads,
  ABSOLUTE_MAX_FILE_SIZE,
} from './server/resumableUpload.ts';
import {
  getSystemResourceInfo,
  checkAvailableDiskSpace,
  enqueueJob,
  getJobStatus,
} from './server/jobQueue.ts';
import { getStorageArchitectureInfo } from './server/storage.ts';
import { VideoMetadata, RenderJob, ProjectData, PublishedClip } from './src/types/index.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Directories for media storage
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const RENDERED_DIR = path.resolve(__dirname, 'rendered');
const THUMBNAILS_DIR = path.resolve(__dirname, 'thumbnails');
const SAMPLES_DIR = path.resolve(__dirname, 'samples');

[UPLOADS_DIR, RENDERED_DIR, THUMBNAILS_DIR, SAMPLES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure Multer storage for uploaded video files
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    // Single-shot upload limit (for files larger than this, use resumable chunked upload)
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB max for legacy single-shot POST
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video file format. Supported: MP4, MOV, WebM, MKV'));
    }
  },
});

// In-memory registries + active downloads tracker
const videosRegistry = new Map<string, VideoMetadata>();
const renderJobsRegistry = new Map<string, RenderJob>();
const activeDownloadCounts = new Map<string, number>();

// Auto-recovery & persistence initialization
async function initRegistries() {
  try {
    const savedVideos = await getVideos();
    for (const v of savedVideos) {
      if (fs.existsSync(v.filepath)) {
        videosRegistry.set(v.id, v);
      }
    }

    const dirs = [
      { dir: UPLOADS_DIR, prefix: 'vid' },
      { dir: SAMPLES_DIR, prefix: 'sample' },
    ];

    for (const { dir, prefix } of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.mp4') && !file.endsWith('.mov') && !file.endsWith('.webm') && !file.endsWith('.mkv')) continue;
        const filepath = path.join(dir, file);
        if (!fs.statSync(filepath).isFile()) continue;

        const alreadyIndexed = Array.from(videosRegistry.values()).some((v) => v.filepath === filepath);
        if (!alreadyIndexed) {
          try {
            const probe = await probeVideo(filepath);
            const id = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
            const videoMeta: VideoMetadata = {
              id,
              filename: file,
              originalName: file,
              filepath,
              url: `/api/videos/stream/${id}`,
              duration: Math.round(probe.duration * 10) / 10,
              width: probe.width,
              height: probe.height,
              aspectRatio: `${probe.width}:${probe.height}`,
              format: probe.format,
              size: fs.statSync(filepath).size,
              bitrate: probe.bitrate,
              fps: probe.fps,
              hasAudio: probe.hasAudio,
              uploadedAt: new Date(fs.statSync(filepath).mtime).toISOString(),
            };
            videosRegistry.set(id, videoMeta);
            await saveVideoRecord(videoMeta);
            console.log(`[ClipGenius Storage] Recovered video on disk: ${file} (ID: ${id})`);
          } catch (err) {
            console.warn(`[ClipGenius Storage] Could not index ${file}:`, err);
          }
        }
      }
    }
    // Rehydrate persisted render jobs across server restarts
    const savedJobs = await getRenderJobs();
    for (const rawJob of savedJobs) {
      const outputFilename = rawJob.outputFilename || `clip-${rawJob.id}-${(rawJob.aspectRatio || '9:16').replace(':', 'x')}.mp4`;
      const resolvedOutputPath = rawJob.outputPath && path.isAbsolute(rawJob.outputPath)
        ? rawJob.outputPath
        : path.join(RENDERED_DIR, outputFilename);

      const job: RenderJob = {
        ...rawJob,
        outputFilename,
        outputPath: resolvedOutputPath,
        downloadUrl: rawJob.downloadUrl || `/api/clips/download/${rawJob.id}`,
      };

      if (job.status === 'queued' || job.status === 'rendering') {
        job.status = 'failed';
        job.error = 'Server restarted before render completed';
        await saveRenderJobRecord(job);
      } else if (job.status === 'completed' && !fs.existsSync(resolvedOutputPath)) {
        job.status = 'failed';
        job.error = 'Rendered MP4 file missing on disk after restart';
      }

      renderJobsRegistry.set(job.id, job);
    }
  } catch (err) {
    console.warn('[ClipGenius Storage] Registry initialization warning:', err);
  }
}

initRegistries();

// Safety helpers for route ID validation and path traversal prevention
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
function isSafeId(val: string | undefined): val is string {
  return Boolean(val && SAFE_ID_REGEX.test(val));
}

function isPathInsideDir(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use((req, _res, next) => {
  const cookieHeader = req.headers.cookie;
  const parsed: Record<string, string> = {};
  if (cookieHeader) {
    for (const pair of cookieHeader.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = decodeURIComponent(pair.slice(idx + 1).trim());
        parsed[k] = v;
      }
    }
  }
  (req as any).cookies = parsed;
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to get auth token from Bearer header or session cookie
function getBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7);
  }
  const cookieToken = (req as any).cookies?.session_token;
  return typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : undefined;
}

// -------------------------------------------------------------
// API: AUTHENTICATION
// -------------------------------------------------------------
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { passcode } = req.body;
  if (!passcode) {
    return res.status(400).json({ error: 'Passcode is required' });
  }

  if (verifyPasscode(passcode)) {
    const token = createSessionToken();
    const isHttps =
      req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.cookie('session_token', token, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
    return res.json({
      success: true,
      token,
      message: 'Owner authenticated successfully',
    });
  }

  return res.status(401).json({ error: 'Invalid owner passcode' });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (token) {
    revokeSessionToken(token);
  }
  const isHttps =
    req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.clearCookie('session_token', {
    path: '/',
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
  });
  return res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/check', (req: Request, res: Response) => {
  return res.json({ authenticated: getOwnerStatus(req) });
});

app.post('/api/auth/passcode', requireOwnerAuth, (req: Request, res: Response) => {
  const { oldPasscode, newPasscode } = req.body;
  if (!newPasscode || newPasscode.length < 6) {
    return res.status(400).json({ error: 'New passcode must be at least 6 characters' });
  }

  const updated = updatePasscode(oldPasscode, newPasscode);
  if (updated) {
    return res.json({ success: true, message: 'Passcode changed successfully' });
  }
  return res.status(400).json({ error: 'Incorrect existing passcode' });
});

// -------------------------------------------------------------
// API: SYSTEM HEALTH, RESOURCE LIMITS & STORAGE ARCHITECTURE
// -------------------------------------------------------------
app.get('/api/system/status', async (req: Request, res: Response) => {
  const ffmpegStatus = await checkFfmpegAvailability();
  const supabase = getSupabaseStatus();

  const openRouterConfigured = isOpenRouterConfigured();
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  let activeAiProvider: 'nemotron' | 'gemini' | 'none' = 'none';
  if (openRouterConfigured) activeAiProvider = 'nemotron';
  else if (geminiConfigured) activeAiProvider = 'gemini';

  return res.json({
    ffmpegAvailable: ffmpegStatus.ffmpeg,
    ffprobeAvailable: ffmpegStatus.ffprobe,
    ffmpegVersion: ffmpegStatus.version,
    geminiConfigured,
    openRouterConfigured,
    openRouterModel: NEMOTRON_MODEL,
    activeAiProvider,
    supabaseConnected: supabase.isConfigured,
    supabaseUrl: supabase.url,
    authenticated: getOwnerStatus(req),
    activeUploadsCount: videosRegistry.size,
  });
});

app.get('/api/system/resources', async (_req: Request, res: Response) => {
  try {
    const resources = await getSystemResourceInfo();
    return res.json(resources);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/storage/info', (_req: Request, res: Response) => {
  try {
    const storageInfo = getStorageArchitectureInfo();
    return res.json(storageInfo);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/database/status', (_req: Request, res: Response) => {
  const status = getSupabaseStatus();
  return res.json({
    ...status,
    schemaSql: SUPABASE_SCHEMA_SQL,
  });
});

// -------------------------------------------------------------
// API: RESUMABLE CHUNKED UPLOAD PROTOCOL (UP TO 20 GB)
// -------------------------------------------------------------

// Initialize a new resumable upload session
app.post('/api/upload/init', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { filename, totalSize, chunkSize, mimeType } = req.body;

    if (!filename || typeof totalSize !== 'number') {
      return res.status(400).json({ error: 'filename and totalSize are required' });
    }

    const result = await initUploadSession({
      filename,
      totalSize,
      chunkSize: chunkSize || 10 * 1024 * 1024, // default 10MB chunk
      mimeType,
    });

    return res.status(201).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Upload init error:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

// Receive a chunk stream directly into disk without buffering in RAM
app.post('/api/upload/chunk', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const uploadId = req.headers['x-upload-id'] as string;
    const chunkIndexStr = req.headers['x-chunk-index'] as string;
    const chunkSizeStr = req.headers['x-chunk-size'] as string;

    if (!uploadId || chunkIndexStr === undefined) {
      return res.status(400).json({ error: 'Missing x-upload-id or x-chunk-index header' });
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    const expectedSize = parseInt(chunkSizeStr || '0', 10);

    const result = await saveChunk({
      uploadId,
      chunkIndex,
      chunkStream: req,
      expectedSize,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Query upload status to resume interrupted upload
app.get('/api/upload/status/:uploadId', requireOwnerAuth, (req: Request, res: Response) => {
  const { uploadId } = req.params;
  if (!isSafeId(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }
  const session = getUploadSession(uploadId);

  if (!session) {
    return res.status(404).json({ error: 'Upload session not found or expired' });
  }

  return res.json({
    uploadId: session.uploadId,
    filename: session.filename,
    totalSize: session.totalSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks,
    receivedBytes: session.receivedBytes,
    status: session.status,
  });
});

// Assemble all chunks into final video file and probe with FFprobe
app.post('/api/upload/complete', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId is required' });
    }

    const session = getUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // Assemble file via streaming (0 RAM overhead)
    const finalPath = await assembleUpload(uploadId);
    const videoId = `vid-${Date.now()}`;

    // Probe the assembled video with FFprobe
    const probe = await probeVideo(finalPath);

    // Generate thumbnail
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    const thumbSec = Math.min(5, Math.max(0.5, probe.duration * 0.05));
    await generateThumbnail(finalPath, thumbPath, thumbSec).catch(() => {});

    const stat = fs.statSync(finalPath);

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename: path.basename(finalPath),
      originalName: session.filename,
      filepath: finalPath,
      url: `/api/videos/stream/${videoId}`,
      duration: Math.round(probe.duration * 10) / 10,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: probe.format,
      size: stat.size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    await saveVideoRecord(videoMeta);

    return res.status(200).json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Upload complete error:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Cancel and remove partially uploaded chunks
app.delete('/api/upload/cancel/:uploadId', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.params;
    if (!isSafeId(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }
    await cancelUpload(uploadId);
    return res.json({ success: true, message: 'Upload cancelled and chunks cleared' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: VIDEO UPLOAD & SOURCE MANAGEMENT
// -------------------------------------------------------------
app.post('/api/videos/upload', requireOwnerAuth, upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const filepath = req.file.path;
    const filename = req.file.filename;
    const videoId = `vid-${Date.now()}`;

    // Probe video with ffprobe
    const probe = await probeVideo(filepath);

    // Generate thumbnail
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    const thumbSec = Math.min(2, Math.max(0.5, probe.duration * 0.1));
    await generateThumbnail(filepath, thumbPath, thumbSec);

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename,
      originalName: req.file.originalname,
      filepath,
      url: `/api/videos/stream/${videoId}`,
      duration: Math.round(probe.duration * 10) / 10,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: probe.format,
      size: req.file.size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    await saveVideoRecord(videoMeta);

    return res.status(201).json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Video upload error:', error);
    return res.status(500).json({
      error: `Failed to process video: ${(error as Error).message}`,
    });
  }
});

// Generate or load real demonstration sample videos
app.post('/api/videos/sample', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { sampleType = 'podcast' } = req.body;
    const normType = sampleType === 'glitch' ? 'technical_glitch' : sampleType;
    const videoId = `sample-${normType}-${Date.now()}`;
    const filename = `${videoId}.mp4`;
    const filepath = path.join(SAMPLES_DIR, filename);

    let title = 'Podcast Masterclass: Building Tech in 2026';
    let duration = 65;

    const { spawn } = await import('child_process');

    async function runFfmpegCmd(args: string[]): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args);
        let stderr = '';
        child.stderr?.on('data', (d) => {
          stderr += d.toString();
          if (stderr.length > 10000) stderr = stderr.slice(-8000);
        });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
        });
        child.on('error', reject);
      });
    }

    if (normType === 'technical_glitch') {
      title = 'Broadcast Stream: SMPTE Test Pattern, Blackout & Keynote';
      duration = 65; // 15s SMPTE bars + 5s black + 45s keynote speech

      const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const fontReg = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

      const filterComplex = [
        `[0:v]drawtext=fontfile=${fontBold}:text='SMPTE COLOR BARS CALIBRATION (LOW-VALUE)':x=80:y=80:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.7,drawtext=fontfile=${fontReg}:text='Status\\: Pre-broadcast test signal (00\\:00 - 00\\:15)':x=80:y=150:fontsize=32:fontcolor=yellow:box=1:boxcolor=black@0.7[v0]`,
        `[2:v]drawtext=fontfile=${fontBold}:text='BLACK SCREEN (TECHNICAL INTERRUPTION)':x=80:y=80:fontsize=44:fontcolor=gray:box=1:boxcolor=black@0.7,drawtext=fontfile=${fontReg}:text='Status\\: No signal / blank transition (00\\:15 - 00\\:20)':x=80:y=150:fontsize=32:fontcolor=gray:box=1:boxcolor=black@0.7[v1]`,
        `[4:v]drawtext=fontfile=${fontBold}:text='KEYNOTE SPEECH\\: AI TRANSFORMATION (HIGH-VALUE)':x=80:y=80:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.7,drawtext=fontfile=${fontReg}:text='Speaker\\: The future belongs to creators who master curation.':x=80:y=150:fontsize=32:fontcolor=yellow:box=1:boxcolor=black@0.7,drawtext=fontfile=${fontReg}:text='Time\\: %{pts\\:hms}':x=80:y=220:fontsize=28:fontcolor=cyan:box=1:boxcolor=black@0.7[v2]`,
        `[v0][1:a][v1][3:a][v2][5:a]concat=n=3:v=1:a=1[v][a]`,
      ].join(';');

      const ffmpegCmd = [
        '-f', 'lavfi', '-i', 'smptebars=duration=15:size=1920x1080:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=15',
        '-f', 'lavfi', '-i', 'color=c=black:size=1920x1080:duration=5:rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=5',
        '-f', 'lavfi', '-i', 'color=c=#1e1b4b:size=1920x1080:duration=45:rate=30',
        '-f', 'lavfi', '-i', 'aevalsrc=sin(260*2*PI*t)*0.25+sin(520*2*PI*t)*0.15:d=45',
        '-filter_complex', filterComplex,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', filepath,
      ];

      await runFfmpegCmd(ffmpegCmd);
    } else if (normType === 'educational' || normType === 'keynote') {
      title = 'Educational Documentary: System Design at Scale';
      duration = 80;

      const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const fontReg = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

      const vf = [
        `drawtext=fontfile=${fontBold}:text='DOCUMENTARY\\: SYSTEM DESIGN AT SCALE':x=80:y=80:fontsize=46:fontcolor=white:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Chapter\\: Resumable Ingestion & Concurrency Guardrails':x=80:y=150:fontsize=32:fontcolor=cyan:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Insight\\: True scalability means zero dropped jobs during load spikes.':x=80:y=220:fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Timecode\\: %{pts\\:hms}':x=80:y=290:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6`,
      ].join(',');

      const ffmpegCmd = [
        '-f', 'lavfi', '-i', `color=c=#0a192f:size=1920x1080:duration=${duration}:rate=30`,
        '-f', 'lavfi', '-i', `aevalsrc=sin(330*2*PI*t)*0.2+sin(550*2*PI*t)*0.1:d=${duration}`,
        '-vf', vf,
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', filepath,
      ];

      await runFfmpegCmd(ffmpegCmd);
    } else {
      // Default: Podcast / Interview Masterclass
      title = 'Podcast Masterclass: Building Tech in 2026';
      duration = 65;

      const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
      const fontReg = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

      const vf = [
        `drawtext=fontfile=${fontBold}:text='TECH LEADERS PODCAST #42':x=80:y=80:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Host\\: What separates viral clips from forgettable clips?':x=80:y=150:fontsize=32:fontcolor=yellow:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Guest\\: Curiosity gaps, punchy payoffs, and clean sound.':x=80:y=220:fontsize=32:fontcolor=cyan:box=1:boxcolor=black@0.6`,
        `drawtext=fontfile=${fontReg}:text='Timecode\\: %{pts\\:hms}':x=80:y=290:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6`,
      ].join(',');

      const ffmpegCmd = [
        '-f', 'lavfi', '-i', `color=c=#0f172a:size=1920x1080:duration=${duration}:rate=30`,
        '-f', 'lavfi', '-i', `aevalsrc=sin(220*2*PI*t)*0.25+sin(440*2*PI*t)*0.15:d=${duration}`,
        '-vf', vf,
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', filepath,
      ];

      await runFfmpegCmd(ffmpegCmd);
    }

    const probe = await probeVideo(filepath);
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    await generateThumbnail(filepath, thumbPath, 2);

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename,
      originalName: `${title}.mp4`,
      filepath,
      url: `/api/videos/stream/${videoId}`,
      duration: Math.round(probe.duration * 10) / 10,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: 'mp4',
      size: fs.statSync(filepath).size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: true,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    await saveVideoRecord(videoMeta);

    return res.json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Failed to generate sample video:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// List all registered videos (persisted across restarts)
app.get('/api/videos', requireOwnerAuth, (_req: Request, res: Response) => {
  return res.json({
    success: true,
    videos: Array.from(videosRegistry.values()),
  });
});

// Get single video metadata
app.get('/api/videos/item/:id', requireOwnerAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isSafeId(id)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  let video = videosRegistry.get(id);
  if (!video) {
    const saved = await getVideo(id);
    if (saved && fs.existsSync(saved.filepath)) {
      video = saved;
      videosRegistry.set(id, saved);
    }
  }

  if (!video) {
    return res.status(404).json({ error: 'Video not found in persistent registry' });
  }

  return res.json({ success: true, video });
});

// Delete a source video
app.delete('/api/videos/:id', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isSafeId(id)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }
    const video = videosRegistry.get(id);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (video.filepath && fs.existsSync(video.filepath) && (isPathInsideDir(UPLOADS_DIR, video.filepath) || isPathInsideDir(SAMPLES_DIR, video.filepath))) {
      try {
        fs.unlinkSync(video.filepath);
      } catch (err) {
        console.warn(`Could not delete file ${video.filepath}:`, err);
      }
    }

    videosRegistry.delete(id);
    await deleteVideoRecord(id);

    return res.json({ success: true, message: 'Video deleted from registry and disk' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Stream video HEAD request for fast player metadata probing
app.head('/api/videos/stream/:id', requireOwnerAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isSafeId(id)) {
    return res.status(400).end();
  }
  let video = videosRegistry.get(id);
  let filepath = video?.filepath;

  if (!filepath || !fs.existsSync(filepath)) {
    const saved = await getVideo(id);
    if (saved && fs.existsSync(saved.filepath)) {
      filepath = saved.filepath;
      videosRegistry.set(id, saved);
    }
  }

  if (!filepath || !fs.existsSync(filepath)) {
    const potentialPaths = [
      path.join(UPLOADS_DIR, `${id}.mp4`),
      path.join(SAMPLES_DIR, `${id}.mp4`),
    ];
    filepath = potentialPaths.find((p) => fs.existsSync(p));
  }

  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).end();
  }

  const stat = fs.statSync(filepath);
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  });
  res.end();
});

// Stream video with robust HTTP 206 partial content and HTTP 416 range validation
app.get('/api/videos/stream/:id', requireOwnerAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isSafeId(id)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }
  let video = videosRegistry.get(id);
  let filepath = video?.filepath;

  if (!filepath || !fs.existsSync(filepath)) {
    const saved = await getVideo(id);
    if (saved && fs.existsSync(saved.filepath)) {
      filepath = saved.filepath;
      videosRegistry.set(id, saved);
    }
  }

  if (!filepath || !fs.existsSync(filepath)) {
    // Check if directly in uploads or samples
    const potentialPaths = [
      path.join(UPLOADS_DIR, `${id}.mp4`),
      path.join(SAMPLES_DIR, `${id}.mp4`),
    ];
    filepath = potentialPaths.find((p) => fs.existsSync(p));
  }

  if (!filepath || !fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Video file not found or still synchronizing' });
  }

  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // HTTP 416 Range Not Satisfiable check
    if (isNaN(start) || start < 0 || start >= fileSize || (parts[1] && (isNaN(end) || end >= fileSize || start > end))) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunksize = end - start + 1;
    const file = fs.createReadStream(filepath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    const file = fs.createReadStream(filepath);
    file.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    file.pipe(res);
  }
});

// Serve thumbnail images
app.get('/api/thumbnails/:id', requireOwnerAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  if (!isSafeId(id)) {
    return res.status(400).send('Invalid thumbnail ID');
  }
  const thumbPath = path.join(THUMBNAILS_DIR, `thumb-${id}.jpg`);

  if (isPathInsideDir(THUMBNAILS_DIR, thumbPath) && fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  }

  return res.status(404).send('Thumbnail not found');
});

// Generate and serve instantaneous clip thumbnail at specific timestamp
app.get('/api/thumbnails/clip/:sourceVideoId', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { sourceVideoId } = req.params;
    if (!isSafeId(sourceVideoId)) {
      return res.status(400).send('Invalid video ID');
    }
    const timestampSec = Math.max(0, parseFloat(req.query.t as string) || 0);

    const video = videosRegistry.get(sourceVideoId);
    let filepath = video?.filepath;
    if (!filepath || !fs.existsSync(filepath)) {
      const potentialPaths = [
        path.join(UPLOADS_DIR, `${sourceVideoId}.mp4`),
        path.join(SAMPLES_DIR, `${sourceVideoId}.mp4`),
      ];
      filepath = potentialPaths.find((p) => fs.existsSync(p));
    }

    if (!filepath || !fs.existsSync(filepath)) {
      return res.status(404).send('Source video not found');
    }

    const thumbKey = `clip-${sourceVideoId}-${Math.round(timestampSec * 10)}`;
    const thumbPath = path.join(THUMBNAILS_DIR, `${thumbKey}.jpg`);

    if (!fs.existsSync(thumbPath)) {
      await generateThumbnail(filepath, thumbPath, timestampSec);
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    return res.status(500).send(`Failed to extract clip thumbnail: ${(err as Error).message}`);
  }
});

// -------------------------------------------------------------
// API: AI CLIP ANALYSIS (NVIDIA NEMOTRON 3.5 SUPER VL + GEMINI FALLBACK)
// -------------------------------------------------------------
const AI_LIFECYCLE_LOG_PATH = '/tmp/clipgenius_ai_analyze.log';

function logAiLifecycle(event: string, requestId: string, details: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    requestId,
    ...details,
  };
  const line = `[AI Lifecycle] ${JSON.stringify(entry)}`;
  if (event.includes('ERROR') || event.includes('ABORTED') || event.includes('CLOSED')) {
    console.error(line);
  } else {
    console.log(line);
  }
  try {
    fs.appendFileSync(AI_LIFECYCLE_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Non-fatal diagnostic file append
  }
}

app.post(['/api/ai/analyze', '/api/analyze'], requireOwnerAuth, async (req: Request, res: Response) => {
  const reqId = `ai-${Date.now()}-${Math.round(Math.random() * 1000)}`;
  const reqStartMs = Date.now();
  let clientAborted = false;

  const {
    videoId,
    preferredProvider = 'auto_fallback',
    clipCount = 3,
    clipStyle = 'viral_shorts',
    editorialStyle,
    customPrompt,
    creatorDirection,
    transcript,
    videoCategory,
    targetAudience,
    targetPlatforms,
    chunkName,
    chunkOffsetSeconds,
    previouslySelectedClips,
    privacyConsent,
  } = req.body;

  const effectiveStyle = editorialStyle || clipStyle;
  const effectiveDirection = creatorDirection || customPrompt;

  logAiLifecycle('REQUEST_START', reqId, {
    route: req.path,
    videoId,
    preferredProvider,
    editorialStyle: effectiveStyle,
    clipCount: Number(clipCount) || 3,
  });

  req.on('aborted', () => {
    clientAborted = true;
    logAiLifecycle('CLIENT_ABORTED', reqId, {
      route: req.path,
      elapsedMs: Date.now() - reqStartMs,
      headersSent: res.headersSent,
    });
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      logAiLifecycle('SOCKET_CLOSED_BEFORE_FINISH', reqId, {
        route: req.path,
        elapsedMs: Date.now() - reqStartMs,
        headersSent: res.headersSent,
        clientAborted,
      });
    }
  });

  res.on('finish', () => {
    logAiLifecycle('RESPONSE_FINISHED', reqId, {
      route: req.path,
      statusCode: res.statusCode,
      elapsedMs: Date.now() - reqStartMs,
    });
  });

  try {
    const video = videosRegistry.get(videoId);
    if (!video || !fs.existsSync(video.filepath)) {
      logAiLifecycle('VIDEO_NOT_FOUND', reqId, { videoId, statusCode: 404 });
      return res.status(404).json({ error: 'Source video not found on disk' });
    }

    const result = await dispatchVideoAnalysis({
      preferredProvider,
      sourceVideoId: video.id,
      sourcePath: video.filepath,
      filename: video.originalName,
      duration: video.duration,
      clipCount: Number(clipCount) || 3,
      clipStyle: effectiveStyle,
      editorialStyle: effectiveStyle,
      customPrompt: effectiveDirection,
      creatorDirection: effectiveDirection,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName: chunkName || 'chunk_01',
      chunkOffsetSeconds: Number(chunkOffsetSeconds) || 0,
      privacyConsent: privacyConsent !== false,
      previouslySelectedClips: Array.isArray(previouslySelectedClips) ? previouslySelectedClips : [],
    });

    const audit = {
      requestedProvider: result.requestedProvider,
      actualProvider: result.providerUsed,
      actualModel: result.modelUsed,
      fallbackUsed: result.fallbackUsed,
      fallbackReason: result.fallbackReason,
      openRouterDetails: result.openRouterDetails,
      rejectedMoments: result.rejectedMoments || [],
      editorialStyle: result.editorialStyleUsed,
      editorialPolicy: result.editorialPolicy,
      creatorDirection: result.creatorDirectionUsed,
      analyzedAt: new Date().toISOString(),
      jsonParsingStatus: result.openRouterDetails?.jsonParsingStatus,
      repairRetryCount: result.openRouterDetails?.repairRetryCount ?? 0,
      networkRetryCount: result.openRouterDetails?.networkRetryCount ?? 0,
      hasInsufficientContent: result.hasInsufficientContent,
      analysisSummary: result.analysisSummary,
      transcriptVerification: result.transcriptVerification,
      sourceVideoMetadata: result.sourceMetadata || {
        width: video.width,
        height: video.height,
        fps: video.fps,
        format: video.format,
        hasAudio: video.hasAudio,
        bitrate: video.bitrate,
      },
    };

    logAiLifecycle('DISPATCH_SUCCESS', reqId, {
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      fallbackUsed: result.fallbackUsed,
      openRouterRequestId: result.openRouterDetails?.requestId,
      openRouterHttpStatus: result.openRouterDetails?.httpStatus,
      finishReason: result.openRouterDetails?.finishReason,
      networkRetryCount: result.openRouterDetails?.networkRetryCount ?? 0,
      repairRetryCount: result.openRouterDetails?.repairRetryCount ?? 0,
      clipsCount: result.clips.length,
      rejectedCount: result.rejectedMoments?.length ?? 0,
      elapsedMs: Date.now() - reqStartMs,
    });

    return res.json({
      success: true,
      requestId: reqId,
      clips: result.clips,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      fallbackUsed: result.fallbackUsed,
      fallbackReason: result.fallbackReason,
      openRouterDetails: result.openRouterDetails,
      rejectedMoments: result.rejectedMoments,
      editorialStyleUsed: result.editorialStyleUsed,
      editorialPolicy: result.editorialPolicy,
      creatorDirectionUsed: result.creatorDirectionUsed,
      stagesCompleted: result.stagesCompleted,
      hasInsufficientContent: result.hasInsufficientContent,
      analysisSummary: result.analysisSummary,
      transcriptVerification: result.transcriptVerification,
      audit,
      sourceVideo: video,
    });
  } catch (error) {
    const errObj = error as any;
    const errMsg = errObj?.message || String(error);
    const httpStatus =
      errObj?.statusCode === 429 || errMsg.includes('HTTP 429')
        ? 429
        : errObj?.statusCode === 401 || errObj?.statusCode === 403
        ? errObj.statusCode
        : 500;
    logAiLifecycle('DISPATCH_ERROR', reqId, {
      error: errMsg,
      statusCode: httpStatus,
      isDailyQuotaExhausted: Boolean(errObj?.isDailyQuotaExhausted),
      rateLimitResetAt: errObj?.rateLimitResetAt,
      elapsedMs: Date.now() - reqStartMs,
    });
    return res.status(httpStatus).json({
      error: errMsg,
      requestId: reqId,
      isDailyQuotaExhausted: Boolean(errObj?.isDailyQuotaExhausted),
      rateLimitResetAt: errObj?.rateLimitResetAt,
    });
  }
});

// Endpoint to independently validate clip timestamps and quote before render/publish
app.post('/api/clips/validate', requireOwnerAuth, (req: Request, res: Response) => {
  try {
    const { clip, videoDuration, transcript } = req.body;
    if (!clip || typeof videoDuration !== 'number') {
      return res.status(400).json({ error: 'Missing clip object or videoDuration' });
    }

    const validation = validateClipTimestampsAndQuote(clip, videoDuration, transcript);
    return res.json(validation);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: FFMPEG REAL VIDEO RENDERING ENGINE
// -------------------------------------------------------------
app.post('/api/clips/render', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const {
      sourceVideoId,
      clipId,
      title,
      startTime,
      endTime,
      aspectRatio = '9:16',
    } = req.body;

    const video = videosRegistry.get(sourceVideoId);
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).json({ error: 'Source video not found on disk' });
    }

    const rawStart = parseFloat(startTime);
    const rawEnd = parseFloat(endTime);
    if (isNaN(rawStart) || isNaN(rawEnd) || rawStart < 0 || rawEnd <= rawStart || rawStart >= video.duration) {
      return res.status(400).json({
        error: `Invalid clip timestamp range [${startTime}s - ${endTime}s] for source video duration ${video.duration}s`,
      });
    }

    const jobId = `job-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const outputFilename = `clip-${jobId}-${aspectRatio.replace(':', 'x')}.mp4`;
    const outputPath = path.join(RENDERED_DIR, outputFilename);

    const safeStart = Math.max(0, rawStart);
    const safeEnd = Math.min(video.duration, rawEnd);
    const targetDuration = Math.max(0.5, safeEnd - safeStart);

    const renderJob: RenderJob = {
      id: jobId,
      clipId: clipId || jobId,
      title: title || `Viral Clip (${aspectRatio})`,
      sourceVideoId,
      startTime: safeStart,
      endTime: safeEnd,
      aspectRatio: (aspectRatio as '9:16' | '1:1' | '16:9') || '9:16',
      status: 'queued',
      progress: 0,
      outputFilename,
      outputPath,
      downloadUrl: `/api/clips/download/${jobId}`,
      duration: Math.round(targetDuration * 10) / 10,
      createdAt: new Date().toISOString(),
    };

    renderJobsRegistry.set(jobId, renderJob);
    await saveRenderJobRecord(renderJob);

    // Enqueue render task with concurrency & resource protection
    enqueueJob({
      id: jobId,
      type: 'render',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      task: async () => {
        const currentJob = renderJobsRegistry.get(jobId);
        if (currentJob) {
          currentJob.status = 'rendering';
        }

        try {
          await renderClip({
            sourcePath: video.filepath,
            outputPath,
            startTime: safeStart,
            endTime: safeEnd,
            aspectRatio: renderJob.aspectRatio,
            onProgress: (percent) => {
              const job = renderJobsRegistry.get(jobId);
              if (job) {
                job.progress = percent;
              }
            },
          });

          const job = renderJobsRegistry.get(jobId);
          if (job) {
            job.status = 'completed';
            job.progress = 100;
            job.completedAt = new Date().toISOString();
            if (fs.existsSync(outputPath)) {
              job.fileSize = fs.statSync(outputPath).size;
            }
            await saveRenderJobRecord(job);
          }
        } catch (err) {
          console.error('Render error:', err);
          const job = renderJobsRegistry.get(jobId);
          if (job) {
            job.status = 'failed';
            job.error = (err as Error).message;
            await saveRenderJobRecord(job);
          }
          throw err;
        }
      },
    });

    return res.status(202).json({
      success: true,
      job: renderJob,
    });
  } catch (error) {
    console.error('Rendering dispatch failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Atomic batch rendering for multiple clips (never silently skips invalid/missing clips)
app.post('/api/clips/batch-render', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { clips, defaultAspectRatio = '9:16' } = req.body;
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: 'No clips provided for batch rendering' });
    }

    const jobs: RenderJob[] = [];

    for (let idx = 0; idx < clips.length; idx++) {
      const clip = clips[idx];
      const sourceVideoId = clip.sourceVideoId;
      const video = videosRegistry.get(sourceVideoId);
      const jobId = `job-${Date.now()}-${idx}-${Math.round(Math.random() * 10000)}`;
      const clipAspect = (clip.aspectRatio || defaultAspectRatio || '9:16') as '9:16' | '1:1' | '16:9';
      const outputFilename = `clip-${jobId}-${clipAspect.replace(':', 'x')}.mp4`;
      const outputPath = path.join(RENDERED_DIR, outputFilename);

      const rawStart = parseFloat(clip.startTime);
      const rawEnd = parseFloat(clip.endTime);

      // Expose explicit failed job instead of silently skipping broken/missing clips
      if (!video || !fs.existsSync(video.filepath)) {
        const failedJob: RenderJob = {
          id: jobId,
          clipId: clip.clipId || clip.id || jobId,
          title: clip.title || `Viral Clip (${clipAspect})`,
          sourceVideoId: sourceVideoId || 'unknown',
          startTime: isNaN(rawStart) ? 0 : rawStart,
          endTime: isNaN(rawEnd) ? 0 : rawEnd,
          aspectRatio: clipAspect,
          status: 'failed',
          progress: 0,
          outputFilename,
          outputPath,
          downloadUrl: `/api/clips/download/${jobId}`,
          duration: 0,
          error: `Source video "${sourceVideoId}" not found on disk`,
          createdAt: new Date().toISOString(),
        };
        renderJobsRegistry.set(jobId, failedJob);
        await saveRenderJobRecord(failedJob);
        jobs.push(failedJob);
        continue;
      }

      if (isNaN(rawStart) || isNaN(rawEnd) || rawStart < 0 || rawEnd <= rawStart || rawStart >= video.duration) {
        const failedJob: RenderJob = {
          id: jobId,
          clipId: clip.clipId || clip.id || jobId,
          title: clip.title || `Viral Clip (${clipAspect})`,
          sourceVideoId,
          startTime: isNaN(rawStart) ? 0 : rawStart,
          endTime: isNaN(rawEnd) ? 0 : rawEnd,
          aspectRatio: clipAspect,
          status: 'failed',
          progress: 0,
          outputFilename,
          outputPath,
          downloadUrl: `/api/clips/download/${jobId}`,
          duration: 0,
          error: `Invalid timestamp bounds [${clip.startTime}s - ${clip.endTime}s] for source duration ${video.duration}s`,
          createdAt: new Date().toISOString(),
        };
        renderJobsRegistry.set(jobId, failedJob);
        await saveRenderJobRecord(failedJob);
        jobs.push(failedJob);
        continue;
      }

      const safeStart = Math.max(0, rawStart);
      const safeEnd = Math.min(video.duration, rawEnd);
      const targetDuration = Math.max(0.5, safeEnd - safeStart);

      const renderJob: RenderJob = {
        id: jobId,
        clipId: clip.clipId || clip.id || jobId,
        title: clip.title || `Viral Clip (${clipAspect})`,
        sourceVideoId,
        startTime: safeStart,
        endTime: safeEnd,
        aspectRatio: clipAspect,
        status: 'queued',
        progress: 0,
        outputFilename,
        outputPath,
        downloadUrl: `/api/clips/download/${jobId}`,
        duration: Math.round(targetDuration * 10) / 10,
        createdAt: new Date().toISOString(),
      };

      renderJobsRegistry.set(jobId, renderJob);
      await saveRenderJobRecord(renderJob);
      jobs.push(renderJob);

      enqueueJob({
        id: jobId,
        type: 'render',
        status: 'queued',
        progress: 0,
        createdAt: Date.now(),
        task: async () => {
          const currentJob = renderJobsRegistry.get(jobId);
          if (currentJob) {
            currentJob.status = 'rendering';
          }

          try {
            await renderClip({
              sourcePath: video.filepath,
              outputPath,
              startTime: safeStart,
              endTime: safeEnd,
              aspectRatio: renderJob.aspectRatio,
              onProgress: (percent) => {
                const j = renderJobsRegistry.get(jobId);
                if (j) j.progress = percent;
              },
            });

            const j = renderJobsRegistry.get(jobId);
            if (j) {
              j.status = 'completed';
              j.progress = 100;
              j.completedAt = new Date().toISOString();
              if (fs.existsSync(outputPath)) {
                j.fileSize = fs.statSync(outputPath).size;
              }
              await saveRenderJobRecord(j);
            }
          } catch (err) {
            console.error(`Batch render error for job ${jobId}:`, err);
            const j = renderJobsRegistry.get(jobId);
            if (j) {
              j.status = 'failed';
              j.error = (err as Error).message;
              await saveRenderJobRecord(j);
            }
            throw err;
          }
        },
      });
    }

    return res.status(202).json({
      success: true,
      count: jobs.length,
      jobs,
    });
  } catch (error) {
    console.error('Batch rendering dispatch failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// List all persisted and active render jobs
app.get('/api/clips/jobs', requireOwnerAuth, (_req: Request, res: Response) => {
  const jobs = Array.from(renderJobsRegistry.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return res.json({ success: true, jobs });
});

// Retry a failed render job
app.post('/api/clips/retry/:jobId', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    if (!isSafeId(jobId)) {
      return res.status(400).json({ error: 'Invalid jobId' });
    }
    const job = renderJobsRegistry.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Render job not found' });
    }

    const video = videosRegistry.get(job.sourceVideoId);
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).json({ error: 'Source video not found on disk' });
    }

    job.status = 'queued';
    job.progress = 0;
    job.error = undefined;
    await saveRenderJobRecord(job);

    enqueueJob({
      id: jobId,
      type: 'render',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      task: async () => {
        job.status = 'rendering';
        try {
          await renderClip({
            sourcePath: video.filepath,
            outputPath: job.outputPath!,
            startTime: job.startTime,
            endTime: job.endTime,
            aspectRatio: job.aspectRatio,
            onProgress: (percent) => {
              job.progress = percent;
            },
          });

          job.status = 'completed';
          job.progress = 100;
          job.completedAt = new Date().toISOString();
          if (fs.existsSync(job.outputPath!)) {
            job.fileSize = fs.statSync(job.outputPath!).size;
          }
          await saveRenderJobRecord(job);
        } catch (err) {
          job.status = 'failed';
          job.error = (err as Error).message;
          await saveRenderJobRecord(job);
          throw err;
        }
      },
    });

    return res.json({ success: true, message: 'Job re-queued for rendering', job });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Video Content Quality Inspector report
app.get('/api/quality/inspect/:videoId', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    if (!isSafeId(videoId)) {
      return res.status(400).json({ error: 'Invalid videoId' });
    }
    const video = videosRegistry.get(videoId);
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).json({ error: 'Video not found on disk' });
    }

    const report = await scanVideoQualityReport(video.filepath, video.duration);
    return res.json({ success: true, report });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// Check status of a render job
app.get('/api/clips/status/:jobId', requireOwnerAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!isSafeId(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  const job = renderJobsRegistry.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  return res.json({ job });
});

// Download rendered MP4 clip with safe headers, range streaming, and active download tracking
app.get('/api/clips/download/:jobId', requireOwnerAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!isSafeId(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }
  const job = renderJobsRegistry.get(jobId);

  if (!job || !job.outputPath || !isPathInsideDir(RENDERED_DIR, job.outputPath) || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Rendered clip not found or still processing' });
  }

  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const safeTitle = (job.title || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeAspect = (job.aspectRatio || '9x16').replace(':', 'x');
  const safeFilename = `${safeTitle}_${safeAspect}.mp4`;

  const currentCount = activeDownloadCounts.get(jobId) || 0;
  activeDownloadCounts.set(jobId, currentCount + 1);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const prev = activeDownloadCounts.get(jobId) || 0;
    if (prev <= 1) {
      activeDownloadCounts.delete(jobId);
    } else {
      activeDownloadCounts.set(jobId, prev - 1);
    }
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);

  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'private, no-store');

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || start < 0 || start >= fileSize || (parts[1] && (isNaN(end) || end >= fileSize || start > end))) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunksize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunksize);
    const stream = fs.createReadStream(job.outputPath, { start, end });
    stream.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    const stream = fs.createReadStream(job.outputPath);
    stream.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  }
});

// Delete a rendered clip from server without affecting already downloaded files
app.delete('/api/clips/render/:jobId', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    if (!isSafeId(jobId)) {
      return res.status(400).json({ error: 'Invalid jobId' });
    }
    const job = renderJobsRegistry.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Render job not found' });
    }

    if ((activeDownloadCounts.get(jobId) || 0) > 0) {
      return res.status(409).json({ error: 'Cannot delete clip while an active download is in progress' });
    }

    if (job.outputPath && isPathInsideDir(RENDERED_DIR, job.outputPath) && fs.existsSync(job.outputPath)) {
      try {
        fs.unlinkSync(job.outputPath);
      } catch (err) {
        console.warn(`Could not remove rendered file ${job.outputPath}:`, err);
      }
    }

    renderJobsRegistry.delete(jobId);
    await deleteRenderJob(jobId);

    return res.json({ success: true, message: 'Render job and output file removed from server' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// HEAD request for rendered MP4 stream probing
app.head('/api/clips/stream/:jobId', requireOwnerAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!isSafeId(jobId)) {
    return res.status(400).end();
  }
  const job = renderJobsRegistry.get(jobId);

  if (!job || !job.outputPath || !isPathInsideDir(RENDERED_DIR, job.outputPath) || !fs.existsSync(job.outputPath)) {
    return res.status(404).end();
  }

  const stat = fs.statSync(job.outputPath);
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  });
  res.end();
});

// Stream rendered MP4 clip for in-browser playback with full HTTP 206 & 416 handling
app.get('/api/clips/stream/:jobId', requireOwnerAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!isSafeId(jobId)) {
    return res.status(400).send('Invalid jobId');
  }
  const job = renderJobsRegistry.get(jobId);

  if (!job || !job.outputPath || !isPathInsideDir(RENDERED_DIR, job.outputPath) || !fs.existsSync(job.outputPath)) {
    return res.status(404).send('Rendered clip not found');
  }

  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || start < 0 || start >= fileSize || (parts[1] && (isNaN(end) || end >= fileSize || start > end))) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunksize = end - start + 1;
    const file = fs.createReadStream(job.outputPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    const file = fs.createReadStream(job.outputPath);
    file.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    file.pipe(res);
  }
});

// -------------------------------------------------------------
// API: INDIVIDUAL CLIP PUBLISHING WORKFLOW & SUPABASE SYNC
// -------------------------------------------------------------

// Publish an individual reviewed clip
app.post('/api/clips/publish', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const {
      clipId,
      projectId,
      title,
      hook,
      platform = 'tiktok',
      postCaption,
      hashtags = [],
      videoUrl,
      downloadUrl,
      renderJobId,
      scheduledFor,
    } = req.body;

    if (!clipId || !title || !hook) {
      return res.status(400).json({ error: 'Missing required clip publishing fields (clipId, title, hook)' });
    }

    const publishedRecord: PublishedClip = {
      id: `pub-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      clipId,
      projectId: projectId || undefined,
      title,
      hook,
      platform: platform as any,
      postCaption: postCaption || `${title}\n\n"${hook}"\n\n${(hashtags || []).join(' ')}`,
      hashtags: Array.isArray(hashtags) ? hashtags : ['#viral', '#shorts', '#trending'],
      videoUrl: videoUrl || (renderJobId ? `/api/clips/stream/${renderJobId}` : undefined),
      downloadUrl: downloadUrl || (renderJobId ? `/api/clips/download/${renderJobId}` : undefined),
      renderJobId: renderJobId || undefined,
      publishedAt: new Date().toISOString(),
      status: scheduledFor ? 'scheduled' : 'published',
      scheduledFor: scheduledFor || undefined,
    };

    const saved = await savePublishedClip(publishedRecord);

    return res.status(201).json({
      success: true,
      publishedClip: saved,
      message: `Clip "${title}" successfully published for ${platform.toUpperCase()}`,
    });
  } catch (error) {
    console.error('Failed to publish clip:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Retrieve all individually published clips
app.get('/api/clips/published', requireOwnerAuth, async (_req: Request, res: Response) => {
  try {
    const published = await getPublishedClips();
    return res.json({ published });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Remove/unpublish a published clip record
app.delete('/api/clips/publish/:id', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!isSafeId(id)) {
      return res.status(400).json({ error: 'Invalid published clip ID' });
    }
    await deletePublishedClip(id);
    return res.json({ success: true, message: 'Published clip record removed' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: PROJECTS STORAGE & SUPABASE SYNC
// -------------------------------------------------------------
app.get('/api/projects', requireOwnerAuth, async (_req: Request, res: Response) => {
  try {
    const projects = await getProjects();
    return res.json({ projects });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/projects', requireOwnerAuth, async (req: Request, res: Response) => {
  try {
    const projectData = req.body as ProjectData;
    if (!projectData || !projectData.id) {
      return res.status(400).json({ error: 'Invalid project data' });
    }

    const saved = await saveProject(projectData);
    return res.json({ success: true, project: saved });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// STRICT API 404 HANDLER (PREVENT VITE SPA HTML FALLBACK)
// -------------------------------------------------------------
app.all('/api/*', (req: Request, res: Response) => {
  return res.status(404).json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    status: 404,
  });
});

// -------------------------------------------------------------
// VITE DEV SERVER OR PRODUCTION STATIC SERVING
// -------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await initRegistries();

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClipGenius AI] Full-Stack server running on port ${PORT}`);
    console.log(`[ClipGenius AI] Mode: ${isProd ? 'Production' : 'Development'}`);
  });

  // Match Node HTTP server timeouts to long-running AI analysis & Cloud Run 300s request ceiling
  httpServer.timeout = 0; // Keep active sockets open while awaiting upstream AI/FFmpeg
  httpServer.requestTimeout = 300000; // 300s total request budget
  httpServer.keepAliveTimeout = 61000; // Prevent 5s idle socket close races behind proxies
  httpServer.headersTimeout = 65000; // Must exceed keepAliveTimeout

  httpServer.on('clientError', (err, socket) => {
    logAiLifecycle('HTTP_CLIENT_ERROR', 'server', {
      message: err.message,
      code: (err as NodeJS.ErrnoException).code,
    });
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
