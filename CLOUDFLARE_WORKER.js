export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const { shortcode } = await request.json();
    if (!shortcode) {
      return new Response(JSON.stringify({ error: 'missing_shortcode' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    const resp = await fetch(embedUrl, { headers });
    const html = await resp.text();
    const match = html.match(/"video_url":"(https:\/\/[^"]+)"/);
    if (!match) {
      return new Response(JSON.stringify({ error: 'video_url_not_found', preview: html.slice(0, 500) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const videoUrl = match[1].replace(/\\/g, '');
    return new Response(JSON.stringify({ videoUrl }), { headers: { 'Content-Type': 'application/json' } });
  }
};
