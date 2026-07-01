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
    const csrfMatch = cookieString.match(/csrftoken=([^;]+)/);
    const csrftoken = csrfMatch ? csrfMatch[1] : '';

    // GraphQL call
    const params = new URLSearchParams();
    params.set('doc_id', docId);
    params.set('variables', JSON.stringify({ shortcode }));

    const gqlResp = await fetch('https://www.instagram.com/api/graphql', {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
        'X-CSRFToken': csrftoken,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
      body: params.toString(),
    });

    const contentType = gqlResp.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const text = await gqlResp.text();
      return new Response(JSON.stringify({
        error: 'non_json_response',
        preview: text.slice(0, 300)
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await gqlResp.json();
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
