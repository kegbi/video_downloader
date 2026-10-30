import { assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { loadConfig } from "../../packages/config/mod.ts";
import { ARTIFACT_UPLOAD_READ_CHUNK_BYTES, S3ArtifactStorage } from "../../packages/storage/s3.ts";

Deno.test({
  name: "RustFS adapter uploads, promotes, range streams and deletes privately",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = loadConfig("test", {
      APP_ENV: "test",
      S3_ENDPOINT: Deno.env.get("TEST_S3_ENDPOINT") ?? "http://127.0.0.1:9000",
      S3_BUCKET: Deno.env.get("TEST_S3_BUCKET") ?? "video-artifacts-test",
      S3_ACCESS_KEY: Deno.env.get("TEST_S3_ACCESS_KEY") ?? "local-rustfs-access-key",
      S3_SECRET_KEY: Deno.env.get("TEST_S3_SECRET_KEY") ?? "local-rustfs-secret-key",
    });
    const observedUploadChunks: number[] = [];
    const storage = new S3ArtifactStorage(
      config,
      (byteLength) => observedUploadChunks.push(byteLength),
    );
    const temporaryRoot = await Deno.makeTempDir();
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode("0123456789");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
    try {
      const path = `${temporaryRoot}/fixture.bin`;
      await Deno.writeFile(path, bytes);
      assertEquals(await storage.healthy(), true);
      assertEquals(
        await storage.putTemporary(id, { path, byteSize: bytes.length, sha256 }),
        `temporary/${id}`,
      );
      const key = await storage.promote(id);
      assertEquals(key, `artifacts/${id}`);
      const read = await storage.read(key, "bytes=2-5");
      assertEquals(read.contentRange, "bytes 2-5/10");
      assertEquals(new TextDecoder().decode(await new Response(read.body).arrayBuffer()), "2345");
      await storage.delete(key);
      await storage.delete(key);

      const multipartId = crypto.randomUUID();
      const multipartByteSize = 6 * 1024 * 1024;
      const multipartPath = `${temporaryRoot}/multipart.bin`;
      const multipartSha = await writeBoundedFixture(multipartPath, multipartByteSize);
      observedUploadChunks.length = 0;
      await storage.putTemporary(multipartId, {
        path: multipartPath,
        byteSize: multipartByteSize,
        sha256: multipartSha,
      });
      const multipartKey = await storage.promote(multipartId);
      assertEquals((await storage.read(multipartKey)).contentLength, multipartByteSize);
      assertEquals(observedUploadChunks.length > 1, true);
      assertEquals(
        Math.max(...observedUploadChunks) <= ARTIFACT_UPLOAD_READ_CHUNK_BYTES,
        true,
      );
      assertEquals(
        observedUploadChunks.reduce((total, byteLength) => total + byteLength, 0),
        multipartByteSize,
      );
      await storage.delete(multipartKey);
    } finally {
      await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
    }
  },
});

async function writeBoundedFixture(path: string, byteSize: number): Promise<string> {
  const chunk = new Uint8Array(64 * 1024).fill(3);
  const hash = createHash("sha256");
  const file = await Deno.open(path, { createNew: true, write: true });
  try {
    for (let remaining = byteSize; remaining > 0;) {
      const current = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
      await file.write(current);
      hash.update(current);
      remaining -= current.byteLength;
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}
