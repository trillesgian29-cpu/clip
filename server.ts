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
import {
  createSessionToken,
  verifyPasscode,
  verifySessionToken,
  revokeSessionToken,
  getOwnerStatus,
  updatePasscode,
} from './server/auth.ts';
import {
  getSupabaseStatus,
  saveProject,
  getProjects,
  saveRenderJobRecord,
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
const activeDownloads = new Set<string>();

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
  } catch (err) {
    console.warn('[ClipGenius Storage] Registry initialization warning:', err);
  }
}

initRegistries();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to get auth token
function getBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7);
  }
  return undefined;
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
  return res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/check', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  const isValid = verifySessionToken(token);
  return res.json({ authenticated: isValid });
});

app.post('/api/auth/passcode', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!verifySessionToken(token)) {
    return res.status(401).json({ error: 'Owner authentication required' });
  }

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
  const token = getBearerToken(req);
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
    authenticated: verifySessionToken(token),
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
app.post('/api/upload/init', async (req: Request, res: Response) => {
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
app.post('/api/upload/chunk', async (req: Request, res: Response) => {
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
app.get('/api/upload/status/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
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
app.post('/api/upload/complete', async (req: Request, res: Response) => {
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
app.delete('/api/upload/cancel/:uploadId', async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.params;
    await cancelUpload(uploadId);
    return res.json({ success: true, message: 'Upload cancelled and chunks cleared' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: VIDEO UPLOAD & SOURCE MANAGEMENT
// -------------------------------------------------------------
app.post('/api/videos/upload', upload.single('video'), async (req: Request, res: Response) => {
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
app.post('/api/videos/sample', async (req: Request, res: Response) => {
  try {
    const { sampleType = 'podcast' } = req.body;
    const videoId = `sample-${sampleType}-${Date.now()}`;
    const filename = `${videoId}.mp4`;
    const filepath = path.join(SAMPLES_DIR, filename);

    // Create a real video using FFmpeg test filters if not yet generated
    // This produces a genuine high-definition MP4 file with audio tones and timer overlay
    let title = 'Podcast Masterclass: Building Tech in 2026';
    let duration = 65; // 65 seconds long-form video

    if (sampleType === 'keynote') {
      title = 'AI Revolution Keynote: The Future of Automation';
      duration = 80;
    } else if (sampleType === 'gaming') {
      title = 'Pro Gameplay: Championship Final Climax';
      duration = 50;
    }

    // Generate real video using FFmpeg
    const ffmpegCmd = [
      '-f', 'lavfi',
      '-i', `testsrc=duration=${duration}:size=1920x1080:rate=30`,
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${duration}`,
      '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='ClipGenius Source\\: ${title}':x=80:y=80:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Time\\: %{pts\\:hms}':x=80:y=160:fontsize=36:fontcolor=yellow:box=1:boxcolor=black@0.6`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      filepath,
    ];

    const { spawn } = await import('child_process');
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ffmpegCmd);
      child.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`Sample generation exited with code ${code}`));
      });
      child.on('error', reject);
    });

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
app.get('/api/videos', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    videos: Array.from(videosRegistry.values()),
  });
});

// Get single video metadata
app.get('/api/videos/item/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
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
app.delete('/api/videos/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const video = videosRegistry.get(id);

    if (video?.filepath && fs.existsSync(video.filepath)) {
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
app.head('/api/videos/stream/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
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
app.get('/api/videos/stream/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
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
    if (isNaN(start) || start >= fileSize || (parts[1] && (end >= fileSize || start > end))) {
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
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    fs.createReadStream(filepath).pipe(res);
  }
});

// Serve thumbnail images
app.get('/api/thumbnails/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const thumbPath = path.join(THUMBNAILS_DIR, `thumb-${id}.jpg`);

  if (fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  }

  return res.status(404).send('Thumbnail not found');
});

// Generate and serve instantaneous clip thumbnail at specific timestamp
app.get('/api/thumbnails/clip/:sourceVideoId', async (req: Request, res: Response) => {
  try {
    const { sourceVideoId } = req.params;
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
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    return res.status(500).send(`Failed to extract clip thumbnail: ${(err as Error).message}`);
  }
});

// -------------------------------------------------------------
// API: AI CLIP ANALYSIS (NVIDIA NEMOTRON 3.5 SUPER VL + GEMINI FALLBACK)
// -------------------------------------------------------------
app.post('/api/ai/analyze', async (req: Request, res: Response) => {
  try {
    const {
      videoId,
      preferredProvider,
      clipCount = 3,
      clipStyle = 'viral_shorts',
      customPrompt,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName,
      chunkOffsetSeconds,
      previouslySelectedClips,
      privacyConsent,
    } = req.body;

    const video = videosRegistry.get(videoId);
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).json({ error: 'Source video not found on disk' });
    }

    const result = await dispatchVideoAnalysis({
      preferredProvider,
      sourceVideoId: video.id,
      sourcePath: video.filepath,
      filename: video.originalName,
      duration: video.duration,
      clipCount: Number(clipCount) || 3,
      clipStyle,
      customPrompt,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName: chunkName || 'chunk_01',
      chunkOffsetSeconds: Number(chunkOffsetSeconds) || 0,
      privacyConsent: privacyConsent !== false,
      previouslySelectedClips: Array.isArray(previouslySelectedClips) ? previouslySelectedClips : [],
    });

    return res.json({
      success: true,
      clips: result.clips,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      stagesCompleted: result.stagesCompleted,
      sourceVideo: video,
    });
  } catch (error) {
    console.error('AI Analysis failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Endpoint to independently validate clip timestamps and quote before render/publish
app.post('/api/clips/validate', (req: Request, res: Response) => {
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
app.post('/api/clips/render', async (req: Request, res: Response) => {
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

    const jobId = `job-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const outputFilename = `clip-${jobId}-${aspectRatio.replace(':', 'x')}.mp4`;
    const outputPath = path.join(RENDERED_DIR, outputFilename);

    const safeStart = Math.max(0, parseFloat(startTime) || 0);
    const safeEnd = Math.min(video.duration, parseFloat(endTime) || safeStart + 30);
    const targetDuration = Math.max(0.5, safeEnd - safeStart);

    const renderJob: RenderJob = {
      id: jobId,
      clipId: clipId || jobId,
      title: title || `Viral Clip (${aspectRatio})`,
      sourceVideoId,
      startTime: safeStart,
      endTime: safeEnd,
      aspectRatio: (aspectRatio as '9:16' | '1:1' | '16:9') || '9:16',
      status: 'rendering',
      progress: 0,
      outputFilename,
      outputPath,
      downloadUrl: `/api/clips/download/${jobId}`,
      duration: Math.round(targetDuration * 10) / 10,
      createdAt: new Date().toISOString(),
    };

    renderJobsRegistry.set(jobId, renderJob);

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

// Check status of a render job
app.get('/api/clips/status/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = renderJobsRegistry.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  return res.json({ job });
});

// Download rendered MP4 clip with safe headers and active download tracking
app.get('/api/clips/download/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = renderJobsRegistry.get(jobId);

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Rendered clip not found or still processing' });
  }

  const stat = fs.statSync(job.outputPath);
  const safeTitle = (job.title || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeAspect = (job.aspectRatio || '9x16').replace(':', 'x');
  const safeFilename = `${safeTitle}_${safeAspect}.mp4`;

  activeDownloads.add(jobId);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

  const stream = fs.createReadStream(job.outputPath);
  stream.on('end', () => {
    activeDownloads.delete(jobId);
  });
  stream.on('error', () => {
    activeDownloads.delete(jobId);
  });
  res.on('close', () => {
    activeDownloads.delete(jobId);
  });

  stream.pipe(res);
});

// Delete a rendered clip from server without affecting already downloaded files
app.delete('/api/clips/render/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = renderJobsRegistry.get(jobId);

    if (activeDownloads.has(jobId)) {
      return res.status(409).json({ error: 'Cannot delete clip while an active download is in progress' });
    }

    if (job?.outputPath && fs.existsSync(job.outputPath)) {
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

// Stream rendered MP4 clip for in-browser playback
app.get('/api/clips/stream/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = renderJobsRegistry.get(jobId);

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).send('Rendered clip not found');
  }

  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(job.outputPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(job.outputPath).pipe(res);
  }
});

// -------------------------------------------------------------
// API: INDIVIDUAL CLIP PUBLISHING WORKFLOW & SUPABASE SYNC
// -------------------------------------------------------------

// Publish an individual reviewed clip
app.post('/api/clips/publish', async (req: Request, res: Response) => {
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
app.get('/api/clips/published', async (_req: Request, res: Response) => {
  try {
    const published = await getPublishedClips();
    return res.json({ published });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Remove/unpublish a published clip record
app.delete('/api/clips/publish/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await deletePublishedClip(id);
    return res.json({ success: true, message: 'Published clip record removed' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: PROJECTS STORAGE & SUPABASE SYNC
// -------------------------------------------------------------
app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await getProjects();
    return res.json({ projects });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/projects', async (req: Request, res: Response) => {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClipGenius AI] Full-Stack server running on port ${PORT}`);
    console.log(`[ClipGenius AI] Mode: ${isProd ? 'Production' : 'Development'}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
