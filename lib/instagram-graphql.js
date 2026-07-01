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
 * 
 * Subprocess Transport Layer:
 * - Axios is replaced with system curl subprocess calls to avoid node TLS fingerprint detection/blocking.
 * - Boots a live session using 'bootstrapSession()' once an hour to load cookies from instagram.com and bypass login walling.
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Module-level session state
const session = {
    cookies: null,
    csrftoken: null,
    bootstrappedAt: null,
    lsd: null
};

// Module-level cache
const cache = {
    docId: null,
    lastDiscoveredAt: null
};

/**
 * Retrieves static session credentials from environment variables if set.
 */
function getEnvCookies() {
  const sessionId = process.env.INSTAGRAM_SESSION_ID;
  const csrftoken = process.env.INSTAGRAM_CSRFTOKEN;
  if (sessionId && csrftoken) {
    return {
      cookies: `sessionid=${sessionId}; csrftoken=${csrftoken}`,
      csrftoken: csrftoken
    };
  }
  return null;
}

/**
 * Scans HTML response content for an active LSD token.
 */
function discoverLSD(html) {
    let match = html.match(/"LSD",\[\],\{"token":"([^"]+)"\}/);
    if (match && match[1]) {
        return match[1];
    }
    match = html.match(/lsd_token["\s:]+([A-Za-z0-9_-]+)/);
    if (match && match[1]) {
        return match[1];
    }
    return null;
}

/**
 * Executes system curl subprocess with supplied arguments.
 */
function runCurl(args, allowEmptyStdout = false) {
    return new Promise((resolve, reject) => {
        execFile('curl', args, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`curl process failed: ${error.message}. Stderr: ${stderr}`));
            } else if (!allowEmptyStdout && (stdout === null || stdout === undefined || stdout === '')) {
                reject(new Error("curl returned empty stdout"));
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Bootstraps an anonymous session by making a curl call to Instagram
 * and extracting the Set-Cookie values from the response header dump.
 */
async function bootstrapSession(url) {
    const timestamp = Date.now();
    const tempPath = `/tmp/ig_session_headers_${timestamp}.txt`;
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    
    const tempDir = path.dirname(tempPath);
    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    } catch (e) {
        // Ignore folder creation errors, curl will fail if path is invalid
    }

    const args = [
        "--silent",
        "--location",
        "--max-time", "15",
        "--http2",
        "--compressed",
        "-H", "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "--dump-header", tempPath,
        "-o", devNull,
        url
    ];

    try {
        // Allow empty stdout since output is written to devNull
        await runCurl(args, true);

        if (!fs.existsSync(tempPath)) {
            throw new Error(`Session headers file was not created at ${tempPath}`);
        }

        const headerText = fs.readFileSync(tempPath, 'utf8');
        const lines = headerText.split(/\r?\n/);
        const cookiesList = [];
        let csrftokenValue = null;

        for (const line of lines) {
            if (line.toLowerCase().startsWith('set-cookie:')) {
                const cookieContent = line.slice(11).trim();
                const parts = cookieContent.split(';');
                const firstPart = parts[0].trim();
                const eqIdx = firstPart.indexOf('=');
                if (eqIdx !== -1) {
                    const name = firstPart.slice(0, eqIdx).trim();
                    const value = firstPart.slice(eqIdx + 1).trim();
                    cookiesList.push(`${name}=${value}`);
                    if (name.toLowerCase() === 'csrftoken') {
                        csrftokenValue = value;
                    }
                }
            }
        }

        if (cookiesList.length === 0) {
            throw new Error("No Set-Cookie headers found in response");
        }

        const cookiesString = cookiesList.join('; ');
        session.cookies = cookiesString;
        session.csrftoken = csrftokenValue;
        session.bootstrappedAt = Date.now();

        const cookieNames = cookiesList.map(c => c.split('=')[0]);
        console.log(`Instagram session bootstrapped successfully, cookies: ${cookieNames.join(', ')}`);
        
        if (cookieNames.length < 3) {
            console.warn(`Warning: only received ${cookieNames.length} cookies from bootstrap, session may be incomplete`);
        }

        // Fetch actual HTML body of https://www.instagram.com/ to discover LSD token
        const lsdArgs = [
            "--silent",
            "--location",
            "--max-time", "15",
            "--http2",
            "--compressed",
            "-H", "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
            "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "-H", "Accept-Language: en-US,en;q=0.9",
            "https://www.instagram.com/"
        ];
        try {
            const html = await runCurl(lsdArgs);
            const lsdToken = discoverLSD(html);
            if (lsdToken) {
                session.lsd = lsdToken;
                console.log(`LSD token discovered: ${lsdToken}`);
            } else {
                session.lsd = null;
                console.log('LSD token not found, using fallback');
            }
        } catch (lsdErr) {
            session.lsd = null;
            console.log(`LSD token not found, using fallback: ${lsdErr.message}`);
        }
    } catch (err) {
        console.error(`Session bootstrap failed: ${err.message}`);
        throw new Error("session_bootstrap_failed");
    } finally {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch (cleanupErr) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Returns the current session state, bootstrapping it if null or older than 1 hour.
 * Fallback: proceeds without cookies on bootstrap failures.
 */
async function getSession(url) {
    const envCookies = getEnvCookies();
    if (envCookies) return envCookies;
    const isExpired = !session.bootstrappedAt || (Date.now() - session.bootstrappedAt > 60 * 60 * 1000);
    if (!session.cookies || isExpired) {
        try {
            await bootstrapSession(url);
        } catch (err) {
            console.error(`Session bootstrap failed during getSession: ${err.message}. Proceeding without cookies.`);
            return { cookies: null, csrftoken: null };
        }
    }
    return session;
}

/**
 * Performs a HTTP GET fetch using curl.
 */
async function fetchUrlWithCurl(url, timeoutSeconds = 20, contentUrl) {
    const activeSession = await getSession(contentUrl || url);
    const args = [
        "--silent",
        "--location",
        "--max-time", String(timeoutSeconds),
        "--http2",
        "--compressed",
        "-H", "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "Sec-Fetch-Site: same-origin",
        "-H", "Sec-Fetch-Mode: cors",
        "-H", "Sec-Fetch-Dest: empty"
    ];
    if (activeSession.cookies) {
        args.push("-H", `Cookie: ${activeSession.cookies}`);
    }
    if (activeSession.csrftoken) {
        args.push("-H", `X-CSRFToken: ${activeSession.csrftoken}`);
    }
    args.push(url);
    return runCurl(args);
}

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
async function discoverDocId(contentUrl) {
    console.log("Starting doc_id auto-discovery...");
    try {
        const html = await fetchUrlWithCurl("https://www.instagram.com/", 20, contentUrl);
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
                const jsContent = await fetchUrlWithCurl(url, 20, contentUrl);

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
 * Performs GraphQL request with the provided shortcode and doc_id using system curl.
 */
async function queryGraphQL(shortcode, docId, url) {
    const activeSession = await getSession(url);
    const args = [
        "--silent",
        "--location",
        "--max-time", "15",
        "--tlsv1.2",
        "--tls-max", "1.3",
        "--http2",
        "--compressed",
        "-X", "POST",
        "-H", "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "-H", "X-IG-App-ID: 936619743392459",
        "-H", `X-FB-LSD: ${activeSession.lsd || 'AVqbxe3J_YA'}`,
        "-H", "X-ASBD-ID: 129477",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-H", "Accept: */*",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "Origin: https://www.instagram.com",
        "-H", "Referer: https://www.instagram.com/",
        "-H", "Sec-Fetch-Site: same-origin",
        "-H", "Sec-Fetch-Mode: cors",
        "-H", "Sec-Fetch-Dest: empty"
    ];
    if (activeSession.cookies) {
        args.push("-H", `Cookie: ${activeSession.cookies}`);
    }
    if (activeSession.csrftoken) {
        args.push("-H", `X-CSRFToken: ${activeSession.csrftoken}`);
    }
    args.push(
        "--data-urlencode", `doc_id=${docId}`,
        "--data-urlencode", `variables={"shortcode":"${shortcode}"}`,
        "https://www.instagram.com/api/graphql"
    );
    
    const output = await runCurl(args);
    return JSON.parse(output);
}

/**
 * Resolves Instagram GraphQL data using either a Cloudflare Worker proxy (if INSTAGRAM_WORKER_URL is set)
 * or the direct curl fallback path.
 */
async function callGraphQL(shortcode, docId, url) {
  if (process.env.INSTAGRAM_WORKER_URL) {
    const workerUrl = process.env.INSTAGRAM_WORKER_URL;
    let host = workerUrl;
    try { host = new URL(workerUrl).host; } catch (e) {}
    console.log(`Using Cloudflare Worker for Instagram embed: ${host}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcode, lsd: session.lsd || 'AVqbxe3J_YA' }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.status !== 200) throw new Error(`Non-200 status code: ${res.status}`);
      const data = await res.json();
      if (data.error) { console.error(`Worker error: ${data.error} — preview: ${data.preview || ''}`); throw new Error(data.error); }
      if (!data.videoUrl) throw new Error('worker_missing_video_url');
      console.log('Worker responded successfully');
      return {
        __embedResult: true,
        formats: [{ url: data.videoUrl, ext: 'mp4', vcodec: 'h264', acodec: 'aac' }]
      };
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`Worker request failed: ${err.message}`);
      throw err;
    }
  } else {
    return queryGraphQL(shortcode, docId, url);
  }
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
            await discoverDocId(url);
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
        response = await callGraphQL(shortcode, cache.docId, url);
        
        // Validate response shape
        if (response && response.__embedResult) {
            return { id: shortcode, title: null, thumbnail: null, formats: response.formats };
        }
        if (response && response.data && (response.data.xdt_shortcode_media || response.data.shortcode_media)) {
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
            await discoverDocId(url);
            response = await callGraphQL(shortcode, cache.docId, url);
            if (response && response.__embedResult) {
                return { id: shortcode, title: null, thumbnail: null, formats: response.formats };
            }
            if (response && response.data && (response.data.xdt_shortcode_media || response.data.shortcode_media)) {
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
    
    // Check if the result already has formats array directly (new embed path) - if so, skip parsing block and return as-is
    if (response && response.formats) {
        return response;
    }
    
    // Parse GraphQL response to standard yt-dlp metadata format
    const media = response.data.xdt_shortcode_media || response.data.shortcode_media;
    
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
    cache,
    bootstrapSession,
    getSession,
    session
};
