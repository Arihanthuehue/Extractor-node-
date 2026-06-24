const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Extracts metadata for a URL using the yt-dlp binary.
 * @param {string} url Normalized target URL
 * @param {boolean} isYoutube Whether the URL is for YouTube
 * @returns {Promise<object>} Parsed metadata object
 */
function extractMetadata(url, isYoutube) {
    return new Promise((resolve, reject) => {
        const ytdlpBinary = process.env.YTDLP_PATH || 'yt-dlp';
        const args = ['--dump-single-json', '--skip-download', '--verbose'];

        if (isYoutube) {
            args.push('--remote-components', 'ejs:github');
            args.push('--extractor-args', 'youtube:player_client=android,ios,web_embedded,mweb');
            const potScriptPath = '/opt/bgutil-ytdlp-pot-provider/server';
            if (fs.existsSync(potScriptPath)) {
                args.push('--plugin-dirs', '/app/yt-dlp-plugins');
                args.push('--extractor-args', `youtubepot-bgutilscript:script_path=${potScriptPath}`);
            }
        }
        args.push(url);

        console.log(`Spawning yt-dlp: ${ytdlpBinary} ${args.join(' ')}`);

        const child = spawn(ytdlpBinary, args);

        let stdoutData = '';
        let stderrData = '';

        child.stdout.on('data', (chunk) => {
            stdoutData += chunk;
        });

        child.stderr.on('data', (chunk) => {
            stderrData += chunk;
        });

        child.on('error', (err) => {
            console.error("Failed to spawn yt-dlp process:", err);
            reject(new Error(`Spawn error: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                try {
                    const parsed = JSON.parse(stdoutData);
                    resolve(parsed);
                } catch (parseErr) {
                    console.error("Failed to parse yt-dlp JSON output:", parseErr.message);
                    reject(new Error(`JSON parse error: ${parseErr.message}. Stderr: ${stderrData}`));
                }
            } else {
                console.error(`yt-dlp process exited with code ${code}`);
                reject(new Error(stderrData || `Exit code ${code}`));
            }
        });
    });
}

module.exports = { extractMetadata };
