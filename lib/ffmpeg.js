const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');

function getTempFilePath() {
    const filename = `temp_${crypto.randomBytes(16).toString('hex')}.mp4`;
    return path.join(os.tmpdir(), filename);
}

/**
 * Invokes ffmpeg to merge a video stream and an audio stream into a single MP4 file.
 * @param {string} videoUrl Direct URL to the video stream
 * @param {string} audioUrl Direct URL to the audio stream
 * @param {string} userAgent User Agent string
 * @returns {Promise<string>} Path to the generated temp file
 */
function mergeVideoAudio(videoUrl, audioUrl, userAgent) {
    return new Promise((resolve, reject) => {
        const ffmpegBinary = process.env.FFMPEG_PATH || 'ffmpeg';
        const tempFilePath = getTempFilePath();

        const args = [
            '-y',
            '-headers', `User-Agent: ${userAgent}\r\n`,
            '-i', videoUrl,
            '-headers', `User-Agent: ${userAgent}\r\n`,
            '-i', audioUrl,
            '-c', 'copy',
            '-f', 'mp4',
            tempFilePath
        ];

        console.log(`Spawning ffmpeg: ${ffmpegBinary} ${args.join(' ')}`);

        const child = spawn(ffmpegBinary, args);

        let stderrData = '';

        child.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        child.on('error', (err) => {
            console.error("Failed to spawn ffmpeg process:", err);
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            } catch (unlinkErr) {}
            reject(new Error(`Spawn error: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                console.log(`ffmpeg merge complete -> ${tempFilePath}`);
                resolve(tempFilePath);
            } else {
                console.error(`ffmpeg process exited with code ${code}`);
                console.error(`ffmpeg stderr:`, stderrData);
                try {
                    if (fs.existsSync(tempFilePath)) {
                        fs.unlinkSync(tempFilePath);
                    }
                } catch (unlinkErr) {}
                reject(new Error(stderrData || `Exit code ${code}`));
            }
        });
    });
}

/**
 * Downloads a video from a URL directly to a temporary MP4 file.
 * @param {string} url Direct URL to download
 * @param {string} userAgent User Agent string
 * @returns {Promise<string>} Path to the downloaded temp file
 */
async function downloadVideoToTempFile(url, userAgent) {
    const tempFilePath = getTempFilePath();
    const writer = fs.createWriteStream(tempFilePath);

    try {
        console.log(`Downloading stream to temp file: ${tempFilePath}`);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': userAgent
            }
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        return tempFilePath;
    } catch (err) {
        console.error("Failed to download video to temp file:", err.message);
        writer.close();
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (unlinkErr) {}
        throw err;
    }
}

module.exports = {
    mergeVideoAudio,
    downloadVideoToTempFile
};
