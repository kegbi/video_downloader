import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import type { AppConfig } from "../config/mod.ts";

export const ARTIFACT_UPLOAD_READ_CHUNK_BYTES = 64 * 1024;

export interface ArtifactRead {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number;
  readonly contentRange: string | null;
  readonly contentType: string;
}

export interface ArtifactStorage {
  putTemporary(
    artifactId: string,
    source: { readonly path: string; readonly byteSize: number; readonly sha256: string },
  ): Promise<string>;
  promote(artifactId: string): Promise<string>;
  read(objectKey: string, range?: string): Promise<ArtifactRead>;
  delete(objectKey: string): Promise<void>;
  healthy(): Promise<boolean>;
}

export class S3ArtifactStorage implements ArtifactStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: Readonly<AppConfig>,
    private readonly observeUploadChunk?: (byteLength: number) => void,
  ) {
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    });
  }

  async putTemporary(
    artifactId: string,
    source: { readonly path: string; readonly byteSize: number; readonly sha256: string },
  ): Promise<string> {
    const key = `${this.config.S3_TEMP_PREFIX}${artifactId}`;
    const sourceBody = createReadStream(source.path, {
      highWaterMark: ARTIFACT_UPLOAD_READ_CHUNK_BYTES,
    });
    const body = this.observeUploadChunk
      ? sourceBody.pipe(
        new Transform({
          transform: (chunk: Uint8Array, _encoding, callback) => {
            this.observeUploadChunk?.(chunk.byteLength);
            callback(null, chunk);
          },
        }),
      )
      : sourceBody;
    try {
      await new Upload({
        client: this.client,
        queueSize: 2,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
        params: {
          Bucket: this.config.S3_BUCKET,
          Key: key,
          Body: body,
          ContentLength: source.byteSize,
          ContentType: "video/mp4",
          Metadata: { artifact: artifactId, sha256: source.sha256 },
        },
      }).done();
    } finally {
      body.destroy();
      sourceBody.destroy();
    }
    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
    );
    if (head.ContentLength !== source.byteSize || head.Metadata?.sha256 !== source.sha256) {
      throw new Error("Temporary object verification failed");
    }
    return key;
  }

  async promote(artifactId: string): Promise<string> {
    const temporaryKey = `${this.config.S3_TEMP_PREFIX}${artifactId}`;
    const finalKey = `${this.config.S3_ARTIFACT_PREFIX}${artifactId}`;
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: finalKey,
        CopySource: `${this.config.S3_BUCKET}/${temporaryKey}`,
        ContentType: "video/mp4",
        MetadataDirective: "COPY",
      }),
    );
    await this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: finalKey }));
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: temporaryKey }),
    );
    return finalKey;
  }

  async read(objectKey: string, range?: string): Promise<ArtifactRead> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: objectKey,
        Range: range,
      }),
    );
    if (!response.Body) throw new Error("S3 returned an empty object body");
    const body = response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    return {
      body,
      contentLength: response.ContentLength ?? 0,
      contentRange: response.ContentRange ?? null,
      contentType: response.ContentType ?? "application/octet-stream",
    };
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: objectKey }),
    );
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET }));
      return true;
    } catch {
      return false;
    }
  }
}
