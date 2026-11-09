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
 * Render a video clip with precise start/end time and aspect ratio cropping
 */
export async function renderClip(options: RenderOptions): Promise<string> {
  const { sourcePath, outputPath, startTime, endTime, aspectRatio, onProgress } = options;
  const clipDuration = Math.max(0.5, endTime - startTime);

  // Prepare aspect ratio filter
  // 9:16 Vertical (TikTok/Reels/Shorts)
  // 1:1 Square (Instagram)
  // 16:9 Landscape (YouTube)
  let videoFilter = '';
  if (aspectRatio === '9:16') {
    // Crop center to 9:16 aspect ratio then scale to 1080x1920
    videoFilter = 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920';
  } else if (aspectRatio === '1:1') {
    // Crop center square then scale to 1080x1080
    videoFilter = 'crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=1080:1080';
  } else {
    // 16:9 Standard widescreen
    videoFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  }

  const args: string[] = [
    '-ss', startTime.toFixed(3),
    '-i', sourcePath,
    '-t', clipDuration.toFixed(3),
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

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
        const percent = Math.min(99, Math.round((currentSecs / clipDuration) * 100));
        onProgress(percent);
      }
    });

    process.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100);
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}. Details: ${errorOutput.slice(-300)}`));
      }
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}
