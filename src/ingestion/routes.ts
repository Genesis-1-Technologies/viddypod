import { FastifyInstance } from 'fastify';
import { uploadAsset, addStreamUrl, listAssets, getAsset, deleteAsset, fetchYouTubeMetadata } from './service.js';
import { addYouTubeVideo } from './youtube.js';
import { authMiddleware } from '../auth/middleware.js';
import { z } from 'zod';
import { ACCEPTED_AUDIO_TYPES, MAX_UPLOAD_SIZE } from '../shared/constants.js';
import { ValidationError } from '../shared/errors.js';
import { sanitizeFilename } from '../shared/sanitize.js';

const addVideoSchema = z.object({
  url: z.string().url(),
});

const cookiesSchema = z.object({
  cookies: z.string().min(1),
});

const agentFailureSchema = z.object({
  // Truncated: this is attacker-influenced text (yt-dlp stderr) that lands in logs
  error: z.string().max(500).optional(),
});

const addStreamSchema = z.object({
  licenseId: z.string().uuid(),
  streamUrl: z.string().url(),
  filename: z.string().optional(),
});

const youtubeMetaSchema = z.object({
  licenseId: z.string().uuid(),
  videoId: z.string().min(1),
});

export async function ingestionRoutes(app: FastifyInstance) {
  // Agent endpoints — local agent polls for pending downloads and uploads results

  // List videos waiting for local download
  app.get('/api/v1/agent/pending', {
    preHandler: [authMiddleware],
  }, async (request) => {
    const db = (await import('../db/client.js')).getDb();
    const { assets } = await import('../db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    return db.select().from(assets)
      .where(and(
        eq(assets.userId, request.userId!),
        eq(assets.processingStatus, 'pending_download'),
      ));
  });

  // Agent uploads downloaded audio for an asset
  app.post('/api/v1/agent/upload/:assetId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const data = await request.file();
    if (!data) throw new ValidationError('No file provided');

    const db = (await import('../db/client.js')).getDb();
    const { assets } = await import('../db/schema.js');
    const { eq, and } = await import('drizzle-orm');

    // Verify asset belongs to user and is pending download
    const rows = await db.select().from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, request.userId!)))
      .limit(1);
    if (rows.length === 0) throw new (await import('../shared/errors.js')).NotFoundError('Asset');
    const asset = rows[0];
    if (asset.processingStatus !== 'pending_download') {
      throw new ValidationError('Asset is not pending download');
    }

    const buffer = await data.toBuffer();

    // Parse metadata from multipart fields
    const getField = (name: string) => {
      const f = data.fields[name];
      return f && 'value' in f ? f.value as string : undefined;
    };
    const title = getField('title');
    const description = getField('description');
    const duration = getField('duration');
    const thumbnail = getField('thumbnail');

    // Upload to storage
    const { uploadFile } = await import('../publishing/storage.js');
    const safeFilename = sanitizeFilename(data.filename, 'audio.mp3');
    const storageKey = `assets/${request.userId}/${assetId}/${safeFilename}`;
    await uploadFile(storageKey, buffer, data.mimetype);

    // Update asset — mark as pending (ready for server-side processing)
    await db.update(assets)
      .set({
        storageKey,
        originalFilename: safeFilename,
        mimeType: data.mimetype,
        fileSizeBytes: buffer.length,
        processingStatus: 'pending',
        processingStage: 'queued',
        processingProgress: 20,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));

    // Update episode with metadata from YouTube
    const { episodes } = await import('../db/schema.js');
    if (title || description || duration || thumbnail) {
      // Download and re-host the thumbnail so podcast apps can access it
      let hostedThumbnailUrl: string | undefined;
      if (thumbnail) {
        try {
          const { uploadToPodcastBucket } = await import('../publishing/storage.js');
          const config = (await import('../config.js')).getConfig();
          const thumbRes = await fetch(thumbnail);
          if (thumbRes.ok) {
            const thumbBuffer = Buffer.from(await thumbRes.arrayBuffer());
            const contentType = thumbRes.headers.get('content-type') || 'image/jpeg';
            const ext = contentType.includes('png') ? 'png' : 'jpg';
            const thumbKey = `thumbnails/${request.userId}/${assetId}.${ext}`;
            await uploadToPodcastBucket(thumbKey, thumbBuffer, contentType);
            hostedThumbnailUrl = `${config.BASE_URL}/storage/${thumbKey}`;
          }
        } catch {
          // Fall back to original YouTube URL if download fails
          hostedThumbnailUrl = thumbnail;
        }
      }

      const linkedEps = await db.select().from(episodes)
        .where(eq(episodes.assetId, assetId));
      for (const ep of linkedEps) {
        await db.update(episodes).set({
          ...(title && { title }),
          ...(description && { description }),
          ...(duration && { durationSeconds: Math.round(parseFloat(duration)) }),
          ...(hostedThumbnailUrl && { imageUrl: hostedThumbnailUrl }),
          updatedAt: new Date(),
        }).where(eq(episodes.id, ep.id));
      }
    }

    // Queue server-side processing (transcode + normalize)
    const { enqueueProcessingJob } = await import('../processing/jobs.js');
    await enqueueProcessingJob({
      assetId,
      userId: request.userId!,
      targetFormat: 'mp3',
    });

    return reply.status(200).send({ ok: true, status: 'processing' });
  });

  // Agent reports a download it cannot complete. Without this, a video that can
  // never succeed (private, removed, age-gated, region-blocked) stays
  // 'pending_download' forever and every agent re-downloads it on every poll —
  // an unbounded retry loop against YouTube from the user's own IP.
  app.post('/api/v1/agent/failed/:assetId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    // Validate before it reaches Postgres — a non-UUID would raise
    // "invalid input syntax for type uuid" and surface as a 500.
    const assetId = z.string().uuid().parse((request.params as { assetId: string }).assetId);
    const { error } = agentFailureSchema.parse(request.body ?? {});

    const db = (await import('../db/client.js')).getDb();
    const { assets } = await import('../db/schema.js');
    const { eq, and } = await import('drizzle-orm');

    const result = await db.update(assets)
      .set({
        processingStatus: 'failed',
        processingStage: 'failed',
        updatedAt: new Date(),
      })
      // Scoped to the caller's own pending-download assets: an agent must not
      // be able to fail someone else's asset, or clobber one already processing.
      .where(and(
        eq(assets.id, assetId),
        eq(assets.userId, request.userId!),
        eq(assets.processingStatus, 'pending_download'),
      ))
      .returning({ id: assets.id });

    if (result.length === 0) {
      throw new (await import('../shared/errors.js')).NotFoundError('Pending asset');
    }

    // Episodes carry no status of their own — EpisodeList reads the asset's
    // processingStatus/processingStage through the join, so this is enough.
    request.log.warn({ assetId, error }, 'Agent reported download failure');
    return reply.status(200).send({ ok: true, status: 'failed' });
  });

  // Re-host episode thumbnails from YouTube to our S3
  app.post('/api/v1/episodes/:id/rehost-thumbnail', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (await import('../db/client.js')).getDb();
    const { episodes } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');

    const rows = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
    if (rows.length === 0) throw new (await import('../shared/errors.js')).NotFoundError('Episode');
    const ep = rows[0];

    if (!ep.imageUrl || ep.imageUrl.includes('/storage/')) {
      return reply.send({ ok: true, imageUrl: ep.imageUrl, message: 'Already hosted' });
    }

    const { uploadToPodcastBucket } = await import('../publishing/storage.js');
    const config = (await import('../config.js')).getConfig();

    const thumbRes = await fetch(ep.imageUrl);
    if (!thumbRes.ok) throw new ValidationError('Failed to fetch thumbnail');
    const thumbBuffer = Buffer.from(await thumbRes.arrayBuffer());
    const contentType = thumbRes.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const thumbKey = `thumbnails/${request.userId}/${id}.${ext}`;
    await uploadToPodcastBucket(thumbKey, thumbBuffer, contentType);
    const hostedUrl = `${config.BASE_URL}/storage/${thumbKey}`;

    await db.update(episodes)
      .set({ imageUrl: hostedUrl, updatedAt: new Date() })
      .where(eq(episodes.id, id));

    return reply.send({ ok: true, imageUrl: hostedUrl });
  });

  // Upload/regenerate podcast cover image
  app.post('/api/v1/feeds/:feedId/cover', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { feedId } = request.params as { feedId: string };
    const db = (await import('../db/client.js')).getDb();
    const { feeds } = await import('../db/schema.js');
    const { eq, and } = await import('drizzle-orm');

    const feedRows = await db.select().from(feeds)
      .where(and(eq(feeds.id, feedId), eq(feeds.userId, request.userId!)))
      .limit(1);
    if (feedRows.length === 0) throw new (await import('../shared/errors.js')).NotFoundError('Feed');
    const feed = feedRows[0];

    const { uploadToPodcastBucket } = await import('../publishing/storage.js');
    const config = (await import('../config.js')).getConfig();
    const { readFile } = await import('fs/promises');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const coverBuffer = await readFile(resolve(__dirname, '../../static/viddypod-cover.png'));

    const coverKey = `covers/${request.userId}/${feedId}.png`;
    await uploadToPodcastBucket(coverKey, coverBuffer, 'image/png');
    const imageUrl = `${config.BASE_URL}/storage/${coverKey}`;

    await db.update(feeds)
      .set({ imageUrl, updatedAt: new Date() })
      .where(eq(feeds.id, feedId));

    return reply.status(200).send({ ok: true, imageUrl });
  });

  // Upload YouTube cookies for authenticated downloads
  app.post('/api/v1/youtube/cookies', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = cookiesSchema.parse(request.body);
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const cookiesPath = join(process.cwd(), 'cookies.txt');
    await writeFile(cookiesPath, body.cookies, 'utf-8');
    return reply.status(200).send({ ok: true, message: 'YouTube cookies saved' });
  });

  // Primary endpoint: add a YouTube video to personal library
  app.post('/api/v1/videos', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = addVideoSchema.parse(request.body);
    const result = await addYouTubeVideo({
      userId: request.userId!,
      url: body.url,
    });
    return reply.status(201).send(result);
  });

  app.post('/api/v1/assets/upload', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) throw new ValidationError('No file provided');

    if (!ACCEPTED_AUDIO_TYPES.includes(data.mimetype as any)) {
      throw new ValidationError(`Unsupported audio type: ${data.mimetype}`);
    }

    const licenseField = data.fields['licenseId'];
    const licenseId = (licenseField && 'value' in licenseField ? licenseField.value : String(licenseField)) as string;
    if (!licenseId) throw new ValidationError('licenseId is required');

    const buffer = await data.toBuffer();
    if (buffer.length > MAX_UPLOAD_SIZE) {
      throw new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`);
    }

    const asset = await uploadAsset({
      userId: request.userId!,
      licenseId,
      fileBuffer: buffer,
      filename: data.filename,
      mimeType: data.mimetype,
    });

    return reply.status(201).send(asset);
  });

  app.post('/api/v1/assets/stream-url', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = addStreamSchema.parse(request.body);
    const asset = await addStreamUrl({
      userId: request.userId!,
      ...body,
    });
    return reply.status(201).send(asset);
  });

  app.post('/api/v1/assets/youtube-meta', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const body = youtubeMetaSchema.parse(request.body);
    const meta = await fetchYouTubeMetadata({
      userId: request.userId!,
      ...body,
    });
    return reply.status(200).send(meta);
  });

  app.get('/api/v1/assets', {
    preHandler: [authMiddleware],
  }, async (request) => {
    return listAssets(request.userId!);
  });

  app.get('/api/v1/assets/:id', {
    preHandler: [authMiddleware],
  }, async (request) => {
    const { id } = request.params as { id: string };
    return getAsset(request.userId!, id);
  });

  app.delete('/api/v1/assets/:id', {
    preHandler: [authMiddleware],
  }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteAsset(request.userId!, id);
    return { ok: true };
  });
}
