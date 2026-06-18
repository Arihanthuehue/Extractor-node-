const express = require('express');
const router = express.Router();
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');
const crypto = require('crypto');

const { tokenMapping, deleteTokenFile } = require('../lib/state');
const { extractMetadata } = require('../lib/ytdlp');
const { mergeVideoAudio, downloadVideoToTempFile } = require('../lib/ffmpeg');
const { mapInstagramError, mapYoutubeError } = require('../lib/errors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Normalizes input URL or iframe/blockquote embeds into direct target URLs.
 * Replicates parse_input_to_url in main.py.
 */
function parseInputToUrl(inputStr) {
    inputStr = (inputStr || "").trim();
    if (!inputStr) {
        throw new Error("invalid_url");
    }

    // Check if direct URL
    if (inputStr.startsWith("http://") || inputStr.startsWith("https://")) {
        try {
            const parsed = new URL(inputStr);
            const host = parsed.hostname.toLowerCase();

            if (host.includes("youtube.com") || host.includes("youtu.be")) {
                if (host.includes("youtube.com")) {
                    if (parsed.pathname.startsWith("/shorts/")) {
                        const videoId = parsed.pathname.split("/")[2].split("?")[0];
                        return `https://www.youtube.com/watch?v=${videoId}`;
                    } else if (parsed.pathname.startsWith("/watch")) {
                        const v = parsed.searchParams.get("v");
                        if (v) {
                            return `https://www.youtube.com/watch?v=${v}`;
                        }
                    } else if (parsed.pathname.startsWith("/embed/")) {
                        const videoId = parsed.pathname.split("/")[2].split("?")[0];
                        return `https://www.youtube.com/watch?v=${videoId}`;
                    }
                } else if (host.includes("youtu.be")) {
                    const videoId = parsed.pathname.replace(/^\/+/, "").split("?")[0].split("/")[0];
                    return `https://www.youtube.com/watch?v=${videoId}`;
                }
            }

            if (host.includes("facebook.com")) {
                const v = parsed.searchParams.get("v");
                const newParams = new URLSearchParams();
                if (v) {
                    newParams.set("v", v);
                }
                const newQuery = newParams.toString();
                const newQueryStr = newQuery ? `?${newQuery}` : '';
                // Assemble back exactly like urlunparse to preserve the clean URL
                return `${parsed.protocol}//${parsed.host}${parsed.pathname}${newQueryStr}${parsed.hash}`;
            }

            if (host.includes("linkedin.com")) {
                let pathname = parsed.pathname;
                if (pathname.includes("/embed/feed/update/")) {
                    pathname = pathname.replace("/embed/feed/update/", "/feed/update/");
                }
                return `${parsed.protocol}//${parsed.host}${pathname}`;
            }
        } catch (e) {
            // Ignore parse errors and let the split fallback run
        }
        return inputStr.split("?")[0];
    }

    // Parse as embed HTML
    let $;
    try {
        // load will throw on totally invalid input, BS4 just parses it
        $ = cheerio.load(inputStr);
    } catch (e) {
        throw new Error("invalid_url");
    }

    // Check for YouTube iframe embed
    const iframe = $('iframe[src]');
    if (iframe.length > 0) {
        const src = iframe.first().attr('src').trim();
        if (src.includes("youtube.com") || src.includes("youtu.be")) {
            let srcUrl = src;
            if (srcUrl.startsWith("//")) {
                srcUrl = "https:" + srcUrl;
            } else if (!srcUrl.startsWith("http://") && !srcUrl.startsWith("https://")) {
                srcUrl = "https://" + srcUrl;
            }
            return parseInputToUrl(srcUrl);
        }
    }

    // Check for LinkedIn iframe embed
    if (iframe.length > 0) {
        const src = iframe.first().attr('src').trim();
        if (src.includes("linkedin.com")) {
            let srcUrl = src;
            if (srcUrl.startsWith("//")) {
                srcUrl = "https:" + srcUrl;
            } else if (!srcUrl.startsWith("http://") && !srcUrl.startsWith("https://")) {
                srcUrl = "https://" + srcUrl;
            }
            return parseInputToUrl(srcUrl);
        }
    }

    // Check for Facebook iframe embed
    if (iframe.length > 0) {
        const src = iframe.first().attr('src').trim();
        if (src.includes("facebook.com")) {
            try {
                const parsedSrc = new URL(src);
                const href = parsedSrc.searchParams.get("href");
                if (href) {
                    const extractedUrl = decodeURIComponent(href).trim();
                    return parseInputToUrl(extractedUrl);
                }
            } catch (e) {
                // pass
            }
            throw new Error("invalid_url");
        }
    }

    // Check for Twitter/X blockquote embed
    const blockquoteTw = $('blockquote.twitter-tweet');
    if (blockquoteTw.length > 0) {
        const aTags = blockquoteTw.find('a[href]');
        if (aTags.length > 0) {
            const extractedUrl = aTags.last().attr('href').trim();
            return parseInputToUrl(extractedUrl);
        }
        throw new Error("invalid_url");
    }

    // Look for data-instgrm-permalink
    const instgrmBlockquote = $('[data-instgrm-permalink]');
    if (instgrmBlockquote.length > 0) {
        const url = instgrmBlockquote.attr('data-instgrm-permalink');
        if (url) {
            return url.split("?")[0];
        }
    }

    // Fallback to first matching <a> tag
    const aTags = $('a[href]');
    for (let i = 0; i < aTags.length; i++) {
        const href = $(aTags[i]).attr('href');
        if (href.includes("instagram.com/p/") || href.includes("instagram.com/reel/") || href.includes("instagram.com/tv/")) {
            return href.split("?")[0];
        }
    }

    throw new Error("invalid_url");
}

/**
 * Evaluates standard entry metadata formats to extract urls and type.
 * Replicates process_yt_dlp_item in main.py.
 */
function processYtDlpItem(entry) {
    const formats = entry.formats || [];
    let isVideo = false;

    // Check if there is any indication of it being a video
    if (formats.length > 0) {
        for (const f of formats) {
            const vcodec = f.vcodec;
            if (vcodec !== undefined && vcodec !== null && vcodec !== 'none') {
                isVideo = true;
                break;
            }
        }
    } else {
        const vcodec = entry.vcodec;
        if (vcodec !== undefined && vcodec !== null && vcodec !== 'none') {
            isVideo = true;
        }
    }

    const ext = entry.ext;
    if (['mp4', 'm4v', 'webm', 'mov'].includes(ext)) {
        isVideo = true;
    }

    if (isVideo) {
        // 1. First look for format with both vcodec != 'none' AND acodec != 'none'
        const combinedFormats = [];
        for (const f of formats) {
            const vcodec = f.vcodec;
            const acodec = f.acodec;
            if (vcodec !== undefined && vcodec !== null && vcodec !== 'none' &&
                acodec !== undefined && acodec !== null && acodec !== 'none') {
                combinedFormats.push(f);
            }
        }

        if (combinedFormats.length > 0) {
            // Sort by quality: height descending, then total bitrate (tbr) descending
            combinedFormats.sort((a, b) => {
                const heightA = a.height || 0;
                const heightB = b.height || 0;
                if (heightB !== heightA) {
                    return heightB - heightA;
                }
                const tbrA = a.tbr || 0;
                const tbrB = b.tbr || 0;
                return b.tbr - a.tbr;
            });
            const previewUrl = combinedFormats[0].url;
            return {
                type: "video",
                preview_url: previewUrl,
                needs_merge: false,
                video_url: null,
                audio_url: null
            };
        }

        // 2. Find best video-only and best audio-only separately
        const videoOnlyFormats = [];
        const audioOnlyFormats = [];
        for (const f of formats) {
            const vcodec = f.vcodec;
            const acodec = f.acodec;
            const isV = vcodec !== undefined && vcodec !== null && vcodec !== 'none';
            const isA = acodec !== undefined && acodec !== null && acodec !== 'none';
            if (isV && !isA) {
                videoOnlyFormats.push(f);
            } else if (isA && !isV) {
                audioOnlyFormats.push(f);
            }
        }

        if (videoOnlyFormats.length > 0 && audioOnlyFormats.length > 0) {
            videoOnlyFormats.sort((a, b) => {
                const heightA = a.height || 0;
                const heightB = b.height || 0;
                if (heightB !== heightA) {
                    return heightB - heightA;
                }
                const tbrA = a.tbr || 0;
                const tbrB = b.tbr || 0;
                return tbrB - tbrA;
            });

            audioOnlyFormats.sort((a, b) => {
                const tbrA = a.tbr || a.abr || 0;
                const tbrB = b.tbr || b.abr || 0;
                return tbrB - tbrA;
            });

            const videoUrl = videoOnlyFormats[0].url;
            const audioUrl = audioOnlyFormats[0].url;

            return {
                type: "video",
                preview_url: videoUrl,
                needs_merge: true,
                video_url: videoUrl,
                audio_url: audioUrl
            };
        }

        // 3. Ultimate fallback
        let previewUrl = entry.url;
        if (!previewUrl && formats.length > 0) {
            previewUrl = formats[formats.length - 1].url;
        }
        return {
            type: "video",
            preview_url: previewUrl,
            needs_merge: false,
            video_url: null,
            audio_url: null
        };
    } else {
        let previewUrl = entry.url;
        if (!previewUrl && formats.length > 0) {
            previewUrl = formats[formats.length - 1].url;
        }
        return {
            type: "image",
            preview_url: previewUrl,
            needs_merge: false,
            video_url: null,
            audio_url: null
        };
    }
}

/**
 * @openapi
 * /health:
 *   get:
 *     tags:
 *       - System
 *     summary: Check service health status
 *     description: Returns the current operational status of the media extractor service along with a timestamp.
 *     responses:
 *       200:
 *         description: Service is healthy and operational
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthCheckResponse'
 *       500:
 *         description: Service is unhealthy or encountered an error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/health', (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString()
    });
});

/**
 * @openapi
 * /file/{token}:
 *   get:
 *     tags:
 *       - Delivery
 *     summary: Stream cached media file
 *     description: Streams a locally cached video/audio file associated with a unique token. The file is automatically cleaned up and deleted from the server 1 hour after creation.
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         description: The unique security token generated when the media was resolved/extracted
 *         schema:
 *           type: string
 *           example: 5a54b39e6a9f4c3cb3e2b260f8d16790
 *       - name: filename
 *         in: query
 *         required: false
 *         description: Custom filename to return in the Content-Disposition header
 *         schema:
 *           type: string
 *           example: tutorial.mp4
 *     responses:
 *       200:
 *         description: Media file stream (attachment)
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *               example: attachment; filename="video.mp4"
 *           Content-Type:
 *             schema:
 *               type: string
 *               example: video/mp4
 *           Content-Length:
 *             schema:
 *               type: integer
 *               example: 10485760
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: File not found on disk, expired, or invalid token
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: File not found or expired
 */
router.get('/file/:token', async (req, res) => {
    const { token } = req.params;
    const { filename } = req.query;

    const entry = tokenMapping[token];
    if (!entry) {
        return res.status(404).send("File not found or expired");
    }

    const now = Date.now();
    if (now - entry.created_at > 3600 * 1000) {
        deleteTokenFile(token);
        return res.status(404).send("File not found or expired");
    }

    const tmpPath = entry.path;
    if (!fs.existsSync(tmpPath)) {
        return res.status(404).send("File not found on disk");
    }

    const fileSize = fs.statSync(tmpPath).size;
    const fn = filename || "video.mp4";

    res.writeHead(200, {
        "Content-Disposition": `attachment; filename="${fn}"`,
        "Content-Type": "video/mp4",
        "Content-Length": fileSize
    });

    const stream = fs.createReadStream(tmpPath, { highWaterMark: 65536 });
    stream.on('error', (err) => {
        console.error("Error streaming temp file:", err.message);
    });
    stream.pipe(res);
});

/**
 * @openapi
 * /extract:
 *   post:
 *     tags:
 *       - Extraction
 *     summary: Resolve and extract media links
 *     description: Extracts media metadata (video/audio stream links, previews, thumbnails, carousel posts) from a provided YouTube, Instagram, Twitter/X, or Facebook URL. If the video streams require merging (separate video/audio), it downloads, merges using ffmpeg on-the-fly, caches the file locally, and returns a local download link.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - input
 *             properties:
 *               input:
 *                 type: string
 *                 description: The URL of the video/post, or embed HTML code (such as blockquotes, iframes).
 *                 example: https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *     responses:
 *       200:
 *         description: Media successfully resolved
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               SuccessExample:
 *                 summary: Single Video Success Response
 *                 value:
 *                   success: true
 *                   post_id: dQw4w9WgXcQ
 *                   is_carousel: false
 *                   items:
 *                     - index: 0
 *                       type: video
 *                       preview_url: http://localhost:8000/file/5a54b39e6a9f4c3cb3e2b260f8d16790
 *                       thumbnail_url: https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg
 *                       needs_merge: false
 *                       video_url: null
 *                       audio_url: null
 *               ErrorExample:
 *                 summary: Invalid URL Response
 *                 value:
 *                   success: false
 *                   error: invalid_url
 *       400:
 *         description: Bad request input parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Post or video was not found or is private
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Blocked by the target platform or too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Resolution or internal processing failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/extract', async (req, res) => {
    const input = req.body.input;
    try {
        const resolvedUrl = parseInputToUrl(input);
        console.log(`Resolved URL: ${resolvedUrl}`);

        const isYoutube = resolvedUrl.includes("youtube.com") || resolvedUrl.includes("youtu.be");
        let info;
        try {
            info = await extractMetadata(resolvedUrl, isYoutube, global.youtubeCookiesPath);
        } catch (ytdlErr) {
            const stderr = ytdlErr.message;
            if (isYoutube) {
                throw new Error(mapYoutubeError(stderr));
            } else {
                throw new Error(mapInstagramError(stderr));
            }
        }

        const rawEntries = info.entries;
        const entries = Array.isArray(rawEntries) ? rawEntries : null;

        const isCarousel = entries !== null && entries.length > 1;
        let postId = info.id;
        if (!postId) {
            const parts = resolvedUrl.replace(/\/+$/, '').split('/');
            postId = parts[parts.length - 1];
        }

        const items = [];

        if (entries !== null && entries.length > 0) {
            for (let idx = 0; idx < entries.length; idx++) {
                const entry = entries[idx];
                const itemDetails = processYtDlpItem(entry);
                if (!itemDetails.preview_url) {
                    continue;
                }

                const thumbnailUrl = entry.thumbnail || itemDetails.preview_url;

                let previewUrl = itemDetails.preview_url;
                let needsMerge = itemDetails.needs_merge;
                let videoUrl = itemDetails.video_url;
                let audioUrl = itemDetails.audio_url;

                if (itemDetails.type === "video") {
                    try {
                        const isTwitter = resolvedUrl.includes("twitter.com") || resolvedUrl.includes("x.com");
                        const isM3U8 = previewUrl && previewUrl.toLowerCase().includes("m3u8");

                        let tmpPath;
                        if (isTwitter && isM3U8) {
                            tmpPath = await mergeVideoAudio(previewUrl, previewUrl, USER_AGENT);
                        } else if (needsMerge) {
                            tmpPath = await mergeVideoAudio(videoUrl, audioUrl, USER_AGENT);
                        } else {
                            tmpPath = await downloadVideoToTempFile(previewUrl, USER_AGENT);
                        }

                        const token = crypto.randomBytes(16).toString('hex');
                        tokenMapping[token] = { path: tmpPath, created_at: Date.now() };

                        // Deletes the file automatically after 1 hour (3600 seconds)
                        setTimeout(() => {
                            deleteTokenFile(token);
                        }, 3600 * 1000);

                        previewUrl = `${global.baseUrl}/file/${token}`;
                        needsMerge = false;
                        videoUrl = null;
                        audioUrl = null;
                    } catch (e) {
                        console.error(`Failed to download/merge video item ${idx}:`, e.message);
                        throw new Error("resolve_failed");
                    }
                }

                items.push({
                    index: idx,
                    type: itemDetails.type,
                    preview_url: previewUrl,
                    thumbnail_url: thumbnailUrl,
                    needs_merge: needsMerge,
                    video_url: videoUrl,
                    audio_url: audioUrl
                });
            }
        } else {
            const itemDetails = processYtDlpItem(info);
            if (!itemDetails.preview_url) {
                console.error(`DEBUG resolve_failed context: entries_is_none=${entries === null}, entries_len=${entries ? entries.length : 'n/a'}, info_keys=${Object.keys(info)}, item_details=${JSON.stringify(itemDetails)}`);
                throw new Error("resolve_failed");
            }

            const thumbnailUrl = info.thumbnail || itemDetails.preview_url;

            let previewUrl = itemDetails.preview_url;
            let needsMerge = itemDetails.needs_merge;
            let videoUrl = itemDetails.video_url;
            let audioUrl = itemDetails.audio_url;

            if (itemDetails.type === "video") {
                try {
                    const isTwitter = resolvedUrl.includes("twitter.com") || resolvedUrl.includes("x.com");
                    const isM3U8 = previewUrl && previewUrl.toLowerCase().includes("m3u8");

                    let tmpPath;
                    if (isTwitter && isM3U8) {
                        tmpPath = await mergeVideoAudio(previewUrl, previewUrl, USER_AGENT);
                    } else if (needsMerge) {
                        tmpPath = await mergeVideoAudio(videoUrl, audioUrl, USER_AGENT);
                    } else {
                        tmpPath = await downloadVideoToTempFile(previewUrl, USER_AGENT);
                    }

                    const token = crypto.randomBytes(16).toString('hex');
                    tokenMapping[token] = { path: tmpPath, created_at: Date.now() };

                    setTimeout(() => {
                        deleteTokenFile(token);
                    }, 3600 * 1000);

                    previewUrl = `${global.baseUrl}/file/${token}`;
                    needsMerge = false;
                    videoUrl = null;
                    audioUrl = null;
                } catch (e) {
                    console.error("Failed to download/merge single video:", e.message);
                    throw new Error("resolve_failed");
                }
            }

            items.push({
                index: 0,
                type: itemDetails.type,
                preview_url: previewUrl,
                thumbnail_url: thumbnailUrl,
                needs_merge: needsMerge,
                video_url: videoUrl,
                audio_url: audioUrl
            });
        }

        if (items.length === 0) {
            console.error(`DEBUG resolve_failed context: entries_is_none=${entries === null}, entries_len=${entries ? entries.length : 'n/a'}, info_keys=${Object.keys(info)}`);
            throw new Error("resolve_failed");
        }

        return res.json({
            success: true,
            post_id: postId,
            is_carousel: isCarousel,
            items: items
        });

    } catch (err) {
        let errMsg = err.message;
        const knownErrors = ["private_post", "invalid_url", "resolve_failed", "youtube_blocked"];
        if (!knownErrors.includes(errMsg)) {
            errMsg = "resolve_failed";
        }
        console.error(`Extraction failed for input: ${input}. Error: ${errMsg}`, err.message);
        return res.json({
            success: false,
            error: errMsg
        });
    }
});

/**
 * @openapi
 * /download:
 *   get:
 *     tags:
 *       - Delivery
 *     summary: Proxy stream or merge and download media files
 *     description: Streams a direct media file from a source URL to circumvent CORS restrictions. If `audio_url` is provided for a `video` type, this endpoint uses ffmpeg on-the-fly to merge the separate video and audio streams into a single file and streams it directly to the response, deleting the temporary merged file immediately after the stream closes.
 *     parameters:
 *       - name: url
 *         in: query
 *         required: true
 *         description: The target media (video or image) URL to download/stream
 *         schema:
 *           type: string
 *           format: uri
 *           example: https://example.com/video_only.mp4
 *       - name: type
 *         in: query
 *         required: true
 *         description: The type of media being fetched
 *         schema:
 *           type: string
 *           enum: [video, image]
 *           example: video
 *       - name: filename
 *         in: query
 *         required: false
 *         description: The custom filename to serve the download with
 *         schema:
 *           type: string
 *           example: custom_name.mp4
 *       - name: audio_url
 *         in: query
 *         required: false
 *         description: The audio stream URL to merge with the video (only applicable for type=video)
 *         schema:
 *           type: string
 *           format: uri
 *           example: https://example.com/audio_only.m4a
 *     responses:
 *       200:
 *         description: Streamed media file (attachment)
 *         content:
 *           video/mp4:
 *             schema:
 *               type: string
 *               format: binary
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Missing required query parameters (url and type)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Missing required query parameters: url and type"
 *       500:
 *         description: Direct streaming failed or ffmpeg merge failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "ffmpeg merge failed: exit status 1"
 */
router.get('/download', async (req, res) => {
    const { url, type, filename, audio_url } = req.query;

    if (!url || !type) {
        return res.status(400).json({ error: "Missing required query parameters: url and type" });
    }

    const resolvedFilename = filename || (type === "video" ? "download.mp4" : "download.jpg");

    // MERGE PATH
    if (audio_url && type === "video") {
        console.log(`Merging video (${url}) + audio (${audio_url}) ...`);
        let tmpPath;
        try {
            tmpPath = await mergeVideoAudio(url, audio_url, USER_AGENT);
        } catch (exc) {
            console.error("ffmpeg merge error:", exc.message);
            return res.status(500).json({ error: `ffmpeg merge failed: ${exc.message}` });
        }

        const fileSize = fs.statSync(tmpPath).size;
        res.writeHead(200, {
            "Content-Disposition": `attachment; filename="${resolvedFilename}"`,
            "Content-Type": "video/mp4",
            "Content-Length": fileSize
        });

        const stream = fs.createReadStream(tmpPath, { highWaterMark: 65536 });
        stream.pipe(res);

        // Schedule deletion on response close/finish (equivalent to BackgroundTasks)
        res.on('close', () => {
            try {
                if (fs.existsSync(tmpPath)) {
                    fs.unlinkSync(tmpPath);
                    console.log(`Deleted /download temp file: ${tmpPath}`);
                }
            } catch (err) {
                console.warn(`Could not delete temp file ${tmpPath}:`, err.message);
            }
        });
        return;
    }

    // DIRECT PATH
    try {
        console.log(`Proxy streaming direct download: ${url}`);
        const response = await axios({
            url: url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': USER_AGENT
            }
        });

        let contentType = response.headers['content-type'];
        if (!contentType) {
            contentType = type === "video" ? "video/mp4" : "image/jpeg";
        }
        const contentLength = response.headers['content-length'];

        res.setHeader("Content-Disposition", `attachment; filename="${resolvedFilename}"`);
        res.setHeader("Content-Type", contentType);
        if (contentLength) {
            res.setHeader("Content-Length", contentLength);
        }

        response.data.pipe(res);

        response.data.on('error', (err) => {
            console.error("Proxy streaming error:", err.message);
        });

    } catch (e) {
        console.error("Download connection error:", e.message);
        return res.status(500).json({
            error: `Failed to retrieve source media: ${e.message}`
        });
    }
});

module.exports = router;
