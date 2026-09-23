// Runtime modules remain available to serverless functions, but are not a
// public static website. Match only internal paths: customer pages, assets,
// authenticated APIs and release downloads do not invoke this middleware.
export const config = {
  matcher: [
    '/lib/:path*', '/tools/:path*', '/scripts/:path*', '/services/:path*',
    '/supabase/:path*', '/test/:path*', '/tests/:path*', '/docs/:path*', '/ops/:path*',
    '/artifacts/:path*', '/installer/:path*',
    '/middleware.js',
    '/:filename([^/]+\\.md)', '/:filename([^/]+\\.sql)',
    '/:filename([^/]+\\.tar\\.gz)', '/:filename([^/]+\\.tgz)',
    '/:filename([^/]+\\.headers)',
    '/SECURITY_HARDENING_DEPLOYMENT_MANIFEST_20260823.json', '/SOURCE_FILE_SHA256SUMS.txt'
  ]
};

export default function middleware() {
  return new Response('Not Found', {
    status: 404,
    headers: {'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
  });
}
