export const GET = () => new Response('{"ok":true}', {
  status: 201,
  headers: { 'Content-Type': 'application/json', 'X-Fixture': 'json', 'Set-Cookie': 'json=yes; Path=/' },
});
