function mapInstagramError(stderr) {
    const msg = (stderr || "").toLowerCase();
    if (
        msg.includes("private") ||
        msg.includes("login") ||
        msg.includes("empty media response") ||
        msg.includes("log in") ||
        msg.includes("sign in")
    ) {
        return "private_post";
    } else if (msg.includes("unsupported url") || msg.includes("invalid")) {
        return "invalid_url";
    } else {
        return "resolve_failed";
    }
}

function mapYoutubeError(stderr) {
    const msg = (stderr || "").toLowerCase();
    if (msg.includes("sign in to confirm") || msg.includes("not a bot")) {
        return "youtube_blocked";
    } else if (msg.includes("private video") || msg.includes("members-only")) {
        return "private_post";
    } else {
        return "resolve_failed";
    }
}

module.exports = {
    mapInstagramError,
    mapYoutubeError
};
