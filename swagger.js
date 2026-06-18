const swaggerJSDoc = require('swagger-jsdoc');

// Dynamic base URL check with fallback to localhost:8000
const baseUrl = process.env.BASE_URL || 'http://localhost:8000';

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Media Extractor & Resolver API',
            version: '1.0.0',
            description: 'A robust Node.js Express API for extracting and downloading media (video, audio, images) from various social media and video hosting platforms including YouTube, Instagram, Twitter/X, and Facebook.',
            contact: {
                name: 'API Support',
                url: 'https://github.com/Arihanthuehue/Extractor-node-',
                email: 'support@example.com'
            }
        },
        servers: [
            {
                url: baseUrl,
                description: 'Dynamic server URL (configured via BASE_URL env)'
            }
        ]
    },
    // Files to scan for annotations
    apis: [
        './swagger.js',
        './routes/*.js',
        './routes/index.js'
    ]
};

const swaggerSpec = swaggerJSDoc(options);

module.exports = swaggerSpec;

/**
 * @openapi
 * tags:
 *   - name: System
 *     description: Service health and system diagnostics
 *   - name: Extraction
 *     description: Media resolution and link extraction services
 *   - name: Delivery
 *     description: Direct download proxying and file streaming services
 */

/**
 * @openapi
 * components:
 *   schemas:
 *     HealthCheckResponse:
 *       type: object
 *       required:
 *         - status
 *         - timestamp
 *       properties:
 *         status:
 *           type: string
 *           description: Current operational status of the service
 *           example: healthy
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: ISO timestamp of when the status was checked
 *           example: "2026-06-18T13:04:10.000Z"
 * 
 *     ErrorResponse:
 *       type: object
 *       required:
 *         - success
 *         - error
 *       properties:
 *         success:
 *           type: boolean
 *           description: Always false for failed resolutions
 *           example: false
 *         error:
 *           type: string
 *           description: Normalized error message representing the failure reason
 *           enum:
 *             - private_post
 *             - invalid_url
 *             - resolve_failed
 *             - youtube_blocked
 *           example: invalid_url
 * 
 *     MediaMetadata:
 *       type: object
 *       required:
 *         - index
 *         - type
 *         - preview_url
 *         - thumbnail_url
 *         - needs_merge
 *       properties:
 *         index:
 *           type: integer
 *           description: Zero-based index of the media item
 *           example: 0
 *         type:
 *           type: string
 *           description: Media type (video or image)
 *           enum:
 *             - video
 *             - image
 *           example: video
 *         preview_url:
 *           type: string
 *           description: Proxy URL to stream or download the resolved media
 *           example: "http://localhost:8000/file/5a54b39e6a9f4c3cb3e2b260f8d16790"
 *         thumbnail_url:
 *           type: string
 *           description: Original thumbnail URL from the source platform
 *           example: "https://example.com/thumbnail.jpg"
 *         needs_merge:
 *           type: boolean
 *           description: Indicates if video and audio files need on-the-fly merging on download
 *           example: false
 *         video_url:
 *           type: string
 *           nullable: true
 *           description: Direct source video-only stream URL (null if no merge is needed or already resolved)
 *           example: null
 *         audio_url:
 *           type: string
 *           nullable: true
 *           description: Direct source audio-only stream URL (null if no merge is needed or already resolved)
 *           example: null
 * 
 *     SuccessResponse:
 *       type: object
 *       required:
 *         - success
 *         - post_id
 *         - is_carousel
 *         - items
 *       properties:
 *         success:
 *           type: boolean
 *           description: Always true for successful resolutions
 *           example: true
 *         post_id:
 *           type: string
 *           description: Unique post or video identifier from the source platform
 *           example: C7y4G19uxyA
 *         is_carousel:
 *           type: boolean
 *           description: True if the post contains a slideshow/carousel of multiple media items
 *           example: false
 *         items:
 *           type: array
 *           description: List of resolved media objects
 *           items:
 *             $ref: '#/components/schemas/MediaMetadata'
 * 
 *     ExtractionResult:
 *       type: object
 *       required:
 *         - success
 *         - post_id
 *         - is_carousel
 *         - items
 *       properties:
 *         success:
 *           type: boolean
 *           description: Always true for successful resolutions
 *           example: true
 *         post_id:
 *           type: string
 *           description: Unique post or video identifier from the source platform
 *           example: C7y4G19uxyA
 *         is_carousel:
 *           type: boolean
 *           description: True if the post contains a slideshow/carousel of multiple media items
 *           example: false
 *         items:
 *           type: array
 *           description: List of resolved media objects
 *           items:
 *             $ref: '#/components/schemas/MediaMetadata'
 */
