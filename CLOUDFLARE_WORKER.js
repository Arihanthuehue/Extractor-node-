export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.json();
    const { bootstrapUrl, docId, shortcode } = body;

    const baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'X-IG-App-ID': '936619743392459',
      'X-FB-LSD': 'AVqbxe3J_YA',
      'X-ASBD-ID': '129477',
      'Origin': 'https://www.instagram.com',
      'Referer': 'https://www.instagram.com/',
    };

    // Bootstrap cookies from the actual content page
    const bootstrapResp = await fetch(bootstrapUrl, { headers: baseHeaders });
    const rawSetCookie = bootstrapResp.headers.get('set-cookie') || '';
    const cookiePairs = rawSetCookie
      .split(/,(?=[^ ].*?=)/)
      .map(c => c.trim().split(';')[0].trim())
      .filter(c => c.includes('='));
    const cookieString = cookiePairs.join('; ');
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    const resp = await fetch(embedUrl, { headers: baseHeaders });
    const html = await resp.text();
    const match = html.match(/"video_url":"(https:\/\/[^"]+)"/);
    const videoUrl = match ? match[1].replace(/\\/g, '') : null;
    if (!videoUrl) {
      return new Response(JSON.stringify({ error: 'video_url_not_found', preview: html.slice(0, 300) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ videoUrl }), { headers: { 'Content-Type': 'application/json' } });
  }
};
