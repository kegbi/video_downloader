import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { loadConfig } from "../packages/config/mod.ts";

const config = loadConfig("storage");
const client = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
} catch (error) {
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== 404) throw error;
  await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
}
try {
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: config.S3_BUCKET,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
} catch (error) {
  // RustFS builds that do not expose this AWS extension remain private by default.
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== 400 && status !== 404 && status !== 501) throw error;
}
console.log(JSON.stringify({ event: "storage.initialized", bucket: config.S3_BUCKET }));
