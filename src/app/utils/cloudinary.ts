import { GetObjectCommand, S3 } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import mime from 'mime-types';
import path from 'path';
import { configs } from '../configs/index.js';
import { cleanupUploadedFile, markFileHandled } from './upload_cleanup.js';

type IFile = {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  destination: string;
  filename: string;
  path: string; // Make sure this exists
  size: number;
}; // Create the S3 client
const s3 = new S3({
  region: configs.aws.region as string,
  credentials: {
    accessKeyId: configs.aws.access_key_id as string,
    secretAccessKey: configs.aws.secret_access_key as string,
  },
});

const uploadCloud = async (file: IFile): Promise<{ secure_url: string; key: string }> => {
  // Marked *before* the S3 upload starts, not after: this call is the point
  // where the file's disk lifecycle becomes uploadCloud's responsibility.
  // Some callers (e.g. note.service.ts's best-effort attachment upload) don't
  // await this on the response's critical path, so the request can finish
  // while this is still in flight — the res.on('finish') safety net
  // (upload_cleanup.ts) must see this file as already owned, or it would
  // delete it out from under this still-running upload. Marking after the
  // fact would leave that exact window unprotected.
  markFileHandled(file);

  const fileContent = fs.readFileSync(file.path);
  const ext = path.extname(file.path);
  const baseName = path.basename(file.path, ext);
  const fileName = `${Date.now()}${ext ? '-' : ''}${baseName}`;
  const contentType = mime.lookup(ext) || 'application/octet-stream';

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: configs.aws.bucket as string,
      Key: fileName,
      Body: fileContent,
      ContentType: contentType,
    },
  });

  try {
    const result = await upload.done();
    await cleanupUploadedFile(file); // Delete file after upload
    return {
      secure_url: result.Location as string,
      key: fileName,
    };
  } catch (err) {
    await cleanupUploadedFile(file); // Still delete on error
    throw err;
  }
};

/**
 * Extracts the S3 object key from a stored object URL. uploadCloud stores the
 * raw `result.Location`, which is either virtual-hosted style
 * (`https://<bucket>.s3.<region>.amazonaws.com/<key>`) or path style
 * (`https://s3.<region>.amazonaws.com/<bucket>/<key>`). We take the URL path,
 * decode it, and strip a leading `<bucket>/` segment if present so both styles
 * resolve to the same key.
 */
const extractS3Key = (fileUrl: string): string => {
  const { pathname } = new URL(fileUrl);
  const decoded = decodeURIComponent(pathname.replace(/^\/+/, ''));
  const bucket = configs.aws.bucket as string;
  if (bucket && decoded.startsWith(`${bucket}/`)) {
    return decoded.slice(bucket.length + 1);
  }
  return decoded;
};

/**
 * Returns a short-lived presigned GET URL for a previously uploaded object,
 * given the permanent URL stored in the DB. Used by the report download
 * endpoint (#222) so the client never receives the permanent public URL — only
 * a link that expires after `expiresInSeconds`.
 */
export const getSignedDownloadUrl = async (
  fileUrl: string,
  expiresInSeconds: number,
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: configs.aws.bucket as string,
    Key: extractS3Key(fileUrl),
  });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
};

export default uploadCloud;
