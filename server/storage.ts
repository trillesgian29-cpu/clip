import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

export type StorageProviderType = 'local_scratch' | 'supabase_storage' | 's3_compatible';

export interface StorageProviderLimits {
  provider: StorageProviderType;
  name: string;
  maxFileSize: string;
  maxFileSizeBytes: number;
  resumableSupported: boolean;
  notes: string;
}

export const STORAGE_LIMITS_EVALUATION: StorageProviderLimits[] = [
  {
    provider: 'local_scratch',
    name: 'High-Performance Local Scratch Disk',
    maxFileSize: '20 GB (Configured Max) / 504 GB (Volume Limit)',
    maxFileSizeBytes: 20 * 1024 * 1024 * 1024,
    resumableSupported: true,
    notes: 'Direct streaming & zero network latency for FFmpeg. Native chunked resumable upload.',
  },
  {
    provider: 'supabase_storage',
    name: 'Supabase Storage (Object Buckets)',
    maxFileSize: '50 MB (Free tier) / 50 GB (Pro tier with bucket config)',
    maxFileSizeBytes: 50 * 1024 * 1024 * 1024,
    resumableSupported: true,
    notes: 'Supabase Free projects enforce a strict 50MB file size limit. Pro plan enables up to 50GB.',
  },
  {
    provider: 's3_compatible',
    name: 'S3-Compatible Object Storage (AWS S3, Cloudflare R2, MinIO)',
    maxFileSize: '5 TB via Multipart Upload',
    maxFileSizeBytes: 5 * 1024 * 1024 * 1024 * 1024,
    resumableSupported: true,
    notes: 'Ideal for 10 GB - 20 GB multi-hour videos with 5MB to 50MB multipart parts. Zero egress fees on Cloudflare R2.',
  },
];

let s3Client: S3Client | null = null;

export function getS3Status(): { isConfigured: boolean; bucket?: string; endpoint?: string } {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const isConfigured = Boolean(bucket && accessKeyId && secretAccessKey);

  if (isConfigured && !s3Client) {
    try {
      s3Client = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        credentials: {
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
        },
      });
    } catch (err) {
      console.warn('Failed to initialize S3 client:', err);
    }
  }

  return {
    isConfigured,
    bucket,
    endpoint: process.env.S3_ENDPOINT,
  };
}

export function getStorageArchitectureInfo(): {
  activeProvider: StorageProviderType;
  s3: { isConfigured: boolean; bucket?: string };
  supabaseStorage: { isConfigured: boolean; maxFileSizeNotice: string };
  limits: StorageProviderLimits[];
} {
  const s3 = getS3Status();
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const hasSupabase = Boolean(supabaseUrl && !supabaseUrl.includes('xyzcompany'));

  let activeProvider: StorageProviderType = 'local_scratch';
  if (s3.isConfigured) {
    activeProvider = 's3_compatible';
  } else if (hasSupabase) {
    activeProvider = 'supabase_storage';
  }

  return {
    activeProvider,
    s3: {
      isConfigured: s3.isConfigured,
      bucket: s3.bucket,
    },
    supabaseStorage: {
      isConfigured: hasSupabase,
      maxFileSizeNotice:
        'Supabase Free tier limits files to 50MB. Pro tier required for 5GB-50GB videos.',
    },
    limits: STORAGE_LIMITS_EVALUATION,
  };
}
