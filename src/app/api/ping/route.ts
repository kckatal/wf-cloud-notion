export async function GET() {
  console.log('ping endpoint hit');
  return new Response('pong');
}


