import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  format: string;
  bitrate?: number;
  fps?: number;
  hasAudio: boolean;
}

export interface RenderOptions {
  sourcePath: string;
  outputPath: string;
  startTime: number;
  endTime: number;
  aspectRatio: '9:16' | '1:1' | '16:9';
  onProgress?: (percent: number) => void;
}

/**
 * Check if ffmpeg and ffprobe binaries are available in PATH
 */
export async function checkFfmpegAvailability(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
  version?: string;
}> {
  try {
    const { stdout: ffmpegOut } = await execAsync('ffmpeg -version');
    const { stdout: ffprobeOut } = await execAsync('ffprobe -version');
    const firstLine = ffmpegOut.split('\n')[0] || '';

    return {
      ffmpeg: true,
      ffprobe: true,
      version: firstLine,
    };
  } catch (error) {
    console.error('FFmpeg availability check failed:', error);
    return {
      ffmpeg: false,
      ffprobe: false,
    };
  }
}

/**
 * Probe a video file using ffprobe
 */
export async function probeVideo(filepath: string): Promise<ProbeResult> {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration,bit_rate -show_entries format=duration,format_name,size -of json "${filepath}"`;
  const audioCmd = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of json "${filepath}"`;

  try {
    const { stdout } = await execAsync(cmd);
    const probeData = JSON.parse(stdout);

    let hasAudio = false;
    try {
      const { stdout: audioOut } = await execAsync(audioCmd);
      const audioData = JSON.parse(audioOut);
      hasAudio = Boolean(audioData.streams && audioData.streams.length > 0);
    } catch {
      hasAudio = false;
    }

    const stream = probeData.streams?.[0] || {};
    const format = probeData.format || {};

    const duration = parseFloat(stream.duration || format.duration || '0');
    const width = parseInt(stream.width || '1920', 10);
    const height = parseInt(stream.height || '1080', 10);
    const bitrate = parseInt(stream.bit_rate || format.bit_rate || '0', 10);

    // Calculate FPS
    let fps = 30;
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      if (num && den) fps = Math.round((num / den) * 10) / 10;
    }

    return {
      duration: Math.max(0, duration),
      width,
      height,
      format: format.format_name || 'mp4',
      bitrate,
      fps,
      hasAudio,
    };
  } catch (error) {
    console.error('FFprobe error:', error);
    throw new Error(`Failed to probe video file: ${(error as Error).message}`);
  }
}

/**
 * Generate a thumbnail frame from video
 */
export async function generateThumbnail(
  videoPath: string,
  outputPath: string,
  timestampSec: number = 1
): Promise<string> {
  const safeTime = Math.max(0, timestampSec);
  const cmd = `ffmpeg -ss ${safeTime} -i "${videoPath}" -vframes 1 -q:v 2 -y "${outputPath}"`;
  await execAsync(cmd);
  return outputPath;
}

/**
 * Verify whether a timestamp range contains decodable video frames
 */
export async function verifyDecodableRange(
  sourcePath: string,
  startTime: number,
  endTime: number
): Promise<boolean> {
  try {
    const testDuration = Math.min(1.0, Math.max(0.1, (endTime - startTime) / 2));
    const cmd = `ffmpeg -v error -ss ${startTime.toFixed(3)} -i "${sourcePath}" -t ${testDuration.toFixed(3)} -f null -`;
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract representative base64 JPEG frames at specified timestamps for Nemotron VL analysis
 */
export async function extractSampleFrames(
  sourcePath: string,
  timestamps: number[],
  maxDimension: number = 640
): Promise<Array<{ timestamp: number; base64: string }>> {
  const frames: Array<{ timestamp: number; base64: string }> = [];
  const tempDir = path.resolve(process.cwd(), 'uploads', 'temp_frames', `sample_${Date.now()}`);

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    for (let i = 0; i < timestamps.length; i++) {
      const ts = Math.max(0, timestamps[i]);
      const framePath = path.join(tempDir, `frame_${i}_${Math.round(ts)}.jpg`);

      try {
        const cmd = `ffmpeg -v error -ss ${ts.toFixed(3)} -i "${sourcePath}" -vframes 1 -q:v 3 -vf "scale='min(${maxDimension},iw)':-2" -y "${framePath}"`;
        await execAsync(cmd);

        if (fs.existsSync(framePath) && fs.statSync(framePath).size > 500) {
          const buffer = fs.readFileSync(framePath);
          frames.push({
            timestamp: ts,
            base64: buffer.toString('base64'),
          });
        }
      } catch (err) {
        console.warn(`Could not extract frame at ${ts}s:`, err);
      }
    }
  } finally {
    // Immediate cleanup of temporary frame files
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }

  return frames;
}

/**
 * Render a video clip with precise start/end time and aspect ratio cropping
 * Includes atomic temporary file output, decode validation, and Windows playback compatibility
 */
export async function renderClip(options: RenderOptions): Promise<string> {
  const { sourcePath, outputPath, startTime, endTime, aspectRatio, onProgress } = options;
  const clipDuration = Math.max(0.5, endTime - startTime);
  const tempOutputPath = `${outputPath}.tmp.mp4`;

  // Probe audio stream existence to avoid forcing nonexistent audio
  let hasAudioStream = true;
  try {
    const probe = await probeVideo(sourcePath);
    hasAudioStream = probe.hasAudio;
  } catch {
    hasAudioStream = true;
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean up any stale temp file
  if (fs.existsSync(tempOutputPath)) {
    try {
      fs.unlinkSync(tempOutputPath);
    } catch {}
  }

  // Prepare aspect ratio filter
  // 9:16 Vertical (TikTok/Reels/Shorts) -> 1080x1920
  // 1:1 Square (Instagram) -> 1080x1080
  // 16:9 Landscape (YouTube) -> 1920x1080
  let videoFilter = '';
  if (aspectRatio === '9:16') {
    videoFilter = 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920';
  } else if (aspectRatio === '1:1') {
    videoFilter = 'crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=1080:1080';
  } else {
    videoFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  }

  const args: string[] = [
    '-ss', startTime.toFixed(3),
    '-i', sourcePath,
    '-t', clipDuration.toFixed(3),
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.1',
    '-preset', 'fast',
    '-crf', '22',
  ];

  // Only encode AAC audio if audio stream actually exists
  if (hasAudioStream) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    '-y',
    tempOutputPath
  );

  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args);

    let errorOutput = '';

    process.stderr.on('data', (data) => {
      const msg = data.toString();
      errorOutput += msg;

      // Extract time=00:00:05.12 to calculate percentage
      const timeMatch = msg.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch && onProgress) {
        const hours = parseFloat(timeMatch[1]);
        const mins = parseFloat(timeMatch[2]);
        const secs = parseFloat(timeMatch[3]);
        const currentSecs = hours * 3600 + mins * 60 + secs;
        const percent = Math.min(95, Math.round((currentSecs / clipDuration) * 100));
        onProgress(percent);
      }
    });

    process.on('close', async (code) => {
      if (code !== 0) {
        if (fs.existsSync(tempOutputPath)) {
          try { fs.unlinkSync(tempOutputPath); } catch {}
        }
        reject(new Error(`FFmpeg exited with code ${code}. Details: ${errorOutput.slice(-300)}`));
        return;
      }

      try {
        // Validation 1: Verify output file exists and is nonzero
        if (!fs.existsSync(tempOutputPath)) {
          throw new Error('Render output file was not created by FFmpeg process');
        }
        const fileSize = fs.statSync(tempOutputPath).size;
        if (fileSize < 1024) {
          throw new Error(`Render output file is too small (${fileSize} bytes), indicates truncated encode`);
        }

        // Validation 2: Run FFprobe to verify video stream, resolution, and format
        const probe = await probeVideo(tempOutputPath);
        if (probe.duration <= 0 || probe.width <= 0 || probe.height <= 0) {
          throw new Error('Rendered MP4 has invalid stream dimensions or duration');
        }

        // Validation 3: Run full decode test to guarantee file is not corrupt
        const decodeTestCmd = `ffmpeg -v error -i "${tempOutputPath}" -f null -`;
        await execAsync(decodeTestCmd);

        // Validation 4: Atomic rename to final output filename
        fs.renameSync(tempOutputPath, outputPath);

        if (onProgress) onProgress(100);
        resolve(outputPath);
      } catch (validationErr) {
        if (fs.existsSync(tempOutputPath)) {
          try { fs.unlinkSync(tempOutputPath); } catch {}
        }
        reject(new Error(`Render validation failed: ${(validationErr as Error).message}`));
      }
    });

    process.on('error', (err) => {
      if (fs.existsSync(tempOutputPath)) {
        try { fs.unlinkSync(tempOutputPath); } catch {}
      }
      reject(err);
    });
  });
}
