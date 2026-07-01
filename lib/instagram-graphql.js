/**
 * lib/instagram-graphql.js
 * 
 * This module resolves Instagram posts/reels using Instagram's internal GraphQL API.
 * The GraphQL query requires a dynamic 'doc_id', which is auto-discovered from 
 * Instagram's public web bundles and cached.
 * 
 * Caching Strategy:
 * - Dynamically discovered doc_id is cached at the module level.
 * - Refreshed every 24 hours or upon encountering an unexpected GraphQL response shape (self-healing).
 * - If discovery fails, the module falls back to the last known cached doc_id (if available) before failing.
 * - If the query continues to fail, it throws 'graphql_resolve_failed' so the caller can fall back to yt-dlp.
 * 
 * Note: This self-healing mechanism can still break if Instagram changes its web bundle naming
 * conventions or obfuscation patterns enough to invalidate the regex, in which case the regex
 * patterns in discoverDocId() must be manually updated.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const APP_ID = "936619743392459"; // Instagram public web client App ID

// Module-level cache
const cache = {
    docId: null,
    lastDiscoveredAt: null
};

/**
 * Normalizes and extracts shortcode from an Instagram URL.
 */
function getShortcode(url) {
    try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2 && (pathParts[0] === 'p' || pathParts[0] === 'reel' || pathParts[0] === 'tv')) {
            return pathParts[1];
        }
    } catch (e) {
        // Fallback to regex
    }
    const match = url.match(/\/p\/([A-Za-z0-9_-]+)/) || url.match(/\/reel\/([A-Za-z0-9_-]+)/) || url.match(/\/tv\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

/**
 * Scans Instagram web bundles to discover and cache the current GraphQL doc_id.
 */
async function discoverDocId() {
    console.log("Starting doc_id auto-discovery...");
    try {
        const response = await axios.get("https://www.instagram.com/", {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            timeout: 10000
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // Find linked JS bundles in <script src="...">
        const scriptUrls = [];
        $('script[src]').each((i, el) => {
            const src = $(el).attr('src');
            if (src && (src.includes("static.cdninstagram.com") || src.includes("instagram.com"))) {
                scriptUrls.push(src);
            }
        });

        // Scan inline scripts for any referenced JS bundle URLs (escaped or unescaped)
        const inlineText = $('script:not([src])').text();
        const extraUrls = inlineText.match(/https:\\?\/\\?\/static\.cdninstagram\.com\\?\/[^"'\s]*?\.js/g) || [];
        
        // Normalize slashes and deduplicate
        const allUrls = Array.from(new Set([
            ...scriptUrls,
            ...extraUrls.map(url => url.replace(/\\/g, ''))
        ]));

        if (allUrls.length === 0) {
            console.error("No script bundles found in Instagram response HTML");
            throw new Error("docid_discovery_failed");
        }

        console.log(`Discovered ${allUrls.length} unique script bundles. Scanning...`);

        // Patterns to match numeric doc_id (15-20 digits) near shortcode queries
        const patterns = [
            /"([0-9]{15,20})"[^}]{0,200}(?:PolarisPostActionLoadPostQuery|shortcode_media)/,
            /(?:PolarisPostActionLoadPostQuery|shortcode_media)[^}]{0,200}"([0-9]{15,20})"/,
            /"([0-9]{15,20})"[^}]{0,200}xdt_shortcode_media/,
            /xdt_shortcode_media[^}]{0,200}"([0-9]{15,20})"/
        ];

        let foundDocId = null;

        // Helper to fetch and scan a single URL
        async function checkUrl(url) {
            if (foundDocId) return;
            try {
                const jsRes = await axios.get(url, {
                    headers: { "User-Agent": USER_AGENT },
                    timeout: 8000
                });
                const jsContent = jsRes.data;

                for (let i = 0; i < patterns.length; i++) {
                    const match = jsContent.match(patterns[i]);
                    if (match && match[1]) {
                        foundDocId = match[1];
                        return;
                    }
                }
            } catch (err) {
                // Ignore download / scan errors for individual bundles
            }
        }

        // 1. Scan linked scripts first (usually 6 core script tags)
        console.log(`Scanning initial ${scriptUrls.length} linked bundles...`);
        for (const url of scriptUrls) {
            await checkUrl(url);
            if (foundDocId) break;
        }

        // 2. If not found, scan remaining dynamic bundles in parallel batches
        if (!foundDocId) {
            const remainingUrls = allUrls.filter(url => !scriptUrls.includes(url));
            console.log(`Scanning remaining ${remainingUrls.length} dynamic bundles in batches...`);
            const batchSize = 35;
            for (let i = 0; i < remainingUrls.length; i += batchSize) {
                if (foundDocId) break;
                const batch = remainingUrls.slice(i, i + batchSize);
                await Promise.all(batch.map(url => checkUrl(url)));
            }
        }

        if (foundDocId) {
            console.log(`doc_id auto-discovered successfully: ${foundDocId}`);
            cache.docId = foundDocId;
            cache.lastDiscoveredAt = Date.now();
            return foundDocId;
        }

        throw new Error("docid_discovery_failed");
    } catch (e) {
        console.error(`doc_id discovery failed: ${e.message}`);
        throw new Error("docid_discovery_failed");
    }
}

/**
 * Performs GraphQL request with the provided shortcode and doc_id.
 */
async function queryGraphQL(shortcode, docId) {
    const params = new URLSearchParams();
    params.append('doc_id', docId);
    params.append('variables', JSON.stringify({ shortcode }));

    return axios.post("https://www.instagram.com/graphql/query", params, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
            "X-IG-App-ID": APP_ID,
            "Origin": "https://www.instagram.com",
            "Referer": `https://www.instagram.com/p/${shortcode}/`
        },
        timeout: 15000
    });
}

/**
 * Resolves Instagram post/reel details using the cached/discovered doc_id.
 */
async function resolveInstagramGraphQL(url) {
    const shortcode = getShortcode(url);
    if (!shortcode) {
        throw new Error("invalid_url");
    }

    const isCacheExpired = !cache.lastDiscoveredAt || (Date.now() - cache.lastDiscoveredAt > 24 * 60 * 60 * 1000);

    if (!cache.docId || isCacheExpired) {
        try {
            await discoverDocId();
        } catch (discoveryErr) {
            if (cache.docId) {
                console.warn(`doc_id discovery failed, using stale cached value: ${cache.docId}`);
            } else {
                console.error('doc_id discovery failed, no cached value available');
                throw new Error("graphql_resolve_failed");
            }
        }
    } else {
        console.log('doc_id cache hit');
    }

    let response;
    let success = false;

    try {
        response = await queryGraphQL(shortcode, cache.docId);
        
        // Validate response shape
        if (response.data && response.data.data && (response.data.data.xdt_shortcode_media || response.data.data.shortcode_media)) {
            success = true;
        }
    } catch (reqErr) {
        console.warn(`GraphQL query attempt failed: ${reqErr.message}`);
    }

    // Self-healing flow: If response shape unexpected, invalidate cache and retry once
    if (!success) {
        console.log("Unexpected response shape or network error. Invalidating cache and retrying once...");
        cache.docId = null;
        cache.lastDiscoveredAt = null;

        try {
            await discoverDocId();
            response = await queryGraphQL(shortcode, cache.docId);
            if (response.data && response.data.data && (response.data.data.xdt_shortcode_media || response.data.data.shortcode_media)) {
                success = true;
            }
        } catch (retryErr) {
            console.error(`Retry attempt failed: ${retryErr.message}`);
        }

        if (!success) {
            console.error('GraphQL resolve failed after doc_id refresh retry');
            throw new Error("graphql_resolve_failed");
        }
    }

    console.log(`GraphQL resolve succeeded using doc_id ${cache.docId}`);
    
    // Parse GraphQL response to standard yt-dlp metadata format
    const media = response.data.data.xdt_shortcode_media || response.data.data.shortcode_media;
    
    // Extract title (caption)
    let title = null;
    if (media.edge_media_to_caption && media.edge_media_to_caption.edges && media.edge_media_to_caption.edges[0]) {
        title = media.edge_media_to_caption.edges[0].node.text;
    }

    // Case 1: Carousel / Sidecar Post
    if (media.edge_sidecar_to_children && media.edge_sidecar_to_children.edges) {
        const entries = media.edge_sidecar_to_children.edges.map((edge, idx) => {
            const node = edge.node;
            const isVideo = node.is_video || node.__typename === 'GraphVideo';
            return {
                id: node.shortcode || node.id || `${media.shortcode}_${idx}`,
                thumbnail: node.display_url,
                url: isVideo ? null : node.display_url,
                formats: isVideo ? [
                    {
                        url: node.video_url,
                        ext: "mp4",
                        vcodec: "h264",
                        acodec: "aac"
                    }
                ] : []
            };
        });

        return {
            id: media.shortcode,
            title: title,
            thumbnail: media.display_url,
            entries: entries
        };
    }

    // Case 2: Single Video Post
    if (media.is_video || media.__typename === 'GraphVideo') {
        return {
            id: media.shortcode,
            title: title,
            thumbnail: media.display_url,
            formats: [
                {
                    url: media.video_url,
                    ext: "mp4",
                    vcodec: "h264",
                    acodec: "aac"
                }
            ]
        };
    }

    // Case 3: Single Image Post
    return {
        id: media.shortcode,
        title: title,
        thumbnail: media.display_url,
        url: media.display_url,
        formats: []
    };
}

module.exports = {
    discoverDocId,
    resolveInstagramGraphQL,
    cache
};
