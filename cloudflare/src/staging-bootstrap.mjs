// Closed bootstrap only. No D1, login, case data, model calls, or assets.
export default {
  async fetch() {
    return new Response('Feedback Desk staging is not available.\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
    });
  },
};
