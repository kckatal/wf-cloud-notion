import { createHmac, timingSafeEqual } from 'crypto';
type NotionRichText = { plain_text?: string };
type NotionProperties = {
  Name: { title: NotionRichText[] };
  Slug?: { rich_text: NotionRichText[] };
  Content?: { rich_text: NotionRichText[] };
};
type NotionWebhookBody = {
  pageId?: string;
  properties?: NotionProperties;
  verification_token?: string;
  // Fields commonly present in Notion webhook envelopes (for logging/troubleshooting)
  id?: string;
  type?: string;
  entity?: unknown;
  data?: unknown;
};
type NotionData = { id: string; title?: string; slug?: string; content?: string };

type WebflowItem = { _id: string };
type WebflowListResponse = { items?: WebflowItem[] };

const NOTION_WEBHOOK_VERIFICATION_TOKEN = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN || '';

function calculateNotionSignature(rawBody: string, verificationToken: string): string {
  return `sha256=${createHmac('sha256', verificationToken).update(rawBody).digest('hex')}`;
}

function isValidSignature(rawBody: string, headerSignature: string | null, verificationToken: string): boolean {
  if (!headerSignature || !verificationToken) return false;
  const calc = calculateNotionSignature(rawBody, verificationToken);
  const a = Buffer.from(calc);
  const b = Buffer.from(headerSignature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  console.log('webhook POST invoked');
  const rawBody = await req.text();
  console.log('webhook raw body:', rawBody);
  const body = JSON.parse(rawBody) as NotionWebhookBody;
  console.log('webhook envelope summary:', {
    id: body?.id,
    type: body?.type,
    hasProperties: Boolean((body as any)?.properties),
  });

  const headerSignature = req.headers.get('x-notion-signature');

  // Handle initial subscription verification POST
  if (!headerSignature && body?.verification_token) {
    // If a token is configured, ensure it matches the incoming token
    if (NOTION_WEBHOOK_VERIFICATION_TOKEN && body.verification_token !== NOTION_WEBHOOK_VERIFICATION_TOKEN) {
      return new Response('Verification token mismatch', { status: 401 });
    }
    return new Response(JSON.stringify({ success: true }));
  }

  // For subsequent calls, validate signature
  if (!isValidSignature(rawBody, headerSignature, NOTION_WEBHOOK_VERIFICATION_TOKEN)) {
    return new Response('Invalid signature', { status: 401 });
  }

  const notionData = {
    id: body.pageId as string,
    title: body.properties?.Name.title[0]?.plain_text,
    slug: body.properties?.Slug?.rich_text[0]?.plain_text,
    content: body.properties?.Content?.rich_text[0]?.plain_text
  };
  console.log('derived notionData:', notionData);

  // Forward to Webflow
  if (!notionData.slug || !notionData.title) {
    console.log('webflow skip: missing required fields', {
      hasSlug: Boolean(notionData.slug),
      hasTitle: Boolean(notionData.title),
    });
  }

  const webflowResponse = await updateOrCreateWebflowItem(notionData);

  return new Response(JSON.stringify({ success: true, webflowResponse }));
}

const WEBFLOW_API_TOKEN = process.env.WEBFLOW_SITE_API_TOKEN;
const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

async function updateOrCreateWebflowItem(notionData: NotionData) {
  const { slug, title, content } = notionData;

  // First: Try to find existing item by slug (or a custom field)
  console.log('webflow find by slug start', { slug });
  const existing = (await fetch(
    `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?slug=${slug}`,
    {
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  ).then(async res => {
    const json = await res.json().catch(() => ({}));
    console.log('webflow find by slug result', { status: res.status, ok: res.ok, json });
    return json;
  })) as WebflowListResponse;

  if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
    const itemId = existing.items[0]._id;

    // Update item
    console.log('webflow update start', { itemId, title, slug, hasContent: Boolean(content) });
    return await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        isArchived: false,
        isDraft: false,
        fieldData: {
          name: title,
          slug,
          content
        }
      })
    }).then(async res => {
      const json = await res.json().catch(() => ({}));
      console.log('webflow update result', { status: res.status, ok: res.ok, json });
      return json;
    });
  }

  // Create new item
  console.log('webflow create start', { title, slug, hasContent: Boolean(content) });
  return await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      isArchived: false,
      isDraft: false,
      fieldData: {
        name: title,
        slug,
        content
      }
    })
  }).then(async res => {
    const json = await res.json().catch(() => ({}));
    console.log('webflow create result', { status: res.status, ok: res.ok, json });
    return json;
  });
}